import { Injectable } from '@nestjs/common';
import { EntityManagerProvider } from '../../../../../shared/technical/database/typeorm/entity-manager.provider.js';
import type {
    InvitationPreviewData,
    InvitationResponseView,
    ActorMembershipView,
    InvitationView,
    SpaceDetailsView,
    SpaceInvitationView,
    SpaceSummaryView,
} from '../../../application/models/space-views.js';
import type {
    RespondToInvitationCommand,
    SpaceCommandReceipt,
} from '../../../application/ports/private/space-command-receipts.js';
import type { SpaceReadQueries } from '../../../application/ports/private/space-read-queries.js';
import { InvitationId } from '../../../domain/invitation/invitation-id.js';
import { PersonId } from '../../../domain/person/person-id.js';
import { SpaceId } from '../../../domain/space/space-id.js';

type SummaryRow = {
    id: string;
    type: 'PERSONAL' | 'SHARED';
    status: 'ACTIVE' | 'CLOSING' | 'CLOSED';
    name: string | null;
    version: number;
};

type DetailRow = SummaryRow & {
    member_id: string | null;
    member_person_id: string | null;
    active_member_count: number;
    invitation_id: string | null;
    invitation_status: InvitationView['status'] | null;
    expires_at: Date | null;
};

@Injectable()
export class TypeOrmSpaceReadQueries implements SpaceReadQueries {
    constructor(
        private readonly entityManagerProvider: EntityManagerProvider,
    ) {}

    async listAccessible(actorId: PersonId): Promise<SpaceSummaryView[]> {
        const rows: SummaryRow[] = await this.entityManagerProvider.get().query(
            `
                    SELECT s.id, s.type, s.status, s.name, s.version
                    FROM spaces s
                    WHERE
                        (
                            s.type = 'PERSONAL'
                            AND s.personal_owner_person_id = $1
                        )
                        OR (
                            s.type = 'SHARED'
                            AND EXISTS (
                                SELECT 1
                                FROM space_members member
                                WHERE member.space_id = s.id
                                  AND member.person_id = $1
                                  AND member.status = 'ACTIVE'
                            )
                        )
                    ORDER BY
                        CASE WHEN s.type = 'PERSONAL' THEN 0 ELSE 1 END,
                        s.created_at,
                        s.id
                `,
            [actorId.value],
        );

        return rows.map((row) => this.summary(row));
    }

    async findDetails(
        actorId: PersonId,
        spaceId: SpaceId,
        now: Date,
    ): Promise<SpaceDetailsView | null> {
        const row = await this.readOne(actorId, spaceId);

        if (!row) {
            return null;
        }

        const space = this.summary(row);

        if (space.type === 'PERSONAL') {
            return {
                space,
                actorMembership: null,
                activeMemberCount: 0,
                invitation: null,
            };
        }

        const count = row.active_member_count;

        if (count !== 1 && count !== 2) {
            throw new Error('Invalid shared-space member count');
        }

        const invitation = this.invitation(row, now);
        const available = space.status === 'ACTIVE' && count < 2;

        return {
            space,
            actorMembership: this.membership(row),
            activeMemberCount: count,
            invitation: invitation
                ? {
                      ...invitation,
                      canIssue:
                          available &&
                          (invitation.status === 'EXPIRED' ||
                              invitation.status === 'CANCELLED' ||
                              invitation.status === 'REJECTED'),
                      canReplace: available && invitation.status === 'PENDING',
                  }
                : null,
        };
    }

    async findInvitationResult(
        actorId: PersonId,
        spaceId: SpaceId,
        invitationId: InvitationId,
        now: Date,
    ): Promise<SpaceInvitationView | null> {
        const row = await this.readOne(actorId, spaceId, invitationId, true);

        if (!row) {
            return null;
        }

        const space = this.summary(row);
        const invitation = this.invitation(row, now);

        if (space.type !== 'SHARED' || !invitation) {
            return null;
        }

        return {
            space,
            actorMembership: this.membership(row),
            invitation,
        };
    }

    async findInvitationPreview(
        actorId: PersonId,
        tokenHash: Uint8Array,
    ): Promise<InvitationPreviewData | null> {
        const rows: (SummaryRow & {
            invitation_id: string;
            invitation_status: InvitationView['status'];
            expires_at: Date;
            display_name: string;
            active_member_count: number;
            actor_is_creator: boolean;
            actor_is_member: boolean;
        })[] = await this.entityManagerProvider.get().query(
            `SELECT s.id, s.type, s.status, s.name, s.version,
                i.id AS invitation_id, i.status AS invitation_status, i.expires_at,
                person.display_name,
                (s.created_by_person_id = $1) AS actor_is_creator,
                EXISTS (SELECT 1 FROM space_members m
                    WHERE m.space_id = s.id AND m.person_id = $1
                        AND m.status = 'ACTIVE') AS actor_is_member,
                (SELECT count(*)::int FROM space_members m
                    WHERE m.space_id = s.id AND m.status = 'ACTIVE') AS active_member_count
             FROM space_invitations i
             JOIN spaces s ON s.id = i.space_id AND s.type = 'SHARED'
             JOIN persons person ON person.id = i.invited_by_person_id
             WHERE i.token_hash = $2`,
            [actorId.value, Buffer.from(tokenHash)],
        );
        const row = rows[0];

        if (!row) return null;

        const space = this.summary(row);
        if (space.type !== 'SHARED')
            throw new Error('Expected shared invitation preview');

        return {
            invitation: {
                id: row.invitation_id,
                status: row.invitation_status,
                expiresAt: row.expires_at.toISOString(),
            },
            space,
            invitedBy: { displayName: row.display_name },
            activeMemberCount: row.active_member_count,
            actorIsCreator: row.actor_is_creator,
            actorIsMember: row.actor_is_member,
        };
    }

    async findInvitationResponseResult(
        command: RespondToInvitationCommand,
        receipt: SpaceCommandReceipt,
    ): Promise<InvitationResponseView | null> {
        const rows: {
            invitation_id: string;
            resolved_at: Date;
            space_id: string;
            member_id: string | null;
            member_person_id: string | null;
        }[] = await this.entityManagerProvider.get().query(
            `SELECT i.id AS invitation_id, i.resolved_at, i.space_id,
                m.id AS member_id, m.person_id AS member_person_id
             FROM space_command_receipts receipt
             JOIN space_invitations i ON i.id = receipt.result_invitation_id
                AND i.space_id = receipt.result_space_id
             JOIN spaces s ON s.id = i.space_id AND s.type = 'SHARED'
             LEFT JOIN space_members m ON m.space_id = s.id
                AND m.person_id = $1 AND m.status = 'ACTIVE'
             WHERE receipt.actor_id = $1 AND receipt.operation = 'RESPOND_INVITATION'
                AND receipt.key = $2 AND receipt.result_space_id = $3
                AND receipt.result_invitation_id = $4 AND i.token_hash = $5
                AND i.status = $6 AND i.resolved_at IS NOT NULL
                AND (i.status = 'REJECTED' OR m.id IS NOT NULL)`,
            [
                command.actorId.value,
                command.key,
                receipt.resultSpaceId.value,
                receipt.resultInvitationId.value,
                Buffer.from(command.tokenHash),
                command.decision === 'ACCEPT' ? 'ACCEPTED' : 'REJECTED',
            ],
        );
        const row = rows[0];
        if (!row) return null;

        const common = { spaceId: row.space_id };
        if (command.decision === 'REJECT') {
            return {
                ...common,
                decision: 'REJECT',
                actorMembership: null,
                invitation: {
                    id: row.invitation_id,
                    status: 'REJECTED',
                    resolvedAt: row.resolved_at.toISOString(),
                },
            };
        }

        if (!row.member_id || !row.member_person_id) return null;

        return {
            ...common,
            decision: 'ACCEPT',
            invitation: {
                id: row.invitation_id,
                status: 'ACCEPTED',
                resolvedAt: row.resolved_at.toISOString(),
            },
            actorMembership: {
                id: row.member_id,
                personId: row.member_person_id,
                status: 'ACTIVE',
            },
        };
    }

    private async readOne(
        actorId: PersonId,
        spaceId: SpaceId,
        invitationId: InvitationId | null = null,
        requireCreator = false,
    ): Promise<DetailRow | null> {
        const rows: DetailRow[] = await this.entityManagerProvider.get().query(
            `
                    SELECT
                        s.id,
                        s.type,
                        s.status,
                        s.name,
                        s.version,
                        actor_member.id AS member_id,
                        actor_member.person_id AS member_person_id,
                        (
                            SELECT count(*)::int
                            FROM space_members member
                            WHERE member.space_id = s.id
                              AND member.status = 'ACTIVE'
                        ) AS active_member_count,
                        invitation.id AS invitation_id,
                        invitation.status AS invitation_status,
                        invitation.expires_at
                    FROM spaces s
                    LEFT JOIN space_members actor_member
                        ON actor_member.space_id = s.id
                       AND actor_member.person_id = $1
                       AND actor_member.status = 'ACTIVE'
                    LEFT JOIN LATERAL (
                        SELECT i.id, i.status, i.expires_at
                        FROM space_invitations i
                        WHERE i.space_id = s.id
                          AND s.created_by_person_id = $1
                          AND ($3::uuid IS NULL OR i.id = $3::uuid)
                        ORDER BY
                            (i.status = 'PENDING') DESC,
                            i.issued_at DESC,
                            i.id DESC
                        LIMIT 1
                    ) invitation ON TRUE
                    WHERE s.id = $2
                      AND (
                          (
                              s.type = 'PERSONAL'
                              AND s.personal_owner_person_id = $1
                          )
                          OR (
                              s.type = 'SHARED'
                              AND actor_member.id IS NOT NULL
                          )
                      )
                      AND (
                          $4::boolean = FALSE
                          OR s.created_by_person_id = $1
                      )
                `,
            [
                actorId.value,
                spaceId.value,
                invitationId?.value ?? null,
                requireCreator,
            ],
        );

        return rows[0] ?? null;
    }

    private summary(row: SummaryRow): SpaceSummaryView {
        if (row.type === 'PERSONAL' && row.status === 'ACTIVE') {
            return {
                id: row.id,
                type: 'PERSONAL',
                status: 'ACTIVE',
                label: 'Meu espaço',
                version: row.version,
            };
        }

        if (row.type === 'SHARED' && row.name !== null) {
            return {
                id: row.id,
                type: 'SHARED',
                status: row.status,
                label: row.name,
                version: row.version,
            };
        }

        throw new Error('Invalid persisted space summary');
    }

    private membership(row: DetailRow): ActorMembershipView {
        if (!row.member_id || !row.member_person_id) {
            throw new Error('Expected an active actor membership');
        }

        return {
            id: row.member_id,
            personId: row.member_person_id,
            status: 'ACTIVE',
        };
    }

    private invitation(row: DetailRow, now: Date): InvitationView | null {
        if (!row.invitation_id) {
            return null;
        }

        if (!row.invitation_status || !row.expires_at) {
            throw new Error('Incomplete persisted invitation');
        }

        const expired =
            row.invitation_status === 'PENDING' && now >= row.expires_at;

        return {
            id: row.invitation_id,
            status: expired ? 'EXPIRED' : row.invitation_status,
            expiresAt: row.expires_at.toISOString(),
        };
    }
}
