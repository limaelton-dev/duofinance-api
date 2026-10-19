import { InvitationId } from '../../domain/invitation/invitation-id.js';
import {
    Invitation,
    InvitationStatus,
} from '../../domain/invitation/invitation.js';
import { MemberId } from '../../domain/member/member-id.js';
import { Member, MemberStatus } from '../../domain/member/member.js';
import { PersonId } from '../../domain/person/person-id.js';
import { SpaceId } from '../../domain/space/space-id.js';
import { Space, SpaceStatus, SpaceType } from '../../domain/space/space.js';
import { SpaceOrmEntity } from '../typeorm/entities/space.orm-entity.js';
import { SpaceInvitationOrmEntity } from '../typeorm/entities/space-invitation.orm-entity.js';

function readEnum<T extends string>(value: string, values: readonly T[]): T {
    const result = values.find((candidate) => candidate === value);

    if (result === undefined) {
        throw new Error(`Invalid persisted enum value: ${value}`);
    }

    return result;
}

export class SpaceMapper {
    static toDomain(entity: SpaceOrmEntity): Space {
        const common = {
            id: SpaceId.from(entity.id),
            version: entity.version,
            createdAt: entity.createdAt,
            updatedAt: entity.updatedAt,
        };

        if (entity.type === SpaceType.PERSONAL) {
            if (
                entity.status !== SpaceStatus.ACTIVE ||
                !entity.personalOwnerPersonId ||
                entity.name !== null ||
                entity.createdByPersonId !== null
            ) {
                throw new Error('Invalid persisted personal space');
            }

            return Space.restore({
                ...common,
                type: SpaceType.PERSONAL,
                status: SpaceStatus.ACTIVE,
                personalOwnerPersonId: PersonId.from(
                    entity.personalOwnerPersonId,
                ),
            });
        }

        if (
            entity.type !== SpaceType.SHARED ||
            entity.personalOwnerPersonId !== null ||
            entity.name === null ||
            !entity.createdByPersonId ||
            !entity.members ||
            !entity.invitations
        ) {
            throw new Error('Invalid or incomplete persisted shared space');
        }

        return Space.restore({
            ...common,
            type: SpaceType.SHARED,
            status: readEnum(entity.status, Object.values(SpaceStatus)),
            personalOwnerPersonId: null,
            name: entity.name,
            createdByPersonId: PersonId.from(entity.createdByPersonId),
            members: entity.members.map((member) =>
                Member.restore({
                    id: MemberId.from(member.id),
                    personId: PersonId.from(member.personId),
                    status: readEnum(
                        member.status,
                        Object.values(MemberStatus),
                    ),
                    joinedAt: member.joinedAt,
                }),
            ),
            invitations: entity.invitations.map((invitation) =>
                Invitation.restore({
                    id: InvitationId.from(invitation.id),
                    invitedByPersonId: PersonId.from(
                        invitation.invitedByPersonId,
                    ),
                    status: readEnum(
                        invitation.status,
                        Object.values(InvitationStatus),
                    ),
                    issuedAt: invitation.issuedAt,
                    expiresAt: invitation.expiresAt,
                    resolvedAt: invitation.resolvedAt,
                    cancellationReason: invitation.cancellationReason,
                    closureProcessId: invitation.closureProcessId,
                    replacedByInvitationId:
                        invitation.replacedByInvitationId === null
                            ? null
                            : InvitationId.from(
                                  invitation.replacedByInvitationId,
                              ),
                }),
            ),
        });
    }

    static toPersistence(space: Space): SpaceOrmEntity {
        const props = space.snapshot();
        const entity = new SpaceOrmEntity();

        entity.id = props.id.value;
        entity.type = props.type;
        entity.status = props.status;
        entity.personalOwnerPersonId =
            props.personalOwnerPersonId?.value ?? null;
        entity.name = props.type === SpaceType.SHARED ? props.name : null;
        entity.createdByPersonId =
            props.type === SpaceType.SHARED
                ? props.createdByPersonId.value
                : null;
        entity.version = props.version;
        entity.createdAt = props.createdAt;
        entity.updatedAt = props.updatedAt;

        return entity;
    }

    static invitationToPersistence(
        invitation: Invitation,
        spaceId: SpaceId,
    ): Omit<SpaceInvitationOrmEntity, 'tokenHash'> {
        return {
            id: invitation.id.value,
            spaceId: spaceId.value,
            invitedByPersonId: invitation.invitedByPersonId.value,
            status: invitation.status,
            issuedAt: invitation.issuedAt,
            expiresAt: invitation.expiresAt,
            resolvedAt: invitation.resolvedAt,
            cancellationReason: invitation.cancellationReason,
            closureProcessId: invitation.closureProcessId,
            replacedByInvitationId:
                invitation.replacedByInvitationId?.value ?? null,
        };
    }
}
