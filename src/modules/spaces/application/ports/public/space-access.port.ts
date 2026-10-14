import type { PersonId } from '../../../domain/person/person-id.js';
import type { SpaceId } from '../../../domain/space/space-id.js';
import type { SpaceAccessContext } from '../../models/space-access-context.js';
export type { SpaceAccessContext } from '../../models/space-access-context.js';

export const SPACE_ACCESS_PORT = Symbol('SPACE_ACCESS_PORT');

export interface SpaceAccessPort {
    assertCanRead(
        actorId: PersonId,
        spaceId: SpaceId,
    ): Promise<SpaceAccessContext>;
    assertCanWrite(
        actorId: PersonId,
        spaceId: SpaceId,
    ): Promise<SpaceAccessContext>;
}
