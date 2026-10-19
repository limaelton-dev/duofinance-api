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
};

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
        >,
    ): ClosurePlan {
        return new ClosurePlan({
            ...structuredClone(input),
            proposedCutoffDate: null,
            planRevision: 1,
            planStatus: 'DRAFT',
            approvals: [],
            confirmations: [],
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

    snapshot(): ClosurePlanProps {
        return structuredClone(this.props);
    }
}
