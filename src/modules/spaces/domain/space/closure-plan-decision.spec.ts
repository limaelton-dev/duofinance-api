import { describe, expect, it } from 'vitest';
import { SpacesDomainError } from '../errors/spaces-domain.error.js';
import {
    ClosurePlan,
    type ClosureProposalSnapshot,
    type ClosureFutureDestination,
} from './closure-plan.js';

const now = new Date('2026-10-19T13:00:00.000Z');
const first = { memberId: 'member-1', personId: 'person-1', displayName: 'A' };
const second = { memberId: 'member-2', personId: 'person-2', displayName: 'B' };

function plan(individual = false) {
    return ClosurePlan.start({
        processId: 'process-1',
        requestedByMemberId: first.memberId,
        participants: individual ? [first] : [first, second],
        startedAt: now.toISOString(),
        cutoffDate: '2026-10-19',
    });
}

function snapshot(
    financialFingerprint = 'financial-1',
): ClosureProposalSnapshot {
    return {
        financialFingerprint,
        financialBlockerCount: 1,
        outstandingAmounts: [
            {
                debtorMemberId: first.memberId,
                creditorMemberId: second.memberId,
                amountInCents: '5000',
            },
        ],
        routine: { pendingTaskCount: 2, activeRecurrenceCount: 1 },
        shopping: { activeListCount: 1 },
    };
}

function proposed() {
    return plan().decide({
        action: 'PROPOSE',
        actorMemberId: second.memberId,
        now,
        proposalSnapshot: snapshot(),
    });
}

function approved() {
    return proposed().decide({
        action: 'APPROVE',
        actorMemberId: first.memberId,
        now,
        proposalSnapshot: snapshot(),
    });
}

describe('ClosurePlan decisions', () => {
    it('allows the other member to propose while keeping requester and proposer independent', () => {
        const original = plan().proposeCutoff('2026-11-01');
        const input = snapshot();
        const proposal = original.decide({
            action: 'PROPOSE',
            actorMemberId: second.memberId,
            now,
            proposalSnapshot: input,
        });
        input.outstandingAmounts[0].amountInCents = '1';
        const agreed = proposal
            .decide({
                action: 'APPROVE',
                actorMemberId: first.memberId,
                now,
                proposalSnapshot: snapshot(),
            })
            .snapshot();

        expect(proposal.snapshot()).toMatchObject({
            requestedByMemberId: first.memberId,
            planStatus: 'PROPOSED',
            planRevision: 2,
            cutoffDate: '2026-10-19',
            proposedCutoffDate: '2026-11-01',
            approvals: [{ memberId: second.memberId, planRevision: 2 }],
        });
        expect(
            proposal.snapshot().proposalSnapshot?.outstandingAmounts[0]
                .amountInCents,
        ).toBe('5000');
        expect(agreed).toMatchObject({
            planStatus: 'APPROVED',
            planRevision: 2,
            hasBilateralApproval: true,
            cutoffDate: '2026-11-01',
            proposedCutoffDate: null,
            approvals: [
                { memberId: second.memberId, planRevision: 2 },
                { memberId: first.memberId, planRevision: 2 },
            ],
            confirmations: [],
            proposalSnapshot: { financialBlockerCount: 1 },
        });
        expect(original.snapshot().planStatus).toBe('DRAFT');
    });

    it('approves individual closure only with explicit consent and keeps final confirmation separate', () => {
        const soloSnapshot = { ...snapshot(), outstandingAmounts: [] };
        const solo = plan(true).proposeCutoff('2026-11-01').decide({
            action: 'PROPOSE',
            actorMemberId: first.memberId,
            now,
            proposalSnapshot: soloSnapshot,
        });
        expect(solo.snapshot()).toMatchObject({
            planStatus: 'APPROVED',
            cutoffDate: '2026-11-01',
            proposedCutoffDate: null,
            hasBilateralApproval: false,
            approvals: [{ memberId: first.memberId }],
            confirmations: [],
        });
        for (const action of ['APPROVE', 'REJECT'] as const) {
            expect(() =>
                solo.decide({
                    action,
                    actorMemberId: first.memberId,
                    now,
                    proposalSnapshot: soloSnapshot,
                }),
            ).toThrow(
                new SpacesDomainError('CLOSURE_PLAN_DECISION_NOT_ALLOWED'),
            );
        }
    });

    it.each(['APPROVE', 'REJECT'] as const)(
        'rejects a second %s decision from the proposer',
        (action) => {
            const proposal = proposed();
            const before = proposal.snapshot();
            expect(() =>
                proposal.decide({
                    action,
                    actorMemberId: second.memberId,
                    now,
                    proposalSnapshot: snapshot(),
                }),
            ).toThrow(
                new SpacesDomainError('CLOSURE_PLAN_DECISION_NOT_ALLOWED'),
            );
            expect(proposal.snapshot()).toEqual(before);
        },
    );

    it('preserves rejection and allows a new proposal identified by another revision', () => {
        const proposal = proposed();
        const rejected = proposal.decide({
            action: 'REJECT',
            actorMemberId: first.memberId,
            now,
        });
        expect(rejected.snapshot()).toMatchObject({
            planStatus: 'REJECTED',
            planRevision: 1,
            hasBilateralApproval: false,
        });
        const revised = rejected
            .decide({
                action: 'PROPOSE',
                actorMemberId: first.memberId,
                now,
                proposalSnapshot: snapshot(),
            })
            .snapshot();
        expect(revised).toMatchObject({
            planStatus: 'PROPOSED',
            planRevision: 2,
            approvals: [{ memberId: first.memberId, planRevision: 2 }],
            confirmations: [],
        });
        expect(proposal.snapshot().planStatus).toBe('PROPOSED');
    });

    it('does not approve different financial consequences and requires an explicit new proposal', () => {
        const proposal = proposed();
        expect(() =>
            proposal.decide({
                action: 'APPROVE',
                actorMemberId: first.memberId,
                now,
                proposalSnapshot: snapshot('financial-2'),
            }),
        ).toThrow(new SpacesDomainError('CLOSURE_PROPOSAL_CHANGED'));
        const changed = proposal
            .decide({
                action: 'PROPOSE',
                actorMemberId: first.memberId,
                now,
                proposalSnapshot: snapshot('financial-2'),
            })
            .snapshot();
        expect(changed).toMatchObject({
            planRevision: 2,
            planStatus: 'PROPOSED',
            proposalSnapshot: { financialFingerprint: 'financial-2' },
            approvals: [{ memberId: first.memberId, planRevision: 2 }],
        });
        expect(proposal.snapshot().approvals[0].memberId).toBe(second.memberId);
    });

    it('does not duplicate an unchanged proposal and preserves prior bilateral approval after a material revision', () => {
        const agreed = approved();
        expect(() =>
            agreed.decide({
                action: 'PROPOSE',
                actorMemberId: first.memberId,
                now,
                proposalSnapshot: snapshot(),
            }),
        ).toThrow(new SpacesDomainError('CLOSURE_PLAN_UNCHANGED'));
        const revised = agreed.proposeCutoff('2026-11-01').snapshot();
        expect(revised).toMatchObject({
            planStatus: 'DRAFT',
            planRevision: 2,
            hasBilateralApproval: true,
            proposalSnapshot: null,
            approvals: [],
            confirmations: [],
        });
        const financialChange = agreed
            .decide({
                action: 'PROPOSE',
                actorMemberId: first.memberId,
                now,
                proposalSnapshot: snapshot('financial-2'),
            })
            .snapshot();
        expect(financialChange).toMatchObject({
            planStatus: 'PROPOSED',
            planRevision: 2,
            hasBilateralApproval: true,
        });
    });

    it('clears the snapshot when editing a destination while retaining prior bilateral approval', () => {
        const destination: ClosureFutureDestination = {
            originType: 'RECURRING',
            originId: 'origin-1',
            expectedOriginVersion: 1,
            destination: 'TERMINATE',
            assigneeMemberId: null,
            amountInCents: null,
            cutoffDate: '2026-10-19',
            impactByMember: [],
            originSnapshot: {
                version: 1,
                fingerprint: 'origin-1',
                kind: 'EXPENSE',
                description: 'Casa',
                eligibleRemainingInCents: null,
                futureItems: [],
            },
        };
        expect(
            approved().upsertDestination(destination).snapshot(),
        ).toMatchObject({
            planRevision: 2,
            planStatus: 'DRAFT',
            proposalSnapshot: null,
            hasBilateralApproval: true,
            approvals: [],
            confirmations: [],
        });
    });

    it('rejects a third-party decision, a missing proposal and an inconsistent snapshot', () => {
        expect(() =>
            proposed().decide({
                action: 'APPROVE',
                actorMemberId: 'terceiro',
                now,
                proposalSnapshot: snapshot(),
            }),
        ).toThrow(new SpacesDomainError('CLOSURE_PLAN_DECISION_NOT_ALLOWED'));
        expect(() =>
            plan().decide({
                action: 'APPROVE',
                actorMemberId: first.memberId,
                now,
                proposalSnapshot: snapshot(),
            }),
        ).toThrow(new SpacesDomainError('CLOSURE_PLAN_NOT_PROPOSED'));
        expect(() =>
            plan().decide({
                action: 'PROPOSE',
                actorMemberId: first.memberId,
                now,
                proposalSnapshot: { ...snapshot(), financialBlockerCount: -1 },
            }),
        ).toThrow(new SpacesDomainError('CLOSURE_PROPOSAL_CHANGED'));
        expect(() =>
            plan().decide({
                action: 'PROPOSE',
                actorMemberId: first.memberId,
                now: new Date(now.getTime() - 1),
                proposalSnapshot: snapshot(),
            }),
        ).toThrow('Invalid closure decision time');
    });
});
