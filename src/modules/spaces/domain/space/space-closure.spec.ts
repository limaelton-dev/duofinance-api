import { describe, expect, it } from 'vitest';
import { SpacesDomainError } from '../errors/spaces-domain.error.js';
import { InvitationId } from '../invitation/invitation-id.js';
import { InvitationStatus } from '../invitation/invitation.js';
import { MemberId } from '../member/member-id.js';
import { Member } from '../member/member.js';
import { PersonId } from '../person/person-id.js';
import type {
    ClosureParticipant,
    ClosureProposalSnapshot,
} from './closure-plan.js';
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
    it('starts individual closure with a draft plan and no fabricated consents and invalidates admission', () => {
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

    it('allows the second participant to start and keeps both as required participants', () => {
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

    it('does not reduce the bilateral requirement when history includes a second participant', () => {
        const space = fixture();
        expect(start(space, [first, second]).snapshot().participants).toEqual([
            first,
            second,
        ]);
        expect(space.activeMemberCount).toBe(1);
    });

    it('rejects incomplete history and preserves the space and invitation', () => {
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

    it('rejects individual consent from a member who did not create the space', () => {
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
        'rejects an invalid cutoff before changing the aggregate: %s',
        (cutoffDate) => {
            const space = fixture();
            const before = space.snapshot();
            expect(() => start(space, [first], creator, cutoffDate)).toThrow(
                'Invalid closure plan',
            );
            expect(space.snapshot()).toEqual(before);
        },
    );

    it('rejects an invalid time and a second process attempt without further mutation', () => {
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

    it('rejects a request from a third party or for a personal space', () => {
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

describe('Space closure conclusion', () => {
    const fingerprint = 'a'.repeat(64);
    const snapshot: ClosureProposalSnapshot = {
        financialFingerprint: fingerprint,
        financialBlockerCount: 0,
        outstandingAmounts: [],
        routine: { pendingTaskCount: 0, activeRecurrenceCount: 0 },
        shopping: { activeListCount: 0 },
    };
    const confirmation = {
        now: requestedAt,
        expectedFinancialFingerprint: fingerprint,
        financialFingerprint: fingerprint,
        financiallyReady: true,
        completionPrepared: true,
    };

    it('closes an individual space after explicit confirmation and preserves members and the invalidated invitation', () => {
        const space = fixture();
        const draft = start(space);
        const plan = space.decideClosurePlan(
            creator,
            draft,
            'PROPOSE',
            snapshot,
            requestedAt,
        );
        const version = space.version;
        expect(() =>
            space.confirmClosure(creator, plan, {
                ...confirmation,
                completionPrepared: false,
            }),
        ).toThrow(new SpacesDomainError('CLOSURE_COMPLETION_NOT_PREPARED'));
        expect(space.version).toBe(version);
        expect(
            space.confirmClosure(creator, plan, confirmation).completed,
        ).toBe(true);
        expect(space.status).toBe(SpaceStatus.CLOSED);
        expect(space.type).toBe(SpaceType.SHARED);
        expect(space.members).toHaveLength(1);
        expect(space.invitations[0]).toMatchObject({
            status: 'CANCELLED',
            cancellationReason: 'SPACE_CLOSURE',
            closureProcessId: 'process-1',
        });
        expect(() => space.cancelClosure(creator, plan, requestedAt)).toThrow(
            new SpacesDomainError('CLOSURE_PROCESS_NOT_OPEN'),
        );
        expect(() =>
            space.issueInvitation(
                creator,
                InvitationId.from('invitation-2'),
                requestedAt,
            ),
        ).toThrow(new SpacesDomainError('SPACE_NOT_ACTIVE'));
    });

    it('preserves the invalid link on cancellation and uses a new identity and current participation history for a new closure', () => {
        const space = fixture();
        const originalPlan = start(space);
        expect(
            space.cancelClosure(creator, originalPlan, requestedAt).completed,
        ).toBe(true);
        expect(space.status).toBe(SpaceStatus.ACTIVE);
        const oldInvitation = space.invitations[0];
        expect(() =>
            space.acceptInvitation(
                PersonId.from(second.personId),
                oldInvitation.id,
                MemberId.from(second.memberId),
                requestedAt,
            ),
        ).toThrow(new SpacesDomainError('INVITATION_UNAVAILABLE'));
        const newInvitation = space.issueInvitation(
            creator,
            InvitationId.from('invitation-2'),
            requestedAt,
        );
        space.acceptInvitation(
            PersonId.from(second.personId),
            newInvitation.id,
            MemberId.from(second.memberId),
            requestedAt,
        );
        const newPlan = space
            .startClosure({
                actorPersonId: creator,
                processId: 'process-2',
                participants: [first, second],
                cutoffDate: '2026-10-19',
                now: requestedAt,
            })
            .snapshot();
        expect(newPlan.processId).not.toBe(originalPlan.snapshot().processId);
        expect(newPlan.participants).toEqual([first, second]);
        expect(newPlan.approvals).toEqual([]);
        expect(newPlan.confirmations).toEqual([]);
        expect(space.invitations[0]).toBe(oldInvitation);
        expect(oldInvitation.closureProcessId).toBe('process-1');
    });

    it('does not conclude individual closure when the current root contains a second historical participant', () => {
        const space = fixture();
        const plan = space.decideClosurePlan(
            creator,
            start(space),
            'PROPOSE',
            snapshot,
            requestedAt,
        );
        const props = space.snapshot();
        if (props.type !== SpaceType.SHARED)
            throw new Error('Expected shared fixture');
        const changed = Space.restore({
            ...props,
            members: [
                ...props.members,
                Member.create(
                    MemberId.from(second.memberId),
                    PersonId.from(second.personId),
                    requestedAt,
                ),
            ],
        });
        expect(() =>
            changed.confirmClosure(creator, plan, confirmation),
        ).toThrow(new SpacesDomainError('CLOSURE_PARTICIPANTS_CHANGED'));
        expect(changed.status).toBe(SpaceStatus.CLOSING);
    });
});
