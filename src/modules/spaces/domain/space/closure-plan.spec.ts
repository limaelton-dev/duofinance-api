import { describe, expect, it } from 'vitest';
import { SpacesDomainError } from '../errors/spaces-domain.error.js';
import {
    ClosurePlan,
    type ClosurePlanProps,
    type ClosureFutureDestination,
} from './closure-plan.js';

function draft() {
    return ClosurePlan.start({
        processId: 'process-1',
        requestedByMemberId: 'member-1',
        participants: [
            { memberId: 'member-1', personId: 'person-1', displayName: 'A' },
        ],
        startedAt: '2026-10-19T13:00:00.000Z',
        cutoffDate: '2026-10-19',
    });
}

function destination(): ClosureFutureDestination {
    return {
        originType: 'RECURRING',
        originId: 'origin-1',
        expectedOriginVersion: 1,
        destination: 'PERSONAL_SUCCESSOR',
        assigneeMemberId: 'member-1',
        amountInCents: null,
        cutoffDate: '2026-10-19',
        impactByMember: [
            {
                memberId: 'member-1',
                beforeInCents: '10000',
                afterInCents: '10000',
                requiresAcceptance: true,
            },
        ],
        originSnapshot: {
            version: 1,
            fingerprint: 'fingerprint-1',
            kind: 'EXPENSE',
            description: 'Moradia',
            eligibleRemainingInCents: '10000',
            futureItems: [
                {
                    originItemId: null,
                    referenceDate: '2026-11-01',
                    remainingInCents: 10000,
                    version: null,
                },
            ],
        },
    };
}

describe('ClosurePlan', () => {
    it('records a new proposal without activating the future cutoff and invalidates prior consents', () => {
        const approved = ClosurePlan.restore({
            ...draft().snapshot(),
            planStatus: 'APPROVED',
            approvals: [
                {
                    memberId: 'member-1',
                    planRevision: 1,
                    recordedAt: '2026-10-19T13:01:00.000Z',
                },
            ],
            confirmations: [
                {
                    memberId: 'member-1',
                    planRevision: 1,
                    recordedAt: '2026-10-19T13:02:00.000Z',
                },
            ],
        });
        const revised = approved.proposeCutoff('2026-11-01').snapshot();

        expect(revised).toMatchObject({
            cutoffDate: '2026-10-19',
            proposedCutoffDate: '2026-11-01',
            planRevision: 2,
            planStatus: 'DRAFT',
            approvals: [],
            confirmations: [],
        });
        expect(approved.snapshot()).toMatchObject({
            planRevision: 1,
            planStatus: 'APPROVED',
            proposedCutoffDate: null,
        });
        expect(approved.snapshot().approvals).toHaveLength(1);
    });

    it('allows withdrawal of a proposed extension while preserving the effective cutoff', () => {
        const future = draft().proposeCutoff('2026-11-01');
        expect(future.proposeCutoff('2026-10-19').snapshot()).toMatchObject({
            cutoffDate: '2026-10-19',
            proposedCutoffDate: null,
            planRevision: 3,
        });
        expect(() => future.proposeCutoff('2026-11-01')).toThrow(
            new SpacesDomainError('CLOSURE_PLAN_UNCHANGED'),
        );
    });

    it.each(['2026-02-30', '2026-13-01', '19/10/2026', '2026-10-18', ''])(
        'rejects an invalid or retroactive cutoff: %s',
        (cutoffDate) => {
            const plan = draft();
            const before = plan.snapshot();
            expect(() => plan.proposeCutoff(cutoffDate)).toThrow(
                new SpacesDomainError('CLOSURE_CUTOFF_INVALID'),
            );
            expect(plan.snapshot()).toEqual(before);
        },
    );

    it('protects participants, approvals and confirmations from external mutation', () => {
        const input: ClosurePlanProps = {
            ...draft().snapshot(),
            planStatus: 'APPROVED',
            approvals: [
                {
                    memberId: 'member-1',
                    planRevision: 1,
                    recordedAt: '2026-10-19T13:01:00.000Z',
                },
            ],
            confirmations: [
                {
                    memberId: 'member-1',
                    planRevision: 1,
                    recordedAt: '2026-10-19T13:02:00.000Z',
                },
            ],
        };
        const plan = ClosurePlan.restore(input);
        input.participants[0].displayName = 'Alterado';
        input.approvals.length = 0;
        const exposed = plan.snapshot();
        exposed.participants.length = 0;
        exposed.confirmations[0].memberId = 'outra-pessoa';

        expect(plan.snapshot().participants[0].displayName).toBe('A');
        expect(plan.snapshot().approvals).toHaveLength(1);
        expect(plan.snapshot().confirmations[0].memberId).toBe('member-1');
    });

    it('does not restore consent from another person or revision', () => {
        for (const consent of [
            {
                memberId: 'member-2',
                planRevision: 1,
                recordedAt: '2026-10-19T13:01:00.000Z',
            },
            {
                memberId: 'member-1',
                planRevision: 2,
                recordedAt: '2026-10-19T13:01:00.000Z',
            },
        ]) {
            expect(() =>
                ClosurePlan.restore({
                    ...draft().snapshot(),
                    approvals: [consent],
                }),
            ).toThrow('Invalid closure plan');
        }
    });

    it('records a choice for each origin and revises materially without preserving prior acceptance', () => {
        const consent = {
            memberId: 'member-1',
            planRevision: 1,
            recordedAt: '2026-10-19T13:01:00.000Z',
        };
        const approved = ClosurePlan.restore({
            ...draft().snapshot(),
            planStatus: 'APPROVED',
            approvals: [consent],
            confirmations: [consent],
        });
        const input = destination();
        const changed = approved.upsertDestination(input);
        input.originSnapshot.futureItems[0].remainingInCents = 1;
        const exposed = changed.snapshot();
        exposed.futureDestinations[0].impactByMember[0].afterInCents = '1';

        expect(changed.snapshot()).toMatchObject({
            planRevision: 2,
            planStatus: 'DRAFT',
            approvals: [],
            confirmations: [],
            futureDestinations: [destination()],
        });
        expect(approved.snapshot().futureDestinations).toEqual([]);
        expect(approved.snapshot().planStatus).toBe('APPROVED');
    });

    it('replaces the decision for the same origin and preserves other origins', () => {
        const first = draft().upsertDestination(destination());
        const second = first.upsertDestination({
            ...destination(),
            originType: 'INSTALLMENT',
            originId: 'origin-2',
        });
        const changed = second.upsertDestination({
            ...destination(),
            destination: 'TERMINATE',
            assigneeMemberId: null,
        });

        expect(changed.snapshot().futureDestinations).toHaveLength(2);
        expect(
            changed
                .snapshot()
                .futureDestinations.find((item) => item.originId === 'origin-1')
                ?.destination,
        ).toBe('TERMINATE');
        expect(changed.snapshot().planRevision).toBe(4);
        expect(first.snapshot().futureDestinations[0].destination).toBe(
            'PERSONAL_SUCCESSOR',
        );
    });

    it('rejects an invited member, a mismatched snapshot version and an invalid amount', () => {
        for (const invalid of [
            { ...destination(), assigneeMemberId: 'convidado' },
            { ...destination(), expectedOriginVersion: 2 },
            { ...destination(), destination: 'TERMINATE' as const },
            {
                ...destination(),
                destination: 'SETTLE_BEFORE_CLOSURE' as const,
                assigneeMemberId: null,
                amountInCents: 0,
            },
            {
                ...destination(),
                destination: 'SETTLE_BEFORE_CLOSURE' as const,
                assigneeMemberId: null,
                amountInCents: Number.MAX_SAFE_INTEGER + 1,
            },
        ]) {
            const plan = draft();
            expect(() => plan.upsertDestination(invalid)).toThrow(
                new SpacesDomainError('CLOSURE_DESTINATION_INVALID'),
            );
            expect(plan.snapshot().futureDestinations).toEqual([]);
            expect(plan.snapshot().planRevision).toBe(1);
        }
    });

    it('does not create a revision for a change only in persisted property order', () => {
        const original = destination();
        const plan = draft().upsertDestination(original);
        const reordered = Object.fromEntries(
            Object.entries(destination()).reverse(),
        ) as ClosureFutureDestination;
        expect(() => plan.upsertDestination(reordered)).toThrow(
            new SpacesDomainError('CLOSURE_PLAN_UNCHANGED'),
        );
        expect(plan.snapshot().planRevision).toBe(2);
    });

    it('binds an explicit agreement only to two actual participants', () => {
        const plan = ClosurePlan.restore({
            ...draft().snapshot(),
            participants: [
                ...draft().snapshot().participants,
                {
                    memberId: 'member-2',
                    personId: 'person-2',
                    displayName: 'B',
                },
            ],
        });
        const agreement: ClosureFutureDestination = {
            ...destination(),
            destination: 'SETTLE_BEFORE_CLOSURE',
            assigneeMemberId: 'member-1',
            amountInCents: 5000,
            agreement: {
                debtorMemberId: 'member-2',
                creditorMemberId: 'member-1',
                amountInCents: 5000,
            },
        };
        expect(
            plan.upsertDestination(agreement).snapshot().futureDestinations[0]
                .agreement,
        ).toEqual(agreement.agreement);
        expect(() => draft().upsertDestination(agreement)).toThrow(
            new SpacesDomainError('CLOSURE_DESTINATION_INVALID'),
        );
    });

    it('preserves the prior choice when revising the cutoff and requires a fresh current cutoff preview to edit the destination', () => {
        const previous = draft().upsertDestination(destination());
        const revised = previous.proposeCutoff('2026-11-01');
        expect(revised.snapshot().futureDestinations[0].cutoffDate).toBe(
            '2026-10-19',
        );
        expect(() => revised.upsertDestination(destination())).toThrow(
            new SpacesDomainError('CLOSURE_DESTINATION_INVALID'),
        );
        expect(
            revised
                .upsertDestination({
                    ...destination(),
                    cutoffDate: '2026-11-01',
                })
                .snapshot(),
        ).toMatchObject({
            planRevision: 4,
            futureDestinations: [{ cutoffDate: '2026-11-01' }],
        });
    });
});
