import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
    SPACE_ACCESS_PORT,
    type SpaceAccessPort,
} from '../../../spaces/application/ports/public/space-access.port.js';
import {
    SPACE_FINANCIAL_CONTEXT_PORT,
    type SpaceFinancialContextPort,
} from '../../../spaces/application/ports/public/space-financial-context.port.js';
import type { PersonId } from '../../../spaces/domain/person/person-id.js';
import type { SpaceId } from '../../../spaces/domain/space/space-id.js';
import {
    FinancesError,
    type FinancesErrorCode,
} from '../../domain/errors/finances.error.js';
import {
    validateFinancialReversal,
    type FinancialFulfillmentReversal,
} from '../../domain/reversals/financial-fulfillment-reversal.js';
import type {
    FinancialReversalDto,
    FinancialReversalListDto,
} from '../../http/dto/financial-reversal.dto.js';
import { uuid } from '../../http/dto/record-shared-cash-expense.dto.js';
import {
    FINANCIAL_FULFILLMENT_REVERSAL_REPOSITORY,
    type FinancialFulfillmentReversalRepository,
} from '../ports/private/financial-fulfillment-reversal.repository.js';
import {
    FINANCIAL_CHANGE_REPOSITORY,
    type FinancialChangeRepository,
} from '../ports/private/financial-change.repository.js';
import {
    FINANCES_CLOCK,
    type FinancesClock,
} from '../ports/private/shared-expense.repositories.js';
import {
    FinancialIntegrityCommands,
    type FinancialIntegrityCommand,
} from './financial-integrity-commands.js';
import { financialCorrectionOrigin } from './financial-correction-origin.js';
import { ReconcileFinancialOrigin } from './reconcile-financial-origin.js';

@Injectable()
export class FinancialFulfillmentReversals {
    constructor(
        private readonly commands: FinancialIntegrityCommands,
        @Inject(SPACE_ACCESS_PORT) private readonly access: SpaceAccessPort,
        @Inject(SPACE_FINANCIAL_CONTEXT_PORT)
        private readonly contexts: SpaceFinancialContextPort,
        @Inject(FINANCIAL_FULFILLMENT_REVERSAL_REPOSITORY)
        private readonly repository: FinancialFulfillmentReversalRepository,
        @Inject(FINANCIAL_CHANGE_REPOSITORY)
        private readonly origins: FinancialChangeRepository,
        @Inject(FINANCES_CLOCK) private readonly clock: FinancesClock,
        private readonly reconcile: ReconcileFinancialOrigin,
    ) {}
    preview(
        actor: PersonId,
        space: SpaceId,
        id: string,
        input: FinancialReversalDto,
    ) {
        return this.repository.snapshot(async () => {
            const { preview } = await this.assess(actor, space, id, input);
            await this.access.assertCanRead(actor, space);
            return preview;
        });
    }
    confirm(command: FinancialIntegrityCommand, input: FinancialReversalDto) {
        return this.commands.execute(
            'REVERSE_FINANCIAL_FULFILLMENT',
            command,
            input,
            async (_origin, _context, now) => {
                const { state, preview } = await this.assess(
                    command.actorId,
                    command.spaceId,
                    command.commitmentId,
                    input,
                    true,
                );
                if (!preview.eligible)
                    throw new FinancesError(preview.blockingReason!);
                const reversal: FinancialFulfillmentReversal = {
                    id: randomUUID(),
                    spaceId: state.origin.spaceId,
                    commitmentId: state.origin.id,
                    targetId: state.origin.targetId,
                    occurrenceId: state.original.occurrenceId,
                    installmentId: state.original.installmentId,
                    commitmentVersion: state.origin.version + 1,
                    originalKind: input.originalKind,
                    originalId: input.originalId,
                    amountInCents: input.amountInCents,
                    reason: input.reason,
                    factDate: input.factDate,
                    actorId: command.actorId.value,
                    registeredAt: now,
                };
                await this.repository.reverse(state, reversal);
                if (
                    !state.origin.personal &&
                    state.original.kind !== 'EXTERNAL_SETTLEMENT'
                ) {
                    const target = state.globalPayoff
                        ? {}
                        : state.original.installmentId
                          ? { installmentId: state.original.installmentId }
                          : state.original.occurrenceId
                            ? { occurrenceId: state.original.occurrenceId }
                            : {};
                    const corrected = await this.repository.loadOrigin(
                        state.origin.spaceId,
                        state.origin.id,
                        target,
                        now,
                    );
                    await this.reconcile.execute(
                        financialCorrectionOrigin(
                            corrected,
                            this.clock.today(),
                        ),
                        input.settlement ?? { mode: 'NONE' },
                        command.actorId.value,
                        this.clock.today(),
                        now,
                        state.original.occurrenceId,
                        {
                            id: reversal.id,
                            factDate: reversal.factDate,
                            kind: 'REVERSAL',
                            preserveSettlementEffects: true,
                            originalFact: {
                                id: state.original.id,
                                kind: state.original.kind,
                                factDate: state.original.factDate,
                            },
                        },
                    );
                }
                return {
                    ...preview,
                    reversal,
                    version: state.origin.version + 1,
                };
            },
            'CORRECTION',
        );
    }
    private async assess(
        actor: PersonId,
        space: SpaceId,
        id: string,
        input: FinancialReversalDto,
        lock = false,
    ) {
        const access = await this.access.assertCanRead(actor, space);
        const context =
            access.type === 'SHARED'
                ? lock
                    ? await this.contexts.lockForFulfillment(actor, space)
                    : await this.contexts.read(actor, space)
                : null;
        if (lock && !context) await this.access.assertCanWrite(actor, space);
        if ((context !== null) !== (input.expectedSpaceVersion !== undefined))
            throw new FinancesError('VALIDATION_ERROR', [
                'expectedSpaceVersion',
            ]);
        if (context && context.version !== input.expectedSpaceVersion)
            throw new FinancesError('EXPENSE_OPTIONS_CHANGED');
        if (input.factDate > this.clock.today())
            throw new FinancesError('VALIDATION_ERROR', ['factDate']);
        if (
            input.settlement?.mode === 'DATE' &&
            input.settlement.targetDate < this.clock.today()
        )
            throw new FinancesError('VALIDATION_ERROR', [
                'settlement.targetDate',
            ]);
        const state = await this.repository.read(
            space.value,
            id,
            input,
            this.clock.now().toISOString(),
            lock,
        );
        if (!state) throw new FinancesError('FINANCIAL_REVERSAL_NOT_FOUND');
        if (state.origin.version !== input.expectedCommitmentVersion)
            throw new FinancesError('CONCURRENT_MODIFICATION');
        const hasOccurrence = state.original.occurrenceId !== null;
        if (hasOccurrence !== (input.expectedOccurrenceVersion !== undefined))
            throw new FinancesError('VALIDATION_ERROR', [
                'expectedOccurrenceVersion',
            ]);
        if (
            hasOccurrence &&
            state.origin.occurrenceVersion !== input.expectedOccurrenceVersion
        )
            throw new FinancesError('CONCURRENT_MODIFICATION');
        if (input.factDate < state.original.factDate)
            throw new FinancesError('VALIDATION_ERROR', ['factDate']);
        if (state.original.kind === 'EXTERNAL_SETTLEMENT') {
            if (
                context
                    ? state.original.memberId !== context.actorMemberId
                    : state.original.personId !== actor.value
            )
                throw new FinancesError('EXTERNAL_LIABILITY_HOLDER_REQUIRED');
            if (input.settlement && input.settlement.mode !== 'NONE')
                throw new FinancesError('VALIDATION_ERROR', ['settlement']);
        }
        let blockingReason: FinancesErrorCode | null = null;
        try {
            validateFinancialReversal(state, input.amountInCents);
        } catch (error) {
            if (
                !(error instanceof FinancesError) ||
                ![
                    'FINANCIAL_REVERSAL_EXCEEDS_AVAILABLE',
                    'FINANCIAL_REVERSAL_SETTLEMENT_REQUIRED',
                    'FINANCIAL_REVERSAL_FULL_REQUIRED',
                ].includes(error.code)
            )
                throw error;
            blockingReason = error.code;
        }
        const affectsRealization =
            state.original.kind !== 'EXTERNAL_SETTLEMENT';
        const fulfilled =
            state.origin.fulfilledAmountInCents -
            (affectsRealization ? input.amountInCents : 0);
        const cash =
            state.original.kind === 'DISBURSEMENT' ||
            state.original.kind === 'EXTERNAL_SETTLEMENT'
                ? input.amountInCents
                : state.original.kind === 'RECEIPT'
                  ? -input.amountInCents
                  : 0;
        const supported =
            state.original.kind === 'DISBURSEMENT' ||
            state.original.kind === 'EXTERNAL_LIABILITY'
                ? -input.amountInCents
                : 0;
        const external =
            state.original.kind === 'EXTERNAL_SETTLEMENT'
                ? input.amountInCents
                : state.original.kind === 'EXTERNAL_LIABILITY'
                  ? -input.amountInCents
                  : 0;
        let reconciliation: Awaited<
            ReturnType<ReconcileFinancialOrigin['preview']>
        > | null = null;
        if (!blockingReason && !state.origin.personal && affectsRealization) {
            const facts = state.origin.facts
                .map((fact) =>
                    fact.id === state.original.id
                        ? {
                              ...fact,
                              amountInCents:
                                  fact.amountInCents - input.amountInCents,
                          }
                        : fact,
                )
                .filter((fact) => fact.amountInCents > 0);
            reconciliation = await this.reconcile.preview(
                financialCorrectionOrigin(
                    {
                        ...state.origin,
                        facts,
                        fulfilledAmountInCents: fulfilled,
                    },
                    this.clock.today(),
                ),
                state.original.occurrenceId,
                input.settlement ?? { mode: 'NONE' },
                this.clock.today(),
            );
            if (reconciliation.blockingReason)
                blockingReason = reconciliation.blockingReason;
        }
        return {
            state,
            preview: {
                commitmentId: id,
                currentVersion: state.origin.version,
                target: {
                    type: state.globalPayoff
                        ? 'GLOBAL_PAYOFF'
                        : state.origin.modality === 'ONE_TIME'
                          ? 'COMMITMENT'
                          : state.origin.modality === 'RECURRING'
                            ? 'OCCURRENCE'
                            : 'INSTALLMENT',
                    id: state.origin.targetId,
                    occurrenceId: state.original.occurrenceId,
                    installmentId: state.original.installmentId,
                    referenceDate: state.origin.referenceDate,
                },
                expectedOccurrenceVersion: hasOccurrence
                    ? state.origin.occurrenceVersion
                    : undefined,
                original: {
                    ...state.original,
                    reversedAmountInCents:
                        state.original.amountInCents -
                        state.reversibleAmountInCents,
                    reversibleAmountInCents: state.reversibleAmountInCents,
                },
                previousReversals: state.reversals,
                amountInCents: input.amountInCents,
                resultingFulfilledAmountInCents: blockingReason
                    ? null
                    : fulfilled,
                resultingRemainingAmountInCents:
                    blockingReason || state.origin.amountInCents === null
                        ? null
                        : state.origin.amountInCents - fulfilled,
                cashImpactInCents: cash.toString(),
                supportedImpactInCents: supported.toString(),
                externalOutstandingImpactInCents: external.toString(),
                eligible: blockingReason === null,
                blockingReason,
                requiresFullReversal:
                    state.globalPayoff !== null ||
                    !!state.blockingGlobalPayoffId,
                blockingGlobalPayoffId: state.blockingGlobalPayoffId ?? null,
                reconciliation,
            },
        };
    }
    async list(
        actor: PersonId,
        space: SpaceId,
        id: string,
        input: FinancialReversalListDto,
    ) {
        await this.access.assertCanRead(actor, space);
        const scope = JSON.stringify([actor.value, space.value, id]);
        let after: string | null = null;
        if (input.cursor !== undefined) {
            try {
                if (!/^[A-Za-z0-9_-]+$/.test(input.cursor)) throw new Error();
                const cursor: unknown = JSON.parse(
                    Buffer.from(input.cursor, 'base64url').toString('utf8'),
                );
                if (
                    !Array.isArray(cursor) ||
                    cursor.length !== 3 ||
                    cursor[0] !== 1 ||
                    cursor[1] !== scope ||
                    !uuid.safeParse(cursor[2]).success
                )
                    throw new Error();
                after = cursor[2] as string;
                if (
                    Buffer.from(JSON.stringify(cursor)).toString(
                        'base64url',
                    ) !== input.cursor
                )
                    throw new Error();
            } catch {
                throw new FinancesError('VALIDATION_ERROR', ['cursor']);
            }
        }
        const result = await this.repository.snapshot(async () => {
            if (!(await this.origins.origin(space.value, id)))
                throw new FinancesError('FINANCIAL_COMMITMENT_NOT_FOUND');
            return this.repository.list(space.value, id, after);
        });
        await this.access.assertCanRead(actor, space);
        const items = result.items.slice(0, 20);
        return {
            items,
            totalCount: result.totalCount,
            nextCursor:
                result.items.length > 20
                    ? Buffer.from(
                          JSON.stringify([1, scope, items.at(-1)!.id]),
                      ).toString('base64url')
                    : null,
        };
    }
}
