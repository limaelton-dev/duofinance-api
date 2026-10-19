import { SpacesDomainError } from '../errors/spaces-domain.error.js';

export type ClosureParticipant = {
    memberId: string;
    personId: string;
    displayName: string;
};

export type ClosureConsent = {
    memberId: string;
    planRevision: number;
    recordedAt: string;
};

export type ClosureDestinationIntent = {
    originType: 'RECURRING' | 'INSTALLMENT';
    originId: string;
    expectedOriginVersion: number;
    destination: 'TERMINATE' | 'PERSONAL_SUCCESSOR' | 'SETTLE_BEFORE_CLOSURE';
    assigneeMemberId?: string | null;
    amountInCents?: number | null;
};

export type ClosureRecurringImpact = {
    basis: 'PER_OCCURRENCE';
    economicVersion: number;
    effectiveFrom: string;
    valueMode: 'FIXED' | 'VARIABLE';
    amountInCents: number | null;
    distribution:
        | {
              mode: 'AMOUNTS';
              shares: { memberId: string; amountInCents: number }[];
          }
        | {
              mode: 'PERCENTAGES';
              shares: { memberId: string; basisPoints: number }[];
          };
    impactByMember: {
        memberId: string;
        beforeInCents: string | null;
        afterInCents: string | null;
        beforeBasisPoints: number | null;
        afterBasisPoints: number;
    }[];
};

export type ClosureFutureDestination = ClosureDestinationIntent & {
    assigneeMemberId: string | null;
    amountInCents: number | null;
    cutoffDate: string;
    impactByMember: {
        memberId: string;
        beforeInCents: string | null;
        afterInCents: string | null;
        requiresAcceptance: boolean;
    }[];
    originSnapshot: {
        version: number;
        fingerprint: string;
        kind: 'EXPENSE' | 'INCOME';
        description: string;
        eligibleRemainingInCents: string | null;
        futureItems: {
            originItemId: string | null;
            referenceDate: string;
            remainingInCents: number | null;
            version: number | null;
        }[];
        recurringImpacts?: ClosureRecurringImpact[];
    };
    agreement?: {
        debtorMemberId: string;
        creditorMemberId: string;
        amountInCents: number;
    };
};

export type ClosurePlanProps = {
    processId: string;
    requestedByMemberId: string;
    participants: ClosureParticipant[];
    startedAt: string;
    cutoffDate: string;
    proposedCutoffDate: string | null;
    planRevision: number;
    planStatus: 'DRAFT' | 'PROPOSED' | 'APPROVED' | 'REJECTED';
    approvals: ClosureConsent[];
    confirmations: ClosureConsent[];
    futureDestinations: ClosureFutureDestination[];
};

function destinationIdentity(destination: ClosureFutureDestination): string {
    return JSON.stringify([
        destination.originType,
        destination.originId,
        destination.expectedOriginVersion,
        destination.destination,
        destination.assigneeMemberId,
        destination.amountInCents,
        destination.cutoffDate,
        [...destination.impactByMember]
            .sort((a, b) => a.memberId.localeCompare(b.memberId))
            .map((impact) => [
                impact.memberId,
                impact.beforeInCents,
                impact.afterInCents,
                impact.requiresAcceptance,
            ]),
        destination.originSnapshot.version,
        destination.originSnapshot.fingerprint,
        destination.originSnapshot.kind,
        destination.originSnapshot.description,
        destination.originSnapshot.eligibleRemainingInCents,
        [...destination.originSnapshot.futureItems]
            .sort(
                (a, b) =>
                    a.referenceDate.localeCompare(b.referenceDate) ||
                    (a.originItemId ?? '').localeCompare(b.originItemId ?? ''),
            )
            .map((item) => [
                item.originItemId,
                item.referenceDate,
                item.remainingInCents,
                item.version,
            ]),
        (destination.originSnapshot.recurringImpacts &&
            [...destination.originSnapshot.recurringImpacts]
                .sort(
                    (a, b) =>
                        a.effectiveFrom.localeCompare(b.effectiveFrom) ||
                        a.economicVersion - b.economicVersion,
                )
                .map((impact) => [
                    impact.basis,
                    impact.economicVersion,
                    impact.effectiveFrom,
                    impact.valueMode,
                    impact.amountInCents,
                    impact.distribution.mode,
                    [...impact.distribution.shares]
                        .sort((a, b) => a.memberId.localeCompare(b.memberId))
                        .map((share) => [
                            share.memberId,
                            'basisPoints' in share
                                ? share.basisPoints
                                : share.amountInCents,
                        ]),
                    [...impact.impactByMember]
                        .sort((a, b) => a.memberId.localeCompare(b.memberId))
                        .map((member) => [
                            member.memberId,
                            member.beforeInCents,
                            member.afterInCents,
                            member.beforeBasisPoints,
                            member.afterBasisPoints,
                        ]),
                ])) ||
            null,
        destination.agreement
            ? [
                  destination.agreement.debtorMemberId,
                  destination.agreement.creditorMemberId,
                  destination.agreement.amountInCents,
              ]
            : null,
    ]);
}

function validCivilDate(value: string): boolean {
    return (
        /^\d{4}-\d{2}-\d{2}$/.test(value) &&
        Number.isFinite(Date.parse(`${value}T12:00:00.000Z`)) &&
        new Date(`${value}T12:00:00.000Z`).toISOString().slice(0, 10) === value
    );
}

export class ClosurePlan {
    private constructor(private readonly props: ClosurePlanProps) {
        if (
            !props.processId ||
            !Number.isSafeInteger(props.planRevision) ||
            props.planRevision < 1 ||
            !validCivilDate(props.cutoffDate) ||
            (props.proposedCutoffDate !== null &&
                !validCivilDate(props.proposedCutoffDate)) ||
            !Number.isFinite(Date.parse(props.startedAt)) ||
            props.participants.length < 1 ||
            props.participants.length > 2 ||
            new Set(props.participants.map((member) => member.memberId))
                .size !== props.participants.length ||
            new Set(props.participants.map((member) => member.personId))
                .size !== props.participants.length ||
            !props.participants.some(
                (member) => member.memberId === props.requestedByMemberId,
            ) ||
            !['DRAFT', 'PROPOSED', 'APPROVED', 'REJECTED'].includes(
                props.planStatus,
            ) ||
            [...props.approvals, ...props.confirmations].some(
                (consent) =>
                    consent.planRevision !== props.planRevision ||
                    !props.participants.some(
                        (member) => member.memberId === consent.memberId,
                    ) ||
                    !Number.isFinite(Date.parse(consent.recordedAt)),
            ) ||
            new Set(
                props.futureDestinations.map(
                    (destination) =>
                        `${destination.originType}:${destination.originId}`,
                ),
            ).size !== props.futureDestinations.length
        )
            throw new Error('Invalid closure plan');
    }

    static start(
        input: Omit<
            ClosurePlanProps,
            | 'proposedCutoffDate'
            | 'planRevision'
            | 'planStatus'
            | 'approvals'
            | 'confirmations'
            | 'futureDestinations'
        >,
    ): ClosurePlan {
        return new ClosurePlan({
            ...structuredClone(input),
            proposedCutoffDate: null,
            planRevision: 1,
            planStatus: 'DRAFT',
            approvals: [],
            confirmations: [],
            futureDestinations: [],
        });
    }

    static restore(props: ClosurePlanProps): ClosurePlan {
        return new ClosurePlan(structuredClone(props));
    }

    proposeCutoff(cutoffDate: string): ClosurePlan {
        if (!validCivilDate(cutoffDate) || cutoffDate < this.props.cutoffDate) {
            throw new SpacesDomainError('CLOSURE_CUTOFF_INVALID');
        }
        if (
            (this.props.proposedCutoffDate ?? this.props.cutoffDate) ===
            cutoffDate
        ) {
            throw new SpacesDomainError('CLOSURE_PLAN_UNCHANGED');
        }
        return new ClosurePlan({
            ...this.snapshot(),
            proposedCutoffDate:
                cutoffDate === this.props.cutoffDate ? null : cutoffDate,
            planRevision: this.props.planRevision + 1,
            planStatus: 'DRAFT',
            approvals: [],
            confirmations: [],
        });
    }

    upsertDestination(destination: ClosureFutureDestination): ClosurePlan {
        if (
            !['RECURRING', 'INSTALLMENT'].includes(destination.originType) ||
            !destination.originId ||
            !Number.isSafeInteger(destination.expectedOriginVersion) ||
            destination.expectedOriginVersion < 1 ||
            ![
                'TERMINATE',
                'PERSONAL_SUCCESSOR',
                'SETTLE_BEFORE_CLOSURE',
            ].includes(destination.destination) ||
            destination.cutoffDate !==
                (this.props.proposedCutoffDate ?? this.props.cutoffDate) ||
            destination.originSnapshot.version !==
                destination.expectedOriginVersion ||
            !destination.originSnapshot.fingerprint ||
            (destination.destination === 'PERSONAL_SUCCESSOR' ||
            destination.destination === 'SETTLE_BEFORE_CLOSURE'
                ? !this.props.participants.some(
                      (member) =>
                          member.memberId === destination.assigneeMemberId,
                  )
                : destination.assigneeMemberId !== null) ||
            (destination.destination === 'SETTLE_BEFORE_CLOSURE'
                ? !Number.isSafeInteger(destination.amountInCents) ||
                  destination.amountInCents! <= 0
                : destination.amountInCents !== null) ||
            (destination.destination === 'SETTLE_BEFORE_CLOSURE'
                ? this.props.participants.length !== 2 ||
                  !destination.agreement ||
                  destination.agreement.debtorMemberId ===
                      destination.agreement.creditorMemberId ||
                  destination.agreement.amountInCents !==
                      destination.amountInCents ||
                  !this.props.participants.some(
                      (member) =>
                          member.memberId ===
                          destination.agreement!.debtorMemberId,
                  ) ||
                  !this.props.participants.some(
                      (member) =>
                          member.memberId ===
                          destination.agreement!.creditorMemberId,
                  )
                : destination.agreement !== undefined) ||
            destination.impactByMember.some(
                (impact) =>
                    !this.props.participants.some(
                        (member) => member.memberId === impact.memberId,
                    ),
            )
        )
            throw new SpacesDomainError('CLOSURE_DESTINATION_INVALID');
        const previous = this.props.futureDestinations.find(
            (candidate) =>
                candidate.originType === destination.originType &&
                candidate.originId === destination.originId,
        );
        if (
            previous &&
            destinationIdentity(previous) === destinationIdentity(destination)
        ) {
            throw new SpacesDomainError('CLOSURE_PLAN_UNCHANGED');
        }
        const futureDestinations = this.props.futureDestinations.filter(
            (candidate) =>
                candidate.originType !== destination.originType ||
                candidate.originId !== destination.originId,
        );
        futureDestinations.push(structuredClone(destination));
        futureDestinations.sort(
            (a, b) =>
                a.originType.localeCompare(b.originType) ||
                a.originId.localeCompare(b.originId),
        );
        return new ClosurePlan({
            ...this.snapshot(),
            futureDestinations,
            planRevision: this.props.planRevision + 1,
            planStatus: 'DRAFT',
            approvals: [],
            confirmations: [],
        });
    }

    snapshot(): ClosurePlanProps {
        return structuredClone(this.props);
    }
}
