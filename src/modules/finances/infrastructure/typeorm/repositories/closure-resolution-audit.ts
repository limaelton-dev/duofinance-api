import { Inject, Injectable } from '@nestjs/common';
import { EntityManagerProvider } from '../../../../../shared/technical/database/typeorm/entity-manager.provider.js';
import {
    SPACE_CLOSURE_PORT,
    type SpaceClosurePort,
} from '../../../../spaces/application/ports/public/space-closure.port.js';

@Injectable()
export class ClosureResolutionAudit {
    constructor(
        private readonly managers: EntityManagerProvider,
        @Inject(SPACE_CLOSURE_PORT) private readonly closures: SpaceClosurePort,
    ) {}

    async context(
        actorId: string,
        spaceId: string,
    ): Promise<{
        closure?: { processId: string; planRevision: number };
    }> {
        if (!this.managers.get().queryRunner?.isTransactionActive)
            throw new Error('Closure resolution audit requires a transaction');
        const closure = await this.closures.read(actorId, spaceId);
        return closure?.spaceStatus === 'CLOSING' &&
            closure.processStatus === 'OPEN'
            ? {
                  closure: {
                      processId: closure.processId,
                      planRevision: closure.planRevision,
                  },
              }
            : {};
    }
}
