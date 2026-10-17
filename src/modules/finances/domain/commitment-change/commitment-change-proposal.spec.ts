import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { FinancesError } from '../errors/finances.error.js';
import {
    CommitmentChangeProposal,
    type CommitmentChangeProposalState,
} from './commitment-change-proposal.js';

const proposedState = (): CommitmentChangeProposalState => ({
    id: randomUUID(),
    spaceId: randomUUID(),
    commitmentId: randomUUID(),
    version: 1,
    baseVersion: 2,
    originFingerprint: 'original-economic-configuration',
    proposedByMemberId: randomUUID(),
    recipientMemberId: randomUUID(),
    actorId: randomUUID(),
    effectiveFrom: '2026-11-01',
    configuration: { amountInCents: 170000 },
    impact: { requiresAcceptance: true },
    status: 'PROPOSED',
    registeredAt: '2026-10-14T15:00:00Z',
    decidedAt: null,
    decidedByPersonId: null,
});
const decidedAt = '2026-10-15T15:00:00Z';

describe('CommitmentChangeProposal', () => {
    it.each([true, false])(
        'records the recipient decision and preserves the original pending proposal for acceptance=%s',
        (accept) => {
            const state = proposedState();
            const before = structuredClone(state);
            const original = new CommitmentChangeProposal(state);
            const personId = randomUUID();
            const decided = original.decide(
                state.recipientMemberId,
                personId,
                1,
                accept,
                decidedAt,
            );
            expect(decided.state).toEqual({
                ...before,
                version: 2,
                status: accept ? 'ACCEPTED' : 'REJECTED',
                decidedAt,
                decidedByPersonId: personId,
            });
            expect(original.state).toEqual(before);
            expect(decided).not.toBe(original);
            expect(Object.isFrozen(original.state)).toBe(true);
            expect(Object.isFrozen(decided.state)).toBe(true);
        },
    );

    it('denies the proposer and any other member the recipient decision', () => {
        const state = proposedState();
        const proposal = new CommitmentChangeProposal(state);
        for (const memberId of [state.proposedByMemberId, randomUUID()])
            expect(() =>
                proposal.decide(memberId, randomUUID(), 1, true, decidedAt),
            ).toThrowError(
                new FinancesError('FINANCIAL_CHANGE_RECIPIENT_REQUIRED'),
            );
        expect(proposal.state.status).toBe('PROPOSED');
        expect(proposal.state.version).toBe(1);
    });

    it.each([0, 2])(
        'rejects stale or invented proposal version %s',
        (version) => {
            const state = proposedState();
            const proposal = new CommitmentChangeProposal(state);
            expect(() =>
                proposal.decide(
                    state.recipientMemberId,
                    randomUUID(),
                    version,
                    true,
                    decidedAt,
                ),
            ).toThrowError(new FinancesError('CONCURRENT_MODIFICATION'));
            expect(proposal.state.status).toBe('PROPOSED');
        },
    );

    it.each(['ACCEPTED', 'REJECTED', 'CANCELLED'] as const)(
        'keeps terminal status %s closed to acceptance and rejection',
        (status) => {
            const state = {
                ...proposedState(),
                status,
                version: 2,
                decidedAt,
                decidedByPersonId: randomUUID(),
            };
            const proposal = new CommitmentChangeProposal(state);
            for (const accept of [true, false])
                expect(() =>
                    proposal.decide(
                        state.recipientMemberId,
                        randomUUID(),
                        2,
                        accept,
                        decidedAt,
                    ),
                ).toThrowError(
                    new FinancesError('FINANCIAL_CHANGE_PROPOSAL_RESOLVED'),
                );
            expect(proposal.state).toEqual(state);
        },
    );

    it('rejects a proposal addressed to its proposer and contradictory decision metadata', () => {
        const state = proposedState();
        for (const invalid of [
            { ...state, recipientMemberId: state.proposedByMemberId },
            { ...state, baseVersion: 0 },
            { ...state, version: 0 },
            { ...state, decidedAt },
            { ...state, decidedByPersonId: randomUUID() },
            { ...state, status: 'ACCEPTED' as const },
        ])
            expect(() => new CommitmentChangeProposal(invalid)).toThrowError(
                new FinancesError('VALIDATION_ERROR'),
            );
    });
});
