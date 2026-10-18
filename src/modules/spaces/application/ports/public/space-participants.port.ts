import type { PersonId } from '../../../domain/person/person-id.js';
import type { SpaceId } from '../../../domain/space/space-id.js';
import type { SpaceAccessContext } from '../../models/space-access-context.js';

export const SPACE_PARTICIPANTS_PORT = Symbol('SPACE_PARTICIPANTS_PORT');
export interface SpaceParticipant {
    personId: string;
    memberId: string | null;
    displayName: string;
}
export interface SpaceParticipantsContext extends SpaceAccessContext {
    participants: SpaceParticipant[];
}
export interface SpaceParticipantsPort {
    read(actor: PersonId, space: SpaceId): Promise<SpaceParticipantsContext>;
    lockForWrite(
        actor: PersonId,
        space: SpaceId,
    ): Promise<SpaceParticipantsContext>;
}
