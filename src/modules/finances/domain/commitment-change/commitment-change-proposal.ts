import { FinancesError } from '../errors/finances.error.js';

function immutable(value: unknown): unknown {
    if (Array.isArray(value)) return Object.freeze(value.map(immutable));
    if (value && typeof value === 'object')
        return Object.freeze(
            Object.fromEntries(
                Object.entries(value).map(([key, item]) => [
                    key,
                    immutable(item),
                ]),
            ),
        );
    return value;
}

export interface CommitmentChangeProposalState {
    id: string;
    spaceId: string;
    commitmentId: string;
    version: number;
    baseVersion: number;
    originFingerprint: string;
    proposedByMemberId: string;
    recipientMemberId: string;
    actorId: string;
    effectiveFrom: string;
    configuration: object;
    impact: object;
    status: 'PROPOSED' | 'ACCEPTED' | 'REJECTED' | 'CANCELLED';
    registeredAt: string;
    decidedAt: string | null;
    decidedByPersonId: string | null;
}

export class CommitmentChangeProposal {
    constructor(readonly state: Readonly<CommitmentChangeProposalState>) {
        if (
            !state.id ||
            state.version < 1 ||
            state.baseVersion < 1 ||
            state.proposedByMemberId === state.recipientMemberId ||
            (state.status === 'PROPOSED') !== (state.decidedAt === null) ||
            (state.decidedAt === null) !== (state.decidedByPersonId === null)
        )
            throw new FinancesError('VALIDATION_ERROR');
        this.state = Object.freeze({
            ...state,
            configuration: immutable(state.configuration) as object,
            impact: immutable(state.impact) as object,
        });
        Object.freeze(this);
    }

    decide(
        memberId: string,
        personId: string,
        expectedVersion: number,
        accept: boolean,
        now: string,
    ) {
        if (memberId !== this.state.recipientMemberId)
            throw new FinancesError('FINANCIAL_CHANGE_RECIPIENT_REQUIRED');
        if (this.state.version !== expectedVersion)
            throw new FinancesError('CONCURRENT_MODIFICATION');
        if (this.state.status !== 'PROPOSED')
            throw new FinancesError('FINANCIAL_CHANGE_PROPOSAL_RESOLVED');
        return new CommitmentChangeProposal({
            ...this.state,
            version: this.state.version + 1,
            status: accept ? 'ACCEPTED' : 'REJECTED',
            decidedAt: now,
            decidedByPersonId: personId,
        });
    }
}
