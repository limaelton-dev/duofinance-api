import { describe, expect, it } from 'vitest';
import { SpacesDomainError } from '../errors/spaces-domain.error.js';
import { InvitationId } from '../invitation/invitation-id.js';
import { InvitationStatus } from '../invitation/invitation.js';
import { MemberId } from '../member/member-id.js';
import { Member } from '../member/member.js';
import { PersonId } from '../person/person-id.js';
import type { ClosureParticipant } from './closure-plan.js';
import { SpaceId } from './space-id.js';
import { Space, SpaceStatus, SpaceType } from './space.js';

const createdAt = new Date('2026-10-19T12:00:00.000Z');
const requestedAt = new Date('2026-10-19T13:00:00.000Z');
const creator = PersonId.from('person-1');
const first: ClosureParticipant = {
    memberId: 'member-1',
    personId: creator.value,
    displayName: 'A',
};
const second: ClosureParticipant = {
    memberId: 'member-2',
    personId: 'person-2',
    displayName: 'B',
};

function fixture() {
    return Space.createShared({
        id: SpaceId.from('space-1'),
        name: 'Casa',
        createdByPersonId: creator,
        creatorMemberId: MemberId.from(first.memberId),
        invitationId: InvitationId.from('invitation-1'),
        now: createdAt,
    });
}

function start(
    space: Space,
    participants = [first],
    actorPersonId = creator,
    cutoffDate = '2026-10-19',
    now = requestedAt,
) {
    return space.startClosure({
        actorPersonId,
        processId: 'process-1',
        participants,
        cutoffDate,
        now,
    });
}

describe('Space closure request', () => {
    it('inicia formação individual com plano rascunho, sem consentimentos fictícios, e invalida ingresso', () => {
        const space = fixture();
        const pending = space.invitations[0];
        const participants = [{ ...first }];
        const plan = start(space, participants);
        participants[0].personId = 'outra-pessoa';

        expect(space.status).toBe(SpaceStatus.CLOSING);
        expect(space.version).toBe(2);
        expect(space.members).toHaveLength(1);
        expect(space.invitations[0]).toMatchObject({
            status: InvitationStatus.CANCELLED,
            cancellationReason: 'SPACE_CLOSURE',
            closureProcessId: 'process-1',
            replacedByInvitationId: null,
        });
        expect(plan.snapshot()).toMatchObject({
            participants: [first],
            requestedByMemberId: first.memberId,
            planStatus: 'DRAFT',
            planRevision: 1,
            approvals: [],
            confirmations: [],
        });
        expect(pending.status).toBe(InvitationStatus.PENDING);
        expect(() =>
            space.acceptInvitation(
                PersonId.from(second.personId),
                pending.id,
                MemberId.from(second.memberId),
                requestedAt,
            ),
        ).toThrow(new SpacesDomainError('INVITATION_UNAVAILABLE'));
    });

    it('permite ao segundo participante iniciar e conserva ambos como participantes exigidos', () => {
        const space = fixture();
        space.acceptInvitation(
            PersonId.from(second.personId),
            space.invitations[0].id,
            MemberId.from(second.memberId),
            requestedAt,
        );
        const accepted = space.invitations[0];
        const plan = start(
            space,
            [first, second],
            PersonId.from(second.personId),
        );

        expect(plan.snapshot().participants).toEqual([first, second]);
        expect(plan.snapshot().requestedByMemberId).toBe(second.memberId);
        expect(space.invitations[0]).toBe(accepted);
        expect(space.version).toBe(3);
    });

    it('não reduz a exigência bilateral quando o histórico inclui segunda participação', () => {
        const space = fixture();
        expect(start(space, [first, second]).snapshot().participants).toEqual([
            first,
            second,
        ]);
        expect(space.activeMemberCount).toBe(1);
    });

    it('rejeita histórico incompleto e preserva espaço e convite', () => {
        const space = fixture();
        space.acceptInvitation(
            PersonId.from(second.personId),
            space.invitations[0].id,
            MemberId.from(second.memberId),
            requestedAt,
        );
        const before = space.snapshot();
        expect(() => start(space)).toThrow(
            'Incomplete historical closure participants',
        );
        expect(space.snapshot()).toEqual(before);
    });

    it('recusa consentimento individual de membro que não criou o espaço', () => {
        const props = fixture().snapshot();
        if (props.type !== SpaceType.SHARED)
            throw new Error('Expected shared fixture');
        const space = Space.restore({
            ...props,
            members: [
                Member.create(
                    MemberId.from(second.memberId),
                    PersonId.from(second.personId),
                    createdAt,
                ),
            ],
        });
        const before = space.snapshot();
        expect(() =>
            start(space, [second], PersonId.from(second.personId)),
        ).toThrow(new SpacesDomainError('SPACE_NOT_FOUND'));
        expect(space.snapshot()).toEqual(before);
    });

    it.each(['2026-02-30', '2026-13-01', '19/10/2026'])(
        'recusa corte inválido antes de alterar o agregado: %s',
        (cutoffDate) => {
            const space = fixture();
            const before = space.snapshot();
            expect(() => start(space, [first], creator, cutoffDate)).toThrow(
                'Invalid closure plan',
            );
            expect(space.snapshot()).toEqual(before);
        },
    );

    it('recusa instante inválido e tentativa de segundo processo sem nova mutação', () => {
        const space = fixture();
        expect(() =>
            start(space, [first], creator, '2026-10-19', new Date(Number.NaN)),
        ).toThrow();
        expect(space.status).toBe(SpaceStatus.ACTIVE);
        start(space);
        const before = space.snapshot();
        expect(() => start(space)).toThrow(
            new SpacesDomainError('SPACE_NOT_ACTIVE'),
        );
        expect(space.snapshot()).toEqual(before);
    });

    it('recusa solicitação por terceiro ou no espaço pessoal', () => {
        const space = fixture();
        expect(() => start(space, [first], PersonId.from('terceiro'))).toThrow(
            new SpacesDomainError('SPACE_NOT_FOUND'),
        );
        expect(() =>
            start(
                Space.createPersonal(
                    SpaceId.from('personal'),
                    creator,
                    createdAt,
                ),
            ),
        ).toThrow(new SpacesDomainError('SHARED_SPACE_REQUIRED'));
        expect(space.version).toBe(1);
    });
});
