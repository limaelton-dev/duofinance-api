import { Injectable } from '@nestjs/common';
import { EntityManagerProvider } from '../../../../../shared/technical/database/typeorm/entity-manager.provider.js';
import type {
    SpaceParticipant,
    SpaceParticipantsContext,
    SpaceParticipantsPort,
} from '../../../application/ports/public/space-participants.port.js';
import { SpacesDomainError } from '../../../domain/errors/spaces-domain.error.js';
import type { PersonId } from '../../../domain/person/person-id.js';
import type { SpaceId } from '../../../domain/space/space-id.js';

@Injectable()
export class TypeOrmSpaceParticipants implements SpaceParticipantsPort {
    constructor(private readonly provider: EntityManagerProvider) {}
    read(actor: PersonId, space: SpaceId) {
        return this.load(actor, space, false);
    }
    lockForWrite(actor: PersonId, space: SpaceId) {
        return this.load(actor, space, true);
    }
    private async load(
        actor: PersonId,
        space: SpaceId,
        lock: boolean,
    ): Promise<SpaceParticipantsContext> {
        const manager = this.provider.get();
        if (lock && !manager.queryRunner?.isTransactionActive)
            throw new Error('Participant write requires a transaction');
        const [row] = await manager.query(
            `SELECT s.id AS "spaceId",s.type,s.status,s.personal_owner_person_id AS "ownerId",m.id AS "actorMemberId" FROM spaces s LEFT JOIN space_members m ON m.space_id=s.id AND m.person_id=$1 AND m.status='ACTIVE' WHERE s.id=$2 AND ((s.type='PERSONAL' AND s.personal_owner_person_id=$1) OR (s.type='SHARED' AND m.id IS NOT NULL)) ${lock ? 'FOR SHARE OF s' : ''}`,
            [actor.value, space.value],
        );
        if (!row) throw new SpacesDomainError('SPACE_NOT_FOUND');
        if (lock && row.status !== 'ACTIVE')
            throw new SpacesDomainError('SPACE_NOT_ACTIVE');
        const participants: SpaceParticipant[] =
            row.type === 'PERSONAL'
                ? await manager.query(
                      'SELECT id AS "personId",NULL AS "memberId",display_name AS "displayName" FROM persons WHERE id=$1',
                      [row.ownerId],
                  )
                : await manager.query(
                      `SELECT m.person_id AS "personId",m.id AS "memberId",p.display_name AS "displayName" FROM space_members m JOIN persons p ON p.id=m.person_id WHERE m.space_id=$1 AND m.status='ACTIVE' ORDER BY m.id ${lock ? 'FOR SHARE OF m' : ''}`,
                      [space.value],
                  );
        const current = participants.find((p) => p.personId === actor.value);
        if (!current) throw new SpacesDomainError('SPACE_NOT_FOUND');
        return {
            spaceId: row.spaceId,
            type: row.type,
            status: row.status,
            actorMemberId: current.memberId,
            participants,
        };
    }
}
