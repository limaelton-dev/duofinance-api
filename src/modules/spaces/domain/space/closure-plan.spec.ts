import { describe, expect, it } from 'vitest';
import { SpacesDomainError } from '../errors/spaces-domain.error.js';
import { ClosurePlan, type ClosurePlanProps } from './closure-plan.js';

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

describe('ClosurePlan', () => {
    it('registra nova proposta sem tornar o corte futuro vigente e invalida consentimentos antigos', () => {
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

    it('permite retirar uma extensão proposta conservando o corte efetivo', () => {
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
        'rejeita corte inválido ou retroativo: %s',
        (cutoffDate) => {
            const plan = draft();
            const before = plan.snapshot();
            expect(() => plan.proposeCutoff(cutoffDate)).toThrow(
                new SpacesDomainError('CLOSURE_CUTOFF_INVALID'),
            );
            expect(plan.snapshot()).toEqual(before);
        },
    );

    it('protege participantes, aprovações e confirmações de mutação externa', () => {
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

    it('não restaura consentimento de outra pessoa ou de outra revisão', () => {
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
});
