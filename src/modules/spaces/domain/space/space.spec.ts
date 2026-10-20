import { describe, expect, it } from 'vitest';
import { SpacesDomainError } from '../errors/spaces-domain.error.js';
import { InvitationId } from '../invitation/invitation-id.js';
import { Invitation, InvitationStatus } from '../invitation/invitation.js';
import { MemberId } from '../member/member-id.js';
import { Member, MemberStatus } from '../member/member.js';
import { PersonId } from '../person/person-id.js';
import { SpaceId } from './space-id.js';
import {
    Space,
    SpaceStatus,
    SpaceType,
    type SharedSpaceProps,
} from './space.js';

const issuedAt = new Date('2026-09-27T12:00:00.000Z');
const expiresAt = new Date('2026-09-30T12:00:00.000Z');

function fixture(name = 'Casa') {
    const creatorId = PersonId.create();
    const memberId = MemberId.create();
    const invitationId = InvitationId.create();
    const space = Space.createShared({
        id: SpaceId.create(),
        name,
        createdByPersonId: creatorId,
        creatorMemberId: memberId,
        invitationId,
        now: issuedAt,
    });

    return { space, creatorId, memberId, invitationId };
}

function sharedProps(space: Space): SharedSpaceProps {
    const props = space.snapshot();

    if (props.type !== SpaceType.SHARED) {
        throw new Error('Expected shared fixture');
    }

    return props;
}

function resolvedInvitation(
    invitation: Invitation,
    status:
        | InvitationStatus.ACCEPTED
        | InvitationStatus.REJECTED
        | InvitationStatus.CANCELLED
        | InvitationStatus.EXPIRED,
): Invitation {
    return Invitation.restore({
        id: invitation.id,
        invitedByPersonId: invitation.invitedByPersonId,
        status,
        issuedAt: invitation.issuedAt,
        expiresAt: invitation.expiresAt,
        resolvedAt:
            status === InvitationStatus.EXPIRED
                ? invitation.expiresAt
                : new Date(issuedAt.getTime() + 1000),
        cancellationReason:
            status === InvitationStatus.CANCELLED ? 'REPLACED' : null,
        replacedByInvitationId:
            status === InvitationStatus.CANCELLED
                ? InvitationId.create()
                : null,
    });
}

describe('Space: personal space', () => {
    it('preserves creation time, owner and initial version', () => {
        const id = SpaceId.create();
        const owner = PersonId.create();
        const space = Space.createPersonal(id, owner);

        expect(space.id).toBe(id);
        expect(space.type).toBe(SpaceType.PERSONAL);
        expect(space.status).toBe(SpaceStatus.ACTIVE);
        expect(space.personalOwnerPersonId).toBe(owner);
        expect(space.version).toBe(1);
        expect(space.createdAt).toEqual(space.updatedAt);
        expect(space.members).toEqual([]);
        expect(space.invitations).toEqual([]);
        expect(space.name).toBeNull();
        expect(space.createdByPersonId).toBeNull();
    });

    it.each([null, undefined])('rejects a missing owner: %s', (owner) => {
        expect(() =>
            Space.createPersonal(
                SpaceId.create(),
                owner as unknown as PersonId,
            ),
        ).toThrow('Personal space requires an owner');
    });

    it('does not allow a shared invitation in a personal space', () => {
        const owner = PersonId.create();
        const space = Space.createPersonal(SpaceId.create(), owner);

        expect(() =>
            space.issueInvitation(owner, InvitationId.create(), issuedAt),
        ).toThrow(new SpacesDomainError('SPACE_NOT_FOUND'));
    });
});

describe('Space: shared creation', () => {
    it('creates the space, member and invitation together', () => {
        const { space, creatorId, memberId, invitationId } =
            fixture('  Casa  Lima  ');

        expect(space.type).toBe(SpaceType.SHARED);
        expect(space.status).toBe(SpaceStatus.ACTIVE);
        expect(space.name).toBe('Casa  Lima');
        expect(space.personalOwnerPersonId).toBeNull();
        expect(space.createdByPersonId).toBe(creatorId);
        expect(space.version).toBe(1);
        expect(space.activeMemberCount).toBe(1);
        expect(space.members[0].id).toBe(memberId);
        expect(space.members[0].personId).toBe(creatorId);
        expect(space.members[0].status).toBe(MemberStatus.ACTIVE);
        expect(space.members[0].joinedAt).toEqual(issuedAt);
        expect(space.invitations[0].id).toBe(invitationId);
        expect(space.invitations[0].invitedByPersonId).toBe(creatorId);
        expect(space.invitations[0].status).toBe(InvitationStatus.PENDING);
        expect(space.invitations[0].expiresAt).toEqual(expiresAt);
    });

    it.each([
        '',
        '   ',
        'A'.repeat(81),
        'Ca\u0000sa',
        'Ca\nsa',
        'Ca\u007fsa',
        'Ca\u0085sa',
        '😀'.repeat(41),
    ])('rejects an invalid name: %j', (name) => {
        expect(() => fixture(name)).toThrow(
            new SpacesDomainError('VALIDATION_ERROR'),
        );
    });

    it.each(['A', 'A'.repeat(80), '😀'.repeat(40)])(
        'accepts UTF-16 boundaries: %s',
        (name) => {
            expect(fixture(name).space.name).toBe(name);
        },
    );

    it('allows duplicate names and multiple spaces for the same person', () => {
        const first = fixture();
        const second = Space.createShared({
            id: SpaceId.create(),
            name: 'Casa',
            createdByPersonId: first.creatorId,
            creatorMemberId: MemberId.create(),
            invitationId: InvitationId.create(),
            now: issuedAt,
        });

        expect(second.name).toBe(first.space.name);
        expect(second.id.equals(first.space.id)).toBe(false);
    });

    it('rejects a duplicate active person', () => {
        const { space, creatorId } = fixture();

        expect(() =>
            Space.restore({
                ...sharedProps(space),
                members: [
                    ...space.members,
                    Member.create(MemberId.create(), creatorId, issuedAt),
                ],
            }),
        ).toThrow('Inconsistent shared space children');
    });

    it('rejects a duplicate member identity', () => {
        const { space, memberId } = fixture();

        expect(() =>
            Space.restore({
                ...sharedProps(space),
                members: [
                    ...space.members,
                    Member.create(memberId, PersonId.create(), issuedAt),
                ],
            }),
        ).toThrow('Inconsistent shared space children');
    });

    it('rejects a third active member', () => {
        const { space } = fixture();

        expect(() =>
            Space.restore({
                ...sharedProps(space),
                members: [
                    ...space.members,
                    Member.create(
                        MemberId.create(),
                        PersonId.create(),
                        issuedAt,
                    ),
                    Member.create(
                        MemberId.create(),
                        PersonId.create(),
                        issuedAt,
                    ),
                ],
            }),
        ).toThrow(new SpacesDomainError('SPACE_MEMBER_LIMIT_REACHED'));
    });

    it('rejects two invitations persisted as PENDING', () => {
        const { space, creatorId } = fixture();

        expect(() =>
            Space.restore({
                ...sharedProps(space),
                invitations: [
                    ...space.invitations,
                    Invitation.issue(
                        InvitationId.create(),
                        creatorId,
                        issuedAt,
                    ),
                ],
            }),
        ).toThrow('Inconsistent shared space children');
    });
});

describe('Space: validity and issuance', () => {
    it.each([
        [-1, InvitationStatus.PENDING],
        [0, InvitationStatus.EXPIRED],
        [1, InvitationStatus.EXPIRED],
    ])('evaluates the expiration boundary: %i ms', (offset, status) => {
        const { space } = fixture();
        const invitation = space.invitations[0];

        expect(
            invitation.statusAt(new Date(expiresAt.getTime() + offset)),
        ).toBe(status);
        expect(invitation.status).toBe(InvitationStatus.PENDING);
        expect(invitation.resolvedAt).toBeNull();
        expect(space.version).toBe(1);
    });

    it('blocks normal issuance while a valid pending invitation exists', () => {
        const { space, creatorId } = fixture();

        expect(() =>
            space.issueInvitation(
                creatorId,
                InvitationId.create(),
                new Date(expiresAt.getTime() - 1),
            ),
        ).toThrow(new SpacesDomainError('INVITATION_ALREADY_PENDING'));

        expect(space.version).toBe(1);
        expect(space.invitations).toHaveLength(1);
    });

    it('normalizes the expired invitation and issues another at the exact instant', () => {
        const { space, creatorId, invitationId } = fixture();
        const next = space.issueInvitation(
            creatorId,
            InvitationId.create(),
            expiresAt,
        );

        expect(space.invitations).toHaveLength(2);
        expect(space.invitations[0].id).toBe(invitationId);
        expect(space.invitations[0].status).toBe(InvitationStatus.EXPIRED);
        expect(space.invitations[0].resolvedAt).toEqual(expiresAt);
        expect(next.status).toBe(InvitationStatus.PENDING);
        expect(next.expiresAt).toEqual(new Date('2026-10-03T12:00:00.000Z'));
        expect(space.version).toBe(2);
        expect(space.updatedAt).toEqual(expiresAt);
    });

    it('allows a new invitation after rejection', () => {
        const { space, creatorId } = fixture();
        const restored = Space.restore({
            ...sharedProps(space),
            invitations: [
                resolvedInvitation(
                    space.invitations[0],
                    InvitationStatus.REJECTED,
                ),
            ],
        });

        restored.issueInvitation(
            creatorId,
            InvitationId.create(),
            new Date(issuedAt.getTime() + 2000),
        );

        expect(restored.invitations[0].status).toBe(InvitationStatus.REJECTED);
        expect(restored.invitations[1].status).toBe(InvitationStatus.PENDING);
        expect(restored.version).toBe(2);
    });

    it('does not expire the previous invitation if the new identity is invalid', () => {
        const { space, creatorId, invitationId } = fixture();

        expect(() =>
            space.issueInvitation(creatorId, invitationId, expiresAt),
        ).toThrow('Invitation identity must be new');

        expect(space.invitations[0].status).toBe(InvitationStatus.PENDING);
        expect(space.version).toBe(1);
    });
});

describe('Space: replacement', () => {
    it('cancels the previous invitation, links the new one and restarts the 72 hours', () => {
        const { space, creatorId, invitationId } = fixture();
        const nextId = InvitationId.create();
        const now = new Date('2026-09-28T12:00:00.000Z');

        const next = space.replaceInvitation(
            creatorId,
            invitationId,
            nextId,
            now,
        );

        expect(space.invitations).toHaveLength(2);
        expect(space.invitations[0].status).toBe(InvitationStatus.CANCELLED);
        expect(space.invitations[0].cancellationReason).toBe('REPLACED');
        expect(space.invitations[0].replacedByInvitationId).toBe(nextId);
        expect(space.invitations[0].resolvedAt).toEqual(now);
        expect(next.status).toBe(InvitationStatus.PENDING);
        expect(next.expiresAt).toEqual(new Date('2026-10-01T12:00:00.000Z'));
        expect(space.version).toBe(2);
        expect(space.updatedAt).toEqual(now);
    });

    it('rejects replacement at the expiration instant', () => {
        const { space, creatorId, invitationId } = fixture();

        expect(() =>
            space.replaceInvitation(
                creatorId,
                invitationId,
                InvitationId.create(),
                expiresAt,
            ),
        ).toThrow(new SpacesDomainError('INVITATION_NOT_REPLACEABLE'));

        expect(space.version).toBe(1);
    });

    it.each([
        InvitationStatus.ACCEPTED,
        InvitationStatus.REJECTED,
        InvitationStatus.CANCELLED,
        InvitationStatus.EXPIRED,
    ] as const)('does not replace a %s invitation', (status) => {
        const { space, creatorId, invitationId } = fixture();
        const restored = Space.restore({
            ...sharedProps(space),
            invitations: [resolvedInvitation(space.invitations[0], status)],
        });

        expect(() =>
            restored.replaceInvitation(
                creatorId,
                invitationId,
                InvitationId.create(),
                expiresAt,
            ),
        ).toThrow(new SpacesDomainError('INVITATION_NOT_REPLACEABLE'));
    });

    it('rejects an identity outside the aggregate', () => {
        const { space, creatorId } = fixture();

        expect(() =>
            space.replaceInvitation(
                creatorId,
                InvitationId.create(),
                InvitationId.create(),
                issuedAt,
            ),
        ).toThrow(new SpacesDomainError('INVITATION_NOT_REPLACEABLE'));
    });

    it('preserves the previous invitation when replacement is invalid', () => {
        const { space, creatorId, invitationId } = fixture();

        expect(() =>
            space.replaceInvitation(
                creatorId,
                invitationId,
                invitationId,
                issuedAt,
            ),
        ).toThrow('Invitation identity must be new');

        expect(space.invitations).toHaveLength(1);
        expect(space.invitations[0].status).toBe(InvitationStatus.PENDING);
        expect(space.invitations[0].replacedByInvitationId).toBeNull();
        expect(space.version).toBe(1);
    });
});

describe('Space: authorization and availability', () => {
    it.each(['issue', 'replace'] as const)(
        'protects issuance and replacement: %s',
        (operation) => {
            const { space, creatorId, invitationId } = fixture();

            const execute = (target: Space, actor: PersonId) => {
                if (operation === 'issue') {
                    return target.issueInvitation(
                        actor,
                        InvitationId.create(),
                        issuedAt,
                    );
                }

                return target.replaceInvitation(
                    actor,
                    invitationId,
                    InvitationId.create(),
                    issuedAt,
                );
            };

            expect(() => execute(space, PersonId.create())).toThrow(
                new SpacesDomainError('SPACE_NOT_FOUND'),
            );

            const otherPerson = PersonId.create();
            const fullSpace = Space.restore({
                ...sharedProps(space),
                members: [
                    ...space.members,
                    Member.create(MemberId.create(), otherPerson, issuedAt),
                ],
            });

            expect(() => execute(fullSpace, otherPerson)).toThrow(
                new SpacesDomainError('INVITATION_ISSUER_REQUIRED'),
            );
            expect(() => execute(fullSpace, creatorId)).toThrow(
                new SpacesDomainError('SPACE_MEMBER_LIMIT_REACHED'),
            );

            for (const status of [SpaceStatus.CLOSING, SpaceStatus.CLOSED]) {
                const inactiveSpace = Space.restore({
                    ...sharedProps(space),
                    status,
                });

                expect(() => execute(inactiveSpace, creatorId)).toThrow(
                    new SpacesDomainError('SPACE_NOT_ACTIVE'),
                );
            }

            const withoutCreatorMembership = Space.restore({
                ...sharedProps(space),
                members: [
                    Member.create(MemberId.create(), otherPerson, issuedAt),
                ],
            });

            expect(() => execute(withoutCreatorMembership, creatorId)).toThrow(
                new SpacesDomainError('SPACE_NOT_FOUND'),
            );

            expect(space.version).toBe(1);
            expect(fullSpace.version).toBe(1);
        },
    );
});

describe('Space: internal state protection', () => {
    it('does not expose mutable arrays or dates from the aggregate', () => {
        const { space } = fixture();
        const props = sharedProps(space);
        const members = [...space.members];

        members.pop();
        props.createdAt.setUTCFullYear(2000);
        space.createdAt.setUTCFullYear(2000);
        space.members[0].joinedAt.setUTCFullYear(2000);
        space.invitations[0].expiresAt.setUTCFullYear(2000);

        expect(space.members).toHaveLength(1);
        expect(space.createdAt).toEqual(issuedAt);
        expect(space.members[0].joinedAt).toEqual(issuedAt);
        expect(space.invitations[0].expiresAt).toEqual(expiresAt);
    });

    it('copies arrays received during restoration', () => {
        const { space } = fixture();
        const members = [...space.members];
        const invitations = [...space.invitations];
        const restored = Space.restore({
            ...sharedProps(space),
            members,
            invitations,
        });

        members.pop();
        invitations.pop();

        expect(restored.members).toHaveLength(1);
        expect(restored.invitations).toHaveLength(1);
    });

    it('does not modify the root through an isolated child transition', () => {
        const { space } = fixture();
        const original = space.invitations[0];
        const cancelled = original.replaceWith(InvitationId.create(), issuedAt);

        expect(cancelled.status).toBe(InvitationStatus.CANCELLED);
        expect(space.invitations[0].status).toBe(InvitationStatus.PENDING);
        expect(space.version).toBe(1);
    });
});

describe('Internal identities', () => {
    it('restores and compares MemberId', () => {
        const id = MemberId.create();

        expect(MemberId.from(id.value).equals(id)).toBe(true);
        expect(MemberId.create().equals(id)).toBe(false);
        expect(() => MemberId.from('')).toThrow('MemberId cannot be empty');
    });

    it('restores and compares InvitationId', () => {
        const id = InvitationId.create();

        expect(InvitationId.from(id.value).equals(id)).toBe(true);
        expect(InvitationId.create().equals(id)).toBe(false);
        expect(() => InvitationId.from('')).toThrow(
            'InvitationId cannot be empty',
        );
    });
});
