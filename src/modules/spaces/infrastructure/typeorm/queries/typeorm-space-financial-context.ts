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
        return this.load(actorId, spaceId, true);
    }
    private async load(
        actorId: PersonId,
        spaceId: SpaceId,
        lock: boolean,
    ): Promise<SpaceFinancialContext> {
        if (lock && !this.manager.get().queryRunner?.isTransactionActive)
            throw new Error('Financial context write requires a transaction');
        const rows = await this.manager
            .get()
            .query(
                `SELECT s.id AS "spaceId", s.type, s.status, s.version, m.id AS "actorMemberId" FROM spaces s LEFT JOIN space_members m ON m.space_id=s.id AND m.person_id=$1 AND m.status='ACTIVE' WHERE s.id=$2 AND ((s.type='PERSONAL' AND s.personal_owner_person_id=$1) OR (s.type='SHARED' AND m.id IS NOT NULL)) ${lock ? 'FOR SHARE OF s' : ''}`,
                [actorId.value, spaceId.value],
            );
        const row = rows[0];
        if (!row) throw new SpacesDomainError('SPACE_NOT_FOUND');
        if (row.type !== 'SHARED')
            throw new SpacesDomainError('SHARED_SPACE_REQUIRED');
        if (lock && row.status !== 'ACTIVE')
            throw new SpacesDomainError('SPACE_NOT_ACTIVE');
        const members = await this.manager
            .get()
            .query(
                `SELECT m.id AS "memberId", m.person_id AS "personId", p.display_name AS "displayName" FROM space_members m JOIN persons p ON p.id=m.person_id WHERE m.space_id=$1 AND m.status='ACTIVE' ORDER BY m.id`,
                [spaceId.value],
            );
        return { ...row, members };
    }
}
