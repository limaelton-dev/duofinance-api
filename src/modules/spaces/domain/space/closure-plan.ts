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
    financialFingerprint?: string;
};

export type ClosureCancellationConsent = ClosureConsent & {
    spaceVersion: number;
};

export type ClosureConfirmation = {
    actorMemberId: string;
    now: Date;
    expectedFinancialFingerprint: string;
    financialFingerprint: string;
    financiallyReady: boolean;
    completionPrepared: boolean;
};

export type ClosureProposalSnapshot = {
    financialFingerprint: string;
    financialBlockerCount: number;
    outstandingAmounts: {
        debtorMemberId: string;
        creditorMemberId: string;
        amountInCents: string;
    }[];
    routine: { pendingTaskCount: number; activeRecurrenceCount: number };
    shopping: { activeListCount: number };
};

export type ClosurePlanAction = 'PROPOSE' | 'APPROVE' | 'REJECT';

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
    proposalSnapshot: ClosureProposalSnapshot | null;
    hasBilateralApproval: boolean;
    cancellationConsents: ClosureCancellationConsent[];
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
                    !Number.isFinite(Date.parse(consent.recordedAt)) ||
                    (consent.financialFingerprint !== undefined &&
                        !/^[a-f0-9]{64}$/.test(consent.financialFingerprint)),
            ) ||
            new Set(
                props.futureDestinations.map(
                    (destination) =>
                        `${destination.originType}:${destination.originId}`,
                ),
            ).size !== props.futureDestinations.length ||
            typeof props.hasBilateralApproval !== 'boolean' ||
            (props.hasBilateralApproval && props.participants.length !== 2) ||
            [props.approvals, props.confirmations].some(
                (consents) =>
                    new Set(consents.map((consent) => consent.memberId))
                        .size !== consents.length,
            ) ||
            new Set(
                props.cancellationConsents.map((consent) => consent.memberId),
            ).size !== props.cancellationConsents.length ||
            props.cancellationConsents.some(
                (consent) =>
                    consent.planRevision !== props.planRevision ||
                    !Number.isSafeInteger(consent.spaceVersion) ||
                    consent.spaceVersion < 1 ||
                    !Number.isFinite(Date.parse(consent.recordedAt)) ||
                    !props.participants.some(
                        (member) => member.memberId === consent.memberId,
                    ),
            )
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
            | 'proposalSnapshot'
            | 'hasBilateralApproval'
            | 'cancellationConsents'
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
            proposalSnapshot: null,
            hasBilateralApproval: false,
            cancellationConsents: [],
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
            proposalSnapshot: null,
            cancellationConsents: [],
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
            proposalSnapshot: null,
            cancellationConsents: [],
        });
    }

    decide(input: {
        action: ClosurePlanAction;
        actorMemberId: string;
        now: Date;
        proposalSnapshot?: ClosureProposalSnapshot;
    }): ClosurePlan {
        if (
            !this.props.participants.some(
                (member) => member.memberId === input.actorMemberId,
            )
        ) {
            throw new SpacesDomainError('CLOSURE_PLAN_DECISION_NOT_ALLOWED');
        }
        if (
            !Number.isFinite(input.now.getTime()) ||
            input.now.toISOString() < this.props.startedAt
        ) {
            throw new Error('Invalid closure decision time');
        }
        if (input.action === 'PROPOSE') {
            if (!input.proposalSnapshot)
                throw new SpacesDomainError('CLOSURE_PROPOSAL_CHANGED');
            this.assertProposalSnapshot(input.proposalSnapshot);
            if (
                (this.props.planStatus === 'PROPOSED' ||
                    this.props.planStatus === 'APPROVED') &&
                this.props.proposalSnapshot?.financialFingerprint ===
                    input.proposalSnapshot.financialFingerprint &&
                this.props.cancellationConsents.length === 0
            ) {
                throw new SpacesDomainError('CLOSURE_PLAN_UNCHANGED');
            }
            const revision =
                this.props.planRevision +
                (this.props.planStatus === 'DRAFT' ? 0 : 1);
            const approved = this.props.participants.length === 1;
            return new ClosurePlan({
                ...this.snapshot(),
                planRevision: revision,
                planStatus: approved ? 'APPROVED' : 'PROPOSED',
                proposalSnapshot: structuredClone(input.proposalSnapshot),
                approvals: [
                    {
                        memberId: input.actorMemberId,
                        planRevision: revision,
                        recordedAt: input.now.toISOString(),
                    },
                ],
                confirmations: [],
                cancellationConsents: [],
                cutoffDate: approved
                    ? (this.props.proposedCutoffDate ?? this.props.cutoffDate)
                    : this.props.cutoffDate,
                proposedCutoffDate: approved
                    ? null
                    : this.props.proposedCutoffDate,
            });
        }
        if (this.props.cancellationConsents.length > 0)
            throw new SpacesDomainError('CLOSURE_CANCELLATION_PENDING');
        if (
            this.props.participants.length !== 2 ||
            this.props.approvals[0]?.memberId === input.actorMemberId
        ) {
            throw new SpacesDomainError('CLOSURE_PLAN_DECISION_NOT_ALLOWED');
        }
        if (
            this.props.planStatus !== 'PROPOSED' ||
            this.props.approvals.length !== 1 ||
            !this.props.proposalSnapshot
        ) {
            throw new SpacesDomainError('CLOSURE_PLAN_NOT_PROPOSED');
        }
        if (input.action === 'REJECT') {
            return new ClosurePlan({
                ...this.snapshot(),
                planStatus: 'REJECTED',
                confirmations: [],
            });
        }
        if (
            !input.proposalSnapshot ||
            input.proposalSnapshot.financialFingerprint !==
                this.props.proposalSnapshot.financialFingerprint
        ) {
            throw new SpacesDomainError('CLOSURE_PROPOSAL_CHANGED');
        }
        this.assertProposalSnapshot(input.proposalSnapshot);
        return new ClosurePlan({
            ...this.snapshot(),
            planStatus: 'APPROVED',
            hasBilateralApproval: true,
            approvals: [
                ...this.props.approvals,
                {
                    memberId: input.actorMemberId,
                    planRevision: this.props.planRevision,
                    recordedAt: input.now.toISOString(),
                },
            ],
            cutoffDate: this.props.proposedCutoffDate ?? this.props.cutoffDate,
            proposedCutoffDate: null,
            confirmations: [],
        });
    }

    confirm(input: ClosureConfirmation): {
        plan: ClosurePlan;
        completed: boolean;
    } {
        this.assertConclusionActor(input.actorMemberId, input.now);
        if (this.props.cancellationConsents.length > 0)
            throw new SpacesDomainError('CLOSURE_CANCELLATION_PENDING');
        if (
            this.props.planStatus !== 'APPROVED' ||
            !this.props.participants.every((member) =>
                this.props.approvals.some(
                    (approval) =>
                        approval.memberId === member.memberId &&
                        approval.planRevision === this.props.planRevision,
                ),
            ) ||
            !input.financiallyReady
        ) {
            throw new SpacesDomainError('CLOSURE_CONFIRMATION_NOT_READY');
        }
        if (
            !/^[a-f0-9]{64}$/.test(input.financialFingerprint) ||
            !/^[a-f0-9]{64}$/.test(input.expectedFinancialFingerprint) ||
            input.financialFingerprint !== input.expectedFinancialFingerprint
        ) {
            throw new SpacesDomainError('CLOSURE_FINANCIAL_STATE_CHANGED');
        }
        const valid = this.props.confirmations.filter(
            (consent) =>
                consent.planRevision === this.props.planRevision &&
                consent.financialFingerprint === input.financialFingerprint,
        );
        if (valid.some((consent) => consent.memberId === input.actorMemberId))
            throw new SpacesDomainError('CLOSURE_ALREADY_CONFIRMED');
        const confirmations = [
            ...valid,
            {
                memberId: input.actorMemberId,
                planRevision: this.props.planRevision,
                recordedAt: input.now.toISOString(),
                financialFingerprint: input.financialFingerprint,
            },
        ];
        const completed = this.props.participants.every((member) =>
            confirmations.some(
                (consent) => consent.memberId === member.memberId,
            ),
        );
        if (completed && !input.completionPrepared)
            throw new SpacesDomainError('CLOSURE_COMPLETION_NOT_PREPARED');
        return {
            plan: new ClosurePlan({ ...this.snapshot(), confirmations }),
            completed,
        };
    }

    cancel(input: { actorMemberId: string; now: Date; spaceVersion: number }): {
        plan: ClosurePlan;
        completed: boolean;
    } {
        this.assertConclusionActor(input.actorMemberId, input.now);
        if (!Number.isSafeInteger(input.spaceVersion) || input.spaceVersion < 1)
            throw new Error('Invalid closure cancellation version');
        const bilateral =
            this.props.participants.length === 2 &&
            (this.props.hasBilateralApproval ||
                this.props.approvals.some(
                    (approval) =>
                        approval.memberId !== this.props.requestedByMemberId,
                ));
        if (
            !bilateral &&
            input.actorMemberId !== this.props.requestedByMemberId
        ) {
            throw new SpacesDomainError('CLOSURE_CANCELLATION_NOT_ALLOWED');
        }
        const valid = this.props.cancellationConsents.filter(
            (consent) =>
                consent.planRevision === this.props.planRevision &&
                consent.spaceVersion === input.spaceVersion,
        );
        if (valid.some((consent) => consent.memberId === input.actorMemberId))
            throw new SpacesDomainError(
                'CLOSURE_ALREADY_REQUESTED_CANCELLATION',
            );
        const cancellationConsents = [
            ...valid,
            {
                memberId: input.actorMemberId,
                planRevision: this.props.planRevision,
                recordedAt: input.now.toISOString(),
                spaceVersion:
                    valid.length > 0
                        ? input.spaceVersion
                        : input.spaceVersion + 1,
            },
        ];
        const completed =
            !bilateral ||
            this.props.participants.every((member) =>
                cancellationConsents.some(
                    (consent) => consent.memberId === member.memberId,
                ),
            );
        return {
            plan: new ClosurePlan({
                ...this.snapshot(),
                cancellationConsents,
                confirmations: [],
                ...(completed
                    ? {
                          planStatus: 'DRAFT' as const,
                          approvals: [],
                          proposalSnapshot: null,
                          proposedCutoffDate: null,
                      }
                    : {}),
            }),
            completed,
        };
    }

    private assertConclusionActor(actorMemberId: string, now: Date): void {
        if (
            !this.props.participants.some(
                (member) => member.memberId === actorMemberId,
            )
        )
            throw new SpacesDomainError('SPACE_NOT_FOUND');
        if (
            !Number.isFinite(now.getTime()) ||
            now.toISOString() < this.props.startedAt
        )
            throw new Error('Invalid closure conclusion time');
    }

    private assertProposalSnapshot(snapshot: ClosureProposalSnapshot): void {
        const counts = [
            snapshot.financialBlockerCount,
            snapshot.routine.pendingTaskCount,
            snapshot.routine.activeRecurrenceCount,
            snapshot.shopping.activeListCount,
        ];
        if (
            !snapshot.financialFingerprint ||
            counts.some((count) => !Number.isSafeInteger(count) || count < 0) ||
            snapshot.outstandingAmounts.some(
                (amount) =>
                    !/^[0-9]+$/.test(amount.amountInCents) ||
                    amount.debtorMemberId === amount.creditorMemberId ||
                    !this.props.participants.some(
                        (member) => member.memberId === amount.debtorMemberId,
                    ) ||
                    !this.props.participants.some(
                        (member) => member.memberId === amount.creditorMemberId,
                    ),
            )
        ) {
            throw new SpacesDomainError('CLOSURE_PROPOSAL_CHANGED');
        }
    }

    snapshot(): ClosurePlanProps {
        return structuredClone(this.props);
    }
}
