import { describe, expect, it } from 'vitest';
import { SpacesDomainError } from '../errors/spaces-domain.error.js';
import {
    ClosurePlan,
    type ClosureConfirmation,
    type ClosureProposalSnapshot,
} from './closure-plan.js';

const now = new Date('2026-10-19T13:00:00.000Z');
const fingerprint = 'a'.repeat(64);
const changedFingerprint = 'b'.repeat(64);
const first = { memberId: 'member-1', personId: 'person-1', displayName: 'A' };
const second = { memberId: 'member-2', personId: 'person-2', displayName: 'B' };
const snapshot: ClosureProposalSnapshot = {
    financialFingerprint: fingerprint,
    financialBlockerCount: 0,
    outstandingAmounts: [],
    routine: { pendingTaskCount: 0, activeRecurrenceCount: 0 },
    shopping: { activeListCount: 0 },
};

function draft(individual = false) {
    return ClosurePlan.start({
        processId: 'process-1',
        requestedByMemberId: first.memberId,
        participants: individual ? [first] : [first, second],
        startedAt: now.toISOString(),
        cutoffDate: '2026-10-19',
    });
}

function approved(individual = false) {
    const proposal = draft(individual).decide({
        action: 'PROPOSE',
        actorMemberId: first.memberId,
        now,
        proposalSnapshot: snapshot,
    });
    return individual
        ? proposal
        : proposal.decide({
              action: 'APPROVE',
              actorMemberId: second.memberId,
              now,
              proposalSnapshot: snapshot,
          });
}

function confirmation(
    actorMemberId: string,
    overrides: Partial<ClosureConfirmation> = {},
): ClosureConfirmation {
    return {
        actorMemberId,
        now,
        expectedFinancialFingerprint: fingerprint,
        financialFingerprint: fingerprint,
        financiallyReady: true,
        completionPrepared: true,
        ...overrides,
    };
}

describe('ClosurePlan confirmation and cancellation', () => {
    it('exige duas confirmações distintas e atuais no bilateral sem modificar o plano anterior', () => {
        const plan = approved();
        const firstConfirmation = plan.confirm(
            confirmation(first.memberId, { completionPrepared: false }),
        );
        expect(firstConfirmation.completed).toBe(false);
        expect(firstConfirmation.plan.snapshot().confirmations).toEqual([
            {
                memberId: first.memberId,
                planRevision: 1,
                financialFingerprint: fingerprint,
                recordedAt: now.toISOString(),
            },
        ]);
        expect(() =>
            firstConfirmation.plan.confirm(confirmation(first.memberId)),
        ).toThrow(new SpacesDomainError('CLOSURE_ALREADY_CONFIRMED'));
        expect(
            firstConfirmation.plan.confirm(confirmation(second.memberId))
                .completed,
        ).toBe(true);
        expect(plan.snapshot().confirmations).toEqual([]);
    });

    it('substitui confirmações obsoletas quando muda o estado financeiro validado', () => {
        const firstConfirmation = approved().confirm(
            confirmation(first.memberId),
        );
        const changed = firstConfirmation.plan.confirm(
            confirmation(second.memberId, {
                expectedFinancialFingerprint: changedFingerprint,
                financialFingerprint: changedFingerprint,
                completionPrepared: false,
            }),
        );
        expect(changed.completed).toBe(false);
        expect(changed.plan.snapshot().confirmations).toMatchObject([
            {
                memberId: second.memberId,
                financialFingerprint: changedFingerprint,
            },
        ]);
        expect(
            changed.plan.confirm(
                confirmation(first.memberId, {
                    expectedFinancialFingerprint: changedFingerprint,
                    financialFingerprint: changedFingerprint,
                }),
            ).completed,
        ).toBe(true);
    });

    it('recusa pendências, plano sem aprovação e fingerprint de resumo antigo', () => {
        expect(() => draft().confirm(confirmation(first.memberId))).toThrow(
            new SpacesDomainError('CLOSURE_CONFIRMATION_NOT_READY'),
        );
        const plan = approved();
        expect(() =>
            plan.confirm(
                confirmation(first.memberId, { financiallyReady: false }),
            ),
        ).toThrow(new SpacesDomainError('CLOSURE_CONFIRMATION_NOT_READY'));
        expect(() =>
            plan.confirm(
                confirmation(first.memberId, {
                    expectedFinancialFingerprint: changedFingerprint,
                }),
            ),
        ).toThrow(new SpacesDomainError('CLOSURE_FINANCIAL_STATE_CHANGED'));
        expect(() =>
            plan.confirm(
                confirmation(first.memberId, {
                    expectedFinancialFingerprint: 'inválido',
                    financialFingerprint: 'inválido',
                }),
            ),
        ).toThrow(new SpacesDomainError('CLOSURE_FINANCIAL_STATE_CHANGED'));
        expect(plan.snapshot().confirmations).toEqual([]);
    });

    it('uma confirmação individual conclui somente quando os contextos foram preparados atomicamente', () => {
        const plan = approved(true);
        expect(() =>
            plan.confirm(
                confirmation(first.memberId, { completionPrepared: false }),
            ),
        ).toThrow(new SpacesDomainError('CLOSURE_COMPLETION_NOT_PREPARED'));
        expect(plan.snapshot().confirmations).toEqual([]);
        const result = plan.confirm(confirmation(first.memberId));
        expect(result.completed).toBe(true);
        expect(result.plan.snapshot().confirmations).toHaveLength(1);
    });

    it('só o solicitante cancela unilateralmente antes do consentimento do outro', () => {
        for (const plan of [
            draft(),
            draft().decide({
                action: 'PROPOSE',
                actorMemberId: first.memberId,
                now,
                proposalSnapshot: snapshot,
            }),
        ]) {
            expect(() =>
                plan.cancel({
                    actorMemberId: second.memberId,
                    now,
                    spaceVersion: 10,
                }),
            ).toThrow(
                new SpacesDomainError('CLOSURE_CANCELLATION_NOT_ALLOWED'),
            );
            expect(
                plan.cancel({
                    actorMemberId: first.memberId,
                    now,
                    spaceVersion: 10,
                }).completed,
            ).toBe(true);
        }
        expect(
            approved(true).cancel({
                actorMemberId: first.memberId,
                now,
                spaceVersion: 10,
            }).completed,
        ).toBe(true);
    });

    it('o consentimento do outro como primeiro proponente também impede cancelamento unilateral', () => {
        const proposal = draft().decide({
            action: 'PROPOSE',
            actorMemberId: second.memberId,
            now,
            proposalSnapshot: snapshot,
        });
        const request = proposal.cancel({
            actorMemberId: first.memberId,
            now,
            spaceVersion: 10,
        });
        expect(request.completed).toBe(false);
        expect(
            request.plan.cancel({
                actorMemberId: second.memberId,
                now,
                spaceVersion: 11,
            }).completed,
        ).toBe(true);
        const reviewed = proposal.proposeCutoff('2026-11-01');
        expect(reviewed.snapshot().hasBilateralApproval).toBe(false);
        expect(
            reviewed.cancel({
                actorMemberId: first.memberId,
                now,
                spaceVersion: 12,
            }).completed,
        ).toBe(true);
    });

    it('mantém exigência bilateral após invalidar a aprovação e vincula cancelamentos ao mesmo estado', () => {
        const reviewed = approved().proposeCutoff('2026-11-01');
        const firstCancellation = reviewed.cancel({
            actorMemberId: first.memberId,
            now,
            spaceVersion: 10,
        });
        expect(firstCancellation.completed).toBe(false);
        expect(firstCancellation.plan.snapshot()).toMatchObject({
            hasBilateralApproval: true,
            confirmations: [],
            cancellationConsents: [
                { memberId: first.memberId, spaceVersion: 11 },
            ],
        });
        expect(() =>
            firstCancellation.plan.cancel({
                actorMemberId: first.memberId,
                now,
                spaceVersion: 11,
            }),
        ).toThrow(
            new SpacesDomainError('CLOSURE_ALREADY_REQUESTED_CANCELLATION'),
        );
        const obsolete = firstCancellation.plan.cancel({
            actorMemberId: second.memberId,
            now,
            spaceVersion: 12,
        });
        expect(obsolete.completed).toBe(false);
        expect(obsolete.plan.snapshot().cancellationConsents).toMatchObject([
            { memberId: second.memberId, spaceVersion: 13 },
        ]);
        const result = firstCancellation.plan.cancel({
            actorMemberId: second.memberId,
            now,
            spaceVersion: 11,
        });
        expect(result.completed).toBe(true);
        expect(result.plan.snapshot()).toMatchObject({
            approvals: [],
            confirmations: [],
            proposalSnapshot: null,
            planStatus: 'DRAFT',
            hasBilateralApproval: true,
        });
    });

    it('pedido bilateral de cancelamento invalida confirmações e exige retomada explícita do plano', () => {
        const confirmed = approved().confirm(confirmation(first.memberId)).plan;
        const cancellation = confirmed.cancel({
            actorMemberId: second.memberId,
            now,
            spaceVersion: 10,
        }).plan;
        expect(cancellation.snapshot().confirmations).toEqual([]);
        expect(() =>
            cancellation.confirm(confirmation(first.memberId)),
        ).toThrow(new SpacesDomainError('CLOSURE_CANCELLATION_PENDING'));
        const resumed = cancellation.decide({
            action: 'PROPOSE',
            actorMemberId: first.memberId,
            now,
            proposalSnapshot: snapshot,
        });
        expect(resumed.snapshot()).toMatchObject({
            planRevision: 2,
            planStatus: 'PROPOSED',
            cancellationConsents: [],
            hasBilateralApproval: true,
        });
    });

    it('recusa terceiro e preserva escolha financeira ao cancelar o processo', () => {
        const plan = approved(true);
        expect(() => plan.confirm(confirmation('convidado'))).toThrow(
            new SpacesDomainError('SPACE_NOT_FOUND'),
        );
        expect(() =>
            plan.cancel({ actorMemberId: 'convidado', now, spaceVersion: 10 }),
        ).toThrow(new SpacesDomainError('SPACE_NOT_FOUND'));
        const withDestination = ClosurePlan.restore({
            ...plan.snapshot(),
            futureDestinations: [
                {
                    originType: 'RECURRING',
                    originId: 'origin-1',
                    expectedOriginVersion: 1,
                    destination: 'PERSONAL_SUCCESSOR',
                    assigneeMemberId: first.memberId,
                    amountInCents: null,
                    cutoffDate: '2026-10-19',
                    impactByMember: [],
                    originSnapshot: {
                        version: 1,
                        fingerprint: 'source',
                        kind: 'EXPENSE',
                        description: 'Casa',
                        eligibleRemainingInCents: null,
                        futureItems: [],
                    },
                },
            ],
        });
        expect(
            withDestination
                .cancel({
                    actorMemberId: first.memberId,
                    now,
                    spaceVersion: 10,
                })
                .plan.snapshot().futureDestinations,
        ).toEqual(withDestination.snapshot().futureDestinations);
    });
});
