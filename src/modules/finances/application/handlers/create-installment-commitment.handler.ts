import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { QueryFailedError } from 'typeorm';
import {
    UNIT_OF_WORK,
    type UnitOfWork,
} from '../../../../shared/application/unit-of-work.js';
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
import { FinancesError } from '../../domain/errors/finances.error.js';
import {
    InstallmentCommitment,
    type InstallmentParticipation,
} from '../../domain/installment/installment-commitment.js';
import {
    Installment,
    InstallmentPlan,
    createInstallmentSchedule,
} from '../../domain/installment/installment-plan.js';
import { ResponsibilitySplit } from '../../domain/shared-expense/responsibility-split.js';
import type { InstallmentCommitmentDto } from '../../http/dto/installment-commitment.dto.js';
import {
    DEFAULT_SETTLEMENT_RULE_REPOSITORY,
    type DefaultSettlementRuleRepository,
} from '../ports/private/default-settlement-rule.repository.js';
import {
    INSTALLMENT_COMMITMENT_REPOSITORY,
    type InstallmentCommitmentRepository,
} from '../ports/private/installment-commitment.repository.js';
import {
    FINANCES_CLOCK,
    type FinancesClock,
} from '../ports/private/shared-expense.repositories.js';
import { digest, type Create } from './installment-commitment.commands.js';
import { rootView } from './installment-commitment.models.js';
@Injectable()
export class CreateInstallmentCommitmentHandler {
    constructor(
        @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
        @Inject(SPACE_ACCESS_PORT) private readonly access: SpaceAccessPort,
        @Inject(SPACE_FINANCIAL_CONTEXT_PORT)
        private readonly context: SpaceFinancialContextPort,
        @Inject(DEFAULT_SETTLEMENT_RULE_REPOSITORY)
        private readonly rules: DefaultSettlementRuleRepository,
        @Inject(INSTALLMENT_COMMITMENT_REPOSITORY)
        private readonly repository: InstallmentCommitmentRepository,
        @Inject(FINANCES_CLOCK) private readonly clock: FinancesClock,
    ) {}

    private schedule(input: InstallmentCommitmentDto) {
        return createInstallmentSchedule(input);
    }

    private async participation(
        input: InstallmentCommitmentDto,
        actorId: PersonId,
        spaceId: SpaceId,
        locked: boolean,
    ) {
        if (input.scope === 'PERSONAL')
            return {
                participation: {
                    type: 'PERSONAL' as const,
                    ownerPersonId: actorId.value,
                },
                expectedSpaceVersion: null,
            };
        const context = locked
            ? await this.context.lockForWrite(actorId, spaceId)
            : await this.context.read(actorId, spaceId);
        if (locked && context.version !== input.expectedSpaceVersion)
            throw new FinancesError('EXPENSE_OPTIONS_CHANGED');
        if (locked && input.expectedRuleVersion === undefined)
            throw new FinancesError('VALIDATION_ERROR', [
                'expectedRuleVersion',
            ]);
        const ids = context.members.map((member) => member.memberId);
        if (
            input.distribution.shares.length !== ids.length ||
            input.distribution.shares.some(
                (share) => !ids.includes(share.memberId),
            ) ||
            (input.expectedMemberId && !ids.includes(input.expectedMemberId))
        )
            throw new FinancesError('VALIDATION_ERROR', ['distribution']);
        const schedule = this.schedule(input);
        const total = schedule.reduce(
            (sum, item) => sum + item.amountInCents,
            0,
        );
        ResponsibilitySplit.create(total, ids, input.distribution);
        const rule = await this.rules.find(spaceId.value);
        if (
            locked &&
            rule?.version !== input.expectedRuleVersion &&
            !(rule === null && input.expectedRuleVersion === 0)
        )
            throw new FinancesError('EXPENSE_OPTIONS_CHANGED');
        const participation: InstallmentParticipation = {
            type: 'SHARED',
            distribution: input.distribution,
            expectedMemberId: input.expectedMemberId ?? null,
            settlementRuleSnapshot: rule?.rule.snapshot ?? null,
            settlementRuleSourceVersion: rule?.version ?? 0,
        };
        return { participation, expectedSpaceVersion: context.version };
    }

    async preview(
        actorId: PersonId,
        spaceId: SpaceId,
        input: InstallmentCommitmentDto,
    ) {
        const access = await this.access.assertCanRead(actorId, spaceId);
        if (access.type !== input.scope)
            throw new FinancesError(
                input.scope === 'PERSONAL'
                    ? 'PERSONAL_SPACE_REQUIRED'
                    : 'SHARED_SPACE_REQUIRED',
            );
        const { participation, expectedSpaceVersion } =
            await this.participation(input, actorId, spaceId, false);
        const schedule = this.schedule(input);
        const id = randomUUID();
        const root = new InstallmentCommitment(
            id,
            spaceId.value,
            input.description,
            actorId.value,
            this.clock.now().toISOString(),
            1,
            new InstallmentPlan(
                randomUUID(),
                id,
                spaceId.value,
                schedule.map(
                    (entry) =>
                        new Installment(
                            randomUUID(),
                            entry.position,
                            entry.dueDate,
                            entry.amountInCents,
                        ),
                ),
            ),
            participation,
            input.cadence ?? 'EXPLICIT',
            input.plannedPaymentMethod ?? null,
        );
        await this.access.assertCanRead(actorId, spaceId);
        return {
            scope: input.scope,
            description: input.description,
            count: root.plan.count,
            cadence: root.cadence,
            plannedPaymentMethod: root.plannedPaymentMethod,
            totalAmountInCents: root.plan.totalAmountInCents,
            installments: root.plan.installments.map((item) => ({
                position: item.position,
                dueDate: item.dueDate,
                amountInCents: item.amountInCents,
                economicShares: root.sharesFor(item.position),
            })),
            ...(participation.type === 'SHARED'
                ? {
                      distribution: participation.distribution,
                      expectedMemberId: participation.expectedMemberId,
                      settlementRuleSnapshot:
                          participation.settlementRuleSnapshot,
                      settlementRuleSourceVersion:
                          participation.settlementRuleSourceVersion,
                      expectedSpaceVersion,
                      expectedRuleVersion:
                          participation.settlementRuleSourceVersion,
                  }
                : { ownerPersonId: actorId.value }),
        };
    }

    async create(c: Create) {
        const operation = 'CREATE_INSTALLMENT_COMMITMENT';
        const hash = digest(operation, c.spaceId.value, {
            ...c,
            actorId: undefined,
            spaceId: undefined,
            idempotencyKey: undefined,
        });
        const execute = () =>
            this.uow.execute(async () => {
                const access = await this.access.assertCanRead(
                    c.actorId,
                    c.spaceId,
                );
                const prior = await this.repository.findReceipt(
                    c.actorId.value,
                    operation,
                    c.idempotencyKey,
                    hash,
                );
                if (prior) return { ...(prior as object), replayed: true };
                if (access.type !== c.scope)
                    throw new FinancesError(
                        c.scope === 'PERSONAL'
                            ? 'PERSONAL_SPACE_REQUIRED'
                            : 'SHARED_SPACE_REQUIRED',
                    );
                if (c.scope === 'PERSONAL')
                    await this.access.assertCanWrite(c.actorId, c.spaceId);
                const { participation } = await this.participation(
                    c,
                    c.actorId,
                    c.spaceId,
                    true,
                );
                const schedule = this.schedule(c);
                const now = this.clock.now().toISOString();
                const id = randomUUID();
                const root = new InstallmentCommitment(
                    id,
                    c.spaceId.value,
                    c.description,
                    c.actorId.value,
                    now,
                    1,
                    new InstallmentPlan(
                        randomUUID(),
                        id,
                        c.spaceId.value,
                        schedule.map(
                            (entry) =>
                                new Installment(
                                    randomUUID(),
                                    entry.position,
                                    entry.dueDate,
                                    entry.amountInCents,
                                ),
                        ),
                    ),
                    participation,
                    c.cadence ?? 'EXPLICIT',
                    c.plannedPaymentMethod ?? null,
                );
                await this.repository.save(root);
                const result = { commitment: rootView(root), replayed: false };
                await this.repository.saveReceipt(
                    c.actorId.value,
                    c.spaceId.value,
                    id,
                    null,
                    operation,
                    c.idempotencyKey,
                    hash,
                    result,
                    now,
                );
                return result;
            });
        try {
            return await execute();
        } catch (error) {
            if (
                !(error instanceof QueryFailedError) ||
                error.driverError.code !== '23505'
            )
                throw error;
            return this.uow.execute(async () => {
                await this.access.assertCanRead(c.actorId, c.spaceId);
                const prior = await this.repository.findReceipt(
                    c.actorId.value,
                    operation,
                    c.idempotencyKey,
                    hash,
                );
                if (!prior) throw error;
                return { ...(prior as object), replayed: true };
            });
        }
    }
}
