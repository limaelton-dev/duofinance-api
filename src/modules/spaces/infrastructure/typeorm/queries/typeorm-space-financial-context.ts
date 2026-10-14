import { Injectable } from '@nestjs/common';
import { EntityManagerProvider } from '../../../../../shared/technical/database/typeorm/entity-manager.provider.js';
import type { PersonId } from '../../../domain/person/person-id.js';
import type { SpaceId } from '../../../domain/space/space-id.js';
import { SpacesDomainError } from '../../../domain/errors/spaces-domain.error.js';
import type {
    SpaceFinancialContext,
    SpaceFinancialContextPort,
} from '../../../application/ports/public/space-financial-context.port.js';
@Injectable()
export class TypeOrmSpaceFinancialContext implements SpaceFinancialContextPort {
    constructor(private readonly manager: EntityManagerProvider) {}
    read(actorId: PersonId, spaceId: SpaceId): Promise<SpaceFinancialContext> {
        return this.load(actorId, spaceId, false);
    }
    lockForWrite(
        actorId: PersonId,
        spaceId: SpaceId,
    ): Promise<SpaceFinancialContext> {
        return this.load(actorId, spaceId, true, false);
    }
    lockForSettlement(
        actorId: PersonId,
        spaceId: SpaceId,
    ): Promise<SpaceFinancialContext> {
        return this.load(actorId, spaceId, true, true);
    }
    lockForFulfillment(
        actorId: PersonId,
        spaceId: SpaceId,
    ): Promise<SpaceFinancialContext> {
        return this.load(actorId, spaceId, true, true);
    }
    private async load(
        actorId: PersonId,
        spaceId: SpaceId,
        lock: boolean,
        settlement = false,
    ): Promise<SpaceFinancialContext> {
        if (lock && !this.manager.get().queryRunner?.isTransactionActive)
            throw new Error('Financial context write requires a transaction');
        const rows = await this.manager
            .get()
            .query(
                `SELECT s.id AS "spaceId", s.type, s.status, s.version, m.id AS "actorMemberId" ${!lock ? `, (SELECT jsonb_agg(jsonb_build_object('memberId', member.id, 'personId', member.person_id, 'displayName', p.display_name) ORDER BY member.id) FROM space_members member JOIN persons p ON p.id=member.person_id WHERE member.space_id=s.id AND member.status='ACTIVE') AS members` : ''} FROM spaces s LEFT JOIN space_members m ON m.space_id=s.id AND m.person_id=$1 AND m.status='ACTIVE' WHERE s.id=$2 AND ((s.type='PERSONAL' AND s.personal_owner_person_id=$1) OR (s.type='SHARED' AND m.id IS NOT NULL)) ${lock ? 'FOR SHARE OF s' : ''}`,
                [actorId.value, spaceId.value],
            );
        const row = rows[0];
        if (!row) throw new SpacesDomainError('SPACE_NOT_FOUND');
        if (row.type !== 'SHARED')
            throw new SpacesDomainError('SHARED_SPACE_REQUIRED');
        if (
            lock &&
            row.status !== 'ACTIVE' &&
            !(settlement && row.status === 'CLOSING')
        )
            throw new SpacesDomainError('SPACE_NOT_ACTIVE');
        if (!lock) return row;
        const ids: { id: string }[] = await this.manager
            .get()
            .query(
                `SELECT id FROM space_members WHERE space_id=$1 AND status='ACTIVE' ORDER BY id`,
                [spaceId.value],
            );
        const members: {
            memberId: string;
            personId: string;
            displayName: string;
        }[] = [];
        for (const member of ids) {
            const current: typeof members = await this.manager
                .get()
                .query(
                    `SELECT m.id AS "memberId", m.person_id AS "personId", p.display_name AS "displayName" FROM space_members m JOIN persons p ON p.id=m.person_id WHERE m.space_id=$1 AND m.id=$2 AND m.status='ACTIVE' FOR SHARE OF m`,
                    [spaceId.value, member.id],
                );
            if (current.length) members.push(current[0]);
        }
        const actorMember = members.find(
            (member) => member.personId === actorId.value,
        );
        if (!actorMember) throw new SpacesDomainError('SPACE_NOT_FOUND');
        return { ...row, actorMemberId: actorMember.memberId, members };
    }
}
