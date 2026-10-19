import { Inject, Injectable } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import {
    UNIT_OF_WORK,
    type UnitOfWork,
} from '../../../../../shared/application/unit-of-work.js';
import { EntityManagerProvider } from '../../../../../shared/technical/database/typeorm/entity-manager.provider.js';
import {
    SPACE_CLOSURE_PORT,
    type SpaceClosurePort,
} from '../../../../spaces/application/ports/public/space-closure.port.js';
import {
    SPACE_FINANCIAL_CONTEXT_PORT,
    type SpaceFinancialContext,
    type SpaceFinancialContextPort,
} from '../../../../spaces/application/ports/public/space-financial-context.port.js';
import {
    GET_PERSONAL_CONTEXT,
    type GetPersonalContext,
} from '../../../../spaces/application/ports/public/get-personal-context.js';
import { PersonId } from '../../../../spaces/domain/person/person-id.js';
import { SpaceId } from '../../../../spaces/domain/space/space-id.js';
import type {
    FinancialClosureApplication,
    FinancialClosureDestination,
    FinancialClosureDestinationInput,
    FinancialClosureDestinationsPort,
    FinancialClosureFutureItem,
    FinancialClosureRecurringImpact,
} from '../../../application/ports/public/financial-closure-destinations.port.js';
import {
    RECURRING_COMMITMENT_REPOSITORY,
    type RecurringCommitmentRepository,
} from '../../../application/ports/private/recurring-commitment.repository.js';
import {
    INSTALLMENT_COMMITMENT_REPOSITORY,
    type InstallmentCommitmentRepository,
} from '../../../application/ports/private/installment-commitment.repository.js';
import {
    INTER_MEMBER_OBLIGATION_REPOSITORY,
    type InterMemberObligationRepository,
} from '../../../application/ports/private/shared-expense.repositories.js';
import { FinancesError } from '../../../domain/errors/finances.error.js';
import { RecurringCommitment } from '../../../domain/recurrence/recurring-commitment.js';
import { RecurrenceRule } from '../../../domain/recurrence/recurrence-rule.js';
import { InstallmentCommitment } from '../../../domain/installment/installment-commitment.js';
import {
    Installment,
    InstallmentPlan,
} from '../../../domain/installment/installment-plan.js';
import { InterMemberObligation } from '../../../domain/shared-expense/inter-member-obligation.js';
import { civilDate } from '../../../domain/shared-expense/settlement-cycle.js';
import { FinancialOccurrenceOrmEntity } from '../entities/recurrence.orm-entity.js';
import { FinancialCommitmentOrmEntity } from '../entities/shared-expense.orm-entity.js';
import { FinancialClosureEffectOrmEntity } from '../entities/financial-closure-effect.orm-entity.js';
import { nonRecurringReadQuery } from '../queries/non-recurring-version-selection.js';
import { recordFinancialCommandAudit } from './record-financial-command-audit.js';

type FutureItem = FinancialClosureFutureItem & { fulfilledInCents: number };
type Inspected = {
    root: RecurringCommitment | InstallmentCommitment;
    items: FutureItem[];
    versions: { effectiveFrom: string; configuration: RecurringCommitment }[];
    fingerprint: string;
};

function digest(value: unknown) {
    const canonical = (input: unknown): unknown =>
        input instanceof Date
            ? input.toISOString()
            : Array.isArray(input)
              ? input.map(canonical)
              : input && typeof input === 'object'
                ? Object.fromEntries(
                      Object.entries(input)
                          .sort(([a], [b]) => a.localeCompare(b))
                          .map(([key, item]) => [key, canonical(item)]),
                  )
                : input;
    return createHash('sha256')
        .update(JSON.stringify(canonical(value)))
        .digest('hex');
}

function dayBefore(date: string) {
    const previous = new Date(`${date}T00:00:00Z`);
    previous.setUTCDate(previous.getUTCDate() - 1);
    return civilDate(previous.toISOString().slice(0, 10));
}

@Injectable()
export class TypeOrmFinancialClosureDestinations implements FinancialClosureDestinationsPort {
    constructor(
        private readonly managers: EntityManagerProvider,
        @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
        @Inject(SPACE_CLOSURE_PORT) private readonly closures: SpaceClosurePort,
        @Inject(SPACE_FINANCIAL_CONTEXT_PORT)
        private readonly contexts: SpaceFinancialContextPort,
        @Inject(GET_PERSONAL_CONTEXT)
        private readonly personalContexts: GetPersonalContext,
        @Inject(RECURRING_COMMITMENT_REPOSITORY)
        private readonly recurring: RecurringCommitmentRepository,
        @Inject(INSTALLMENT_COMMITMENT_REPOSITORY)
        private readonly installments: InstallmentCommitmentRepository,
        @Inject(INTER_MEMBER_OBLIGATION_REPOSITORY)
        private readonly obligations: InterMemberObligationRepository,
    ) {}

    async preview(
        actorId: string,
        spaceId: string,
        cutoffDate: string,
        input: FinancialClosureDestinationInput,
    ): Promise<FinancialClosureDestination> {
        civilDate(cutoffDate);
        return this.managers.readSnapshot(async () => {
            const context = await this.contexts.read(
                PersonId.from(actorId),
                SpaceId.from(spaceId),
            );
            if (context.status !== 'CLOSING')
                throw new FinancesError('FINANCIAL_CLOSURE_PLAN_NOT_APPROVED');
            const existing = await this.managers
                .get()
                .findOneBy(FinancialClosureEffectOrmEntity, {
                    spaceId,
                    originId: input.originId,
                });
            if (existing)
                throw new FinancesError(
                    'FINANCIAL_CLOSURE_DESTINATION_APPLIED',
                );
            const inspected = await this.inspect(spaceId, cutoffDate, input);
            return this.snapshot(context, cutoffDate, input, inspected);
        });
    }

    private async inspect(
        spaceId: string,
        cutoffDate: string,
        input: FinancialClosureDestinationInput,
        lock = false,
    ): Promise<Inspected> {
        const root =
            input.originType === 'RECURRING'
                ? await this.recurring.find(spaceId, input.originId, lock)
                : await this.installments.find(spaceId, input.originId, lock);
        if (!root || root.participation.type !== 'SHARED')
            throw new FinancesError('FINANCIAL_COMMITMENT_NOT_FOUND');
        if (root.version !== input.expectedOriginVersion)
            throw new FinancesError('FINANCIAL_CLOSURE_ORIGIN_CHANGED');
        let items: FutureItem[];
        let versions: Inspected['versions'] = [];
        if (root instanceof InstallmentCommitment) {
            items = root.plan.installments
                .filter(
                    (item) =>
                        item.dueDate >= cutoffDate &&
                        item.remainingAmountInCents > 0,
                )
                .map((item) => ({
                    originItemId: item.id,
                    referenceDate: item.dueDate,
                    remainingInCents: item.remainingAmountInCents,
                    fulfilledInCents: item.fulfilledAmountInCents,
                    version: item.stateVersion,
                }));
        } else {
            const rows = await nonRecurringReadQuery<
                {
                    id: string;
                    reference_date: string;
                    state_version: number;
                    amount: string | null;
                    fulfilled: string;
                }[]
            >(
                this.managers.get(),
                `SELECT o.id,o.reference_date::text,o.state_version,o.amount_in_cents::text AS amount,
                CASE WHEN c.kind='INCOME' THEN COALESCE((SELECT SUM(f.amount_in_cents) FROM financial_receipts f WHERE f.space_id=o.space_id AND f.occurrence_id=o.id),0)
                ELSE COALESCE((SELECT SUM(f.amount_in_cents) FROM financial_disbursements f WHERE f.space_id=o.space_id AND f.occurrence_id=o.id),0)
                    +COALESCE((SELECT SUM(f.amount_in_cents) FROM financial_external_liabilities f WHERE f.space_id=o.space_id AND f.occurrence_id=o.id),0) END::text AS fulfilled
                FROM financial_occurrences o JOIN financial_commitments c ON c.space_id=o.space_id AND c.id=o.commitment_id
                WHERE o.space_id=$1 AND o.commitment_id=$2 AND o.reference_date>=$3::date AND o.status<>'CANCELLED' ORDER BY o.reference_date,o.id`,
                [spaceId, root.id, cutoffDate],
                cutoffDate,
            );
            items = rows
                .filter(
                    (row) =>
                        row.amount === null ||
                        BigInt(row.amount) > BigInt(row.fulfilled),
                )
                .map((row) => ({
                    originItemId: row.id,
                    referenceDate: row.reference_date,
                    remainingInCents:
                        row.amount === null
                            ? null
                            : Number(
                                  BigInt(row.amount) - BigInt(row.fulfilled),
                              ),
                    fulfilledInCents: Number(row.fulfilled),
                    version: row.state_version,
                }));
            const configurations = root.versions.length
                ? root.versions
                : [{ effectiveFrom: root.effectiveFrom, configuration: root }];
            versions = configurations.filter((entry, index) => {
                const from = [
                    cutoffDate,
                    entry.effectiveFrom,
                    entry.configuration.rule.startsOn,
                ]
                    .sort()
                    .at(-1)!;
                const next = entry.configuration.rule.firstOnOrAfter(from);
                return (
                    next !== null &&
                    (!root.terminatedOn || next <= root.terminatedOn) &&
                    (!configurations[index + 1] ||
                        next < configurations[index + 1].effectiveFrom)
                );
            });
            for (const entry of versions) {
                const date = entry.configuration.rule.firstOnOrAfter(
                    [cutoffDate, entry.effectiveFrom].sort().at(-1)!,
                )!;
                if (
                    !rows.some(
                        (row) =>
                            row.reference_date.slice(0, 7) === date.slice(0, 7),
                    )
                )
                    items.push({
                        originItemId: null,
                        referenceDate: date,
                        remainingInCents:
                            entry.configuration.valueMode === 'FIXED'
                                ? entry.configuration.amountInCents
                                : null,
                        fulfilledInCents: 0,
                        version: null,
                    });
            }
            items.sort((a, b) =>
                a.referenceDate.localeCompare(b.referenceDate),
            );
        }
        if (items.length === 0 && versions.length === 0)
            throw new FinancesError('FINANCIAL_CLOSURE_FUTURE_NOT_FOUND');
        return {
            root,
            items,
            versions,
            fingerprint: digest({ root, items, versions }),
        };
    }

    private snapshot(
        context: SpaceFinancialContext,
        cutoffDate: string,
        input: FinancialClosureDestinationInput,
        source: Inspected,
    ): FinancialClosureDestination {
        const assignee = input.assigneeMemberId ?? null;
        const amount = input.amountInCents ?? null;
        if (input.destination === 'TERMINATE') {
            if (assignee !== null || amount !== null)
                throw new FinancesError('VALIDATION_ERROR', ['destination']);
        } else if (
            !context.members.some((member) => member.memberId === assignee)
        )
            throw new FinancesError('VALIDATION_ERROR', ['assigneeMemberId']);
        if (input.destination === 'PERSONAL_SUCCESSOR' && amount !== null)
            throw new FinancesError('VALIDATION_ERROR', ['amountInCents']);
        const total =
            source.root instanceof InstallmentCommitment
                ? source.items
                      .reduce(
                          (sum, item) => sum + BigInt(item.remainingInCents!),
                          0n,
                      )
                      .toString()
                : null;
        const before = new Map(
            context.members.map((member) => [member.memberId, 0n]),
        );
        if (source.root instanceof InstallmentCommitment) {
            for (const option of source.root
                .resolutionOptions()
                .filter((item) =>
                    source.items.some(
                        (future) => future.originItemId === item.installmentId,
                    ),
                ))
                for (const share of option.remainingEconomicShares ?? [])
                    before.set(
                        share.memberId,
                        (before.get(share.memberId) ?? 0n) +
                            BigInt(share.amountInCents),
                    );
        }
        let agreement: FinancialClosureDestination['agreement'];
        if (input.destination === 'SETTLE_BEFORE_CLOSURE') {
            if (context.members.length !== 2)
                throw new FinancesError(
                    'FINANCIAL_CLOSURE_AGREEMENT_REQUIRES_TWO',
                );
            if (amount === null || !Number.isSafeInteger(amount) || amount < 1)
                throw new FinancesError('VALIDATION_ERROR', ['amountInCents']);
            const other = context.members.find(
                (member) => member.memberId !== assignee,
            )!.memberId;
            agreement = {
                amountInCents: amount,
                debtorMemberId:
                    source.root.kind === 'EXPENSE' ? other : assignee!,
                creditorMemberId:
                    source.root.kind === 'EXPENSE' ? assignee! : other,
            };
        }
        return {
            originType: input.originType,
            originId: input.originId,
            expectedOriginVersion: source.root.version,
            destination: input.destination,
            assigneeMemberId: assignee,
            amountInCents: amount,
            cutoffDate,
            impactByMember: context.members.map((member) => ({
                memberId: member.memberId,
                beforeInCents:
                    total === null
                        ? null
                        : (before.get(member.memberId) ?? 0n).toString(),
                afterInCents: member.memberId === assignee ? total : '0',
                requiresAcceptance:
                    context.members.length === 2 &&
                    (member.memberId === assignee ||
                        agreement?.debtorMemberId === member.memberId),
            })),
            ...(agreement ? { agreement } : {}),
            originSnapshot: {
                version: source.root.version,
                fingerprint: source.fingerprint,
                kind: source.root.kind,
                description: source.root.description,
                eligibleRemainingInCents: total,
                futureItems: source.items.map((item) => ({
                    originItemId: item.originItemId,
                    referenceDate: item.referenceDate,
                    remainingInCents: item.remainingInCents,
                    version: item.version,
                })),
                ...(source.root instanceof RecurringCommitment
                    ? {
                          recurringImpacts: this.recurringImpacts(
                              context,
                              cutoffDate,
                              assignee,
                              source,
                          ),
                      }
                    : {}),
            },
        };
    }

    private recurringImpacts(
        context: SpaceFinancialContext,
        cutoffDate: string,
        assigneeMemberId: string | null,
        source: Inspected,
    ): FinancialClosureRecurringImpact[] {
        return source.versions.map<FinancialClosureRecurringImpact>(
            ({ effectiveFrom, configuration }) => {
                const participation = configuration.participation;
                if (participation.type !== 'SHARED')
                    throw new FinancesError('FINANCIAL_CLOSURE_ORIGIN_CHANGED');
                const fixed = configuration.valueMode === 'FIXED';
                return {
                    basis: 'PER_OCCURRENCE',
                    economicVersion: configuration.economicVersion,
                    effectiveFrom: [
                        cutoffDate,
                        effectiveFrom,
                        configuration.rule.startsOn,
                    ]
                        .sort()
                        .at(-1)!,
                    valueMode: configuration.valueMode,
                    amountInCents: fixed ? configuration.amountInCents : null,
                    distribution: structuredClone(participation.distribution),
                    impactByMember: context.members.map(({ memberId }) => {
                        const beforeShare =
                            participation.distribution.shares.find(
                                (share) => share.memberId === memberId,
                            );
                        const assumes = memberId === assigneeMemberId;
                        return {
                            memberId,
                            beforeInCents: fixed
                                ? String(
                                      participation.split!.shares.find(
                                          (share) =>
                                              share.memberId === memberId,
                                      )?.amountInCents ?? 0,
                                  )
                                : null,
                            afterInCents: assumes
                                ? fixed
                                    ? String(configuration.amountInCents)
                                    : null
                                : '0',
                            beforeBasisPoints:
                                beforeShare && 'basisPoints' in beforeShare
                                    ? beforeShare.basisPoints
                                    : null,
                            afterBasisPoints: assumes ? 10000 : 0,
                        };
                    }),
                };
            },
        );
    }

    async applyApproved(
        actorId: string,
        spaceId: string,
        processId: string,
        now: Date,
    ): Promise<FinancialClosureApplication[]> {
        return this.uow.execute(async () => {
            const plan = await this.closures.lockForProcess(actorId, spaceId);
            if (
                !plan ||
                plan.processId !== processId ||
                plan.spaceStatus !== 'CLOSING' ||
                plan.processStatus !== 'OPEN' ||
                plan.planStatus !== 'APPROVED' ||
                plan.requiredMemberIds.some(
                    (id) =>
                        !plan.approvals.some(
                            (approval) =>
                                approval.memberId === id &&
                                approval.planRevision === plan.planRevision,
                        ),
                )
            )
                throw new FinancesError('FINANCIAL_CLOSURE_PLAN_NOT_APPROVED');
            const context = await this.contexts.lockForFulfillment(
                PersonId.from(actorId),
                SpaceId.from(spaceId),
            );
            const result: FinancialClosureApplication[] = [];
            for (const destination of [...plan.futureDestinations].sort(
                (a, b) => a.originId.localeCompare(b.originId),
            )) {
                const prior = await this.managers
                    .get()
                    .findOneBy(FinancialClosureEffectOrmEntity, {
                        spaceId,
                        originId: destination.originId,
                    });
                if (prior) {
                    if (digest(prior.snapshot) !== digest(destination))
                        throw new FinancesError(
                            'FINANCIAL_CLOSURE_DESTINATION_APPLIED',
                        );
                    result.push(prior.result);
                    continue;
                }
                if (destination.cutoffDate !== plan.cutoffDate)
                    throw new FinancesError('FINANCIAL_CLOSURE_ORIGIN_CHANGED');
                const source = await this.inspect(
                    spaceId,
                    plan.cutoffDate,
                    destination,
                    true,
                );
                const snapshot = this.snapshot(
                    context,
                    plan.cutoffDate,
                    destination,
                    source,
                );
                if (digest(snapshot) !== digest(destination))
                    throw new FinancesError('FINANCIAL_CLOSURE_ORIGIN_CHANGED');
                const effectId = randomUUID();
                const successorId =
                    destination.destination === 'TERMINATE'
                        ? null
                        : await this.createSuccessor(
                              actorId,
                              context,
                              destination,
                              source,
                              now.toISOString(),
                          );
                const application: FinancialClosureApplication = {
                    effectId,
                    originId: destination.originId,
                    successorCommitmentId: successorId,
                    agreementObligationId: destination.agreement
                        ? randomUUID()
                        : null,
                };
                await this.managers
                    .get()
                    .insert(FinancialClosureEffectOrmEntity, {
                        id: effectId,
                        spaceId,
                        originId: destination.originId,
                        processId,
                        planRevision: plan.planRevision,
                        actorId,
                        cutoffDate: plan.cutoffDate,
                        snapshot,
                        successorCommitmentId: successorId,
                        result: application,
                        registeredAt: now,
                    });
                const updated = await this.managers.get().update(
                    FinancialCommitmentOrmEntity,
                    {
                        id: source.root.id,
                        spaceId,
                        version: source.root.version,
                    },
                    { version: source.root.version + 1 },
                );
                if (updated.affected !== 1)
                    throw new FinancesError('FINANCIAL_CLOSURE_ORIGIN_CHANGED');
                if (source.root instanceof RecurringCommitment)
                    await this.managers.get().query(
                        `INSERT INTO financial_recurrence_terminations
                        (space_id,commitment_id,ends_on,actor_id,registered_at,commitment_version) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (commitment_id) DO NOTHING`,
                        [
                            spaceId,
                            source.root.id,
                            dayBefore(plan.cutoffDate),
                            actorId,
                            now,
                            source.root.version + 1,
                        ],
                    );
                if (destination.agreement) {
                    const agreement = destination.agreement;
                    await this.obligations.save(
                        new InterMemberObligation(
                            application.agreementObligationId!,
                            spaceId,
                            source.root.id,
                            null,
                            agreement.debtorMemberId,
                            agreement.creditorMemberId,
                            agreement.amountInCents,
                            null,
                            now.toLocaleDateString('en-CA', {
                                timeZone: 'America/Sao_Paulo',
                            }),
                            now.toISOString(),
                            actorId,
                            agreement.amountInCents,
                            1,
                            [],
                            source.root.kind,
                            agreement.amountInCents,
                            false,
                            null,
                            null,
                            false,
                            null,
                            null,
                            effectId,
                        ),
                    );
                }
                await recordFinancialCommandAudit(
                    this.managers.get(),
                    {
                        actorId: { value: actorId },
                        spaceId: { value: spaceId },
                        idempotencyKey: effectId,
                    },
                    'APPLY_CLOSURE_DESTINATION',
                    source.root.id,
                    now.toISOString(),
                );
                result.push(application);
            }
            return result;
        });
    }

    private async createSuccessor(
        actorId: string,
        context: SpaceFinancialContext,
        destination: FinancialClosureDestination,
        source: Inspected,
        now: string,
    ): Promise<string> {
        const beneficiary = context.members.find(
            (member) => member.memberId === destination.assigneeMemberId,
        );
        if (!beneficiary)
            throw new FinancesError('VALIDATION_ERROR', ['assigneeMemberId']);
        const personal = await this.personalContexts.get(
            PersonId.from(beneficiary.personId),
        );
        if (!personal || personal.person.id.value !== beneficiary.personId)
            throw new FinancesError('VALIDATION_ERROR', ['assigneeMemberId']);
        const id = randomUUID(),
            spaceId = personal.personalSpace.id.value;
        if (source.root instanceof InstallmentCommitment) {
            const plan = new InstallmentPlan(
                randomUUID(),
                id,
                spaceId,
                source.items.map(
                    (item, index) =>
                        new Installment(
                            randomUUID(),
                            index + 1,
                            item.referenceDate,
                            item.remainingInCents!,
                        ),
                ),
            );
            await this.installments.save(
                new InstallmentCommitment(
                    id,
                    spaceId,
                    source.root.description,
                    actorId,
                    now,
                    1,
                    plan,
                    { type: 'PERSONAL', ownerPersonId: beneficiary.personId },
                    source.root.cadence,
                    source.root.plannedPaymentMethod,
                ),
            );
            return id;
        }
        const original = source.root;
        const configurations = source.versions.length
            ? source.versions
            : [
                  {
                      effectiveFrom: destination.cutoffDate,
                      configuration: original.configurationForVersion(
                          original.economicVersion,
                      )!,
                  },
              ];
        let latest: RecurringCommitment | null = null;
        for (const [index, entry] of configurations.entries()) {
            const from = [
                destination.cutoffDate,
                entry.effectiveFrom,
                entry.configuration.rule.startsOn,
            ]
                .sort()
                .at(-1)!;
            const config = entry.configuration;
            const endsOn = source.versions.length
                ? ([config.rule.endsOn, original.terminatedOn]
                      .filter((date): date is string => date !== null)
                      .sort()[0] ?? null)
                : null;
            const next = new RecurringCommitment(
                id,
                spaceId,
                original.kind,
                config.description,
                config.amountInCents,
                new RecurrenceRule(config.rule.pattern, from, endsOn),
                actorId,
                now,
                index + 1,
                index + 1,
                { type: 'PERSONAL', ownerPersonId: beneficiary.personId },
                config.valueMode,
                from,
            );
            if (!latest) await this.recurring.save(next);
            else await this.recurring.saveVersion(latest, next, from);
            latest = next;
        }
        if (source.versions.length === 0)
            await this.managers.get().query(
                `INSERT INTO financial_recurrence_terminations
            (space_id,commitment_id,ends_on,actor_id,registered_at,commitment_version) VALUES ($1,$2,$3,$4,$5,$6)`,
                [
                    spaceId,
                    id,
                    dayBefore(destination.cutoffDate),
                    actorId,
                    now,
                    latest!.version,
                ],
            );
        const successor = (await this.recurring.find(spaceId, id))!;
        const sourceRows: {
            id: string;
            reference_date: string;
            amount_in_cents: string | null;
            status: string;
        }[] = await this.managers
            .get()
            .query(
                `SELECT id,reference_date::text,amount_in_cents::text,status FROM financial_occurrences WHERE space_id=$1 AND commitment_id=$2 AND reference_date>=$3 ORDER BY reference_date`,
                [original.spaceId, original.id, destination.cutoffDate],
            );
        for (const row of sourceRows) {
            const item = source.items.find(
                (future) => future.originItemId === row.id,
            );
            const config =
                successor.effectiveVersionAt(row.reference_date) ??
                successor.versions[0]?.configuration ??
                successor;
            if (!config) continue;
            const cancelled = row.status === 'CANCELLED' || !item;
            const occurrenceId = randomUUID();
            await this.managers.get().insert(FinancialOccurrenceOrmEntity, {
                id: occurrenceId,
                spaceId,
                commitmentId: id,
                referenceDate: row.reference_date,
                economicVersion: config.economicVersion,
                installmentId: null,
                stateVersion: 1,
                amountInCents: cancelled
                    ? config.valueMode === 'FIXED'
                        ? config.amountInCents
                        : null
                    : (item?.remainingInCents ?? null),
                status: cancelled ? 'CANCELLED' : 'PENDING',
                materializedAt: new Date(now),
            });
            if (cancelled)
                await this.managers.get().query(
                    `INSERT INTO financial_occurrence_cancellations
                (occurrence_id,space_id,commitment_id,actor_id,registered_at) VALUES ($1,$2,$3,$4,$5)`,
                    [occurrenceId, spaceId, id, actorId, now],
                );
        }
        return id;
    }
}
