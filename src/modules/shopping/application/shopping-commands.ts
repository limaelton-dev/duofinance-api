import { Inject, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import {
    UNIT_OF_WORK,
    type UnitOfWork,
} from '../../../shared/application/unit-of-work.js';
import {
    SPACE_PARTICIPANTS_PORT,
    type SpaceParticipantsPort,
    type SpaceParticipantsContext,
} from '../../spaces/application/ports/public/space-participants.port.js';
import { PersonId } from '../../spaces/domain/person/person-id.js';
import { SpaceId } from '../../spaces/domain/space/space-id.js';
import { SHOPPING_STORE, type ShoppingStore } from './shopping-store.js';
import { SHOPPING_CLOCK, type ShoppingClock } from './shopping-clock.js';
import { ShoppingError } from '../domain/shopping-error.js';
import type { ShoppingAuthor } from '../domain/shopping-list.js';

function canonical(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
    if (value !== null && typeof value === 'object')
        return `{${Object.entries(value)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
            .join(',')}}`;
    return JSON.stringify(value);
}
export function shoppingAuthor(
    context: SpaceParticipantsContext,
    actor: string,
): ShoppingAuthor {
    const current = context.participants.find((p) => p.personId === actor)!;
    return {
        personId: actor,
        memberId: context.actorMemberId,
        displayName: current.displayName,
    };
}
@Injectable()
export class ShoppingCommands {
    constructor(
        @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
        @Inject(SPACE_PARTICIPANTS_PORT)
        private readonly participants: SpaceParticipantsPort,
        @Inject(SHOPPING_STORE) private readonly store: ShoppingStore,
        @Inject(SHOPPING_CLOCK) private readonly clock: ShoppingClock,
    ) {}
    execute<T extends { id: string }>(
        actor: string,
        space: string,
        key: string,
        operation: string,
        target: string,
        input: object,
        work: (context: SpaceParticipantsContext, now: string) => Promise<T>,
    ): Promise<T> {
        return this.uow.execute(async () => {
            await this.participants.read(
                PersonId.from(actor),
                SpaceId.from(space),
            );
            await this.store.lockReceipt(actor, operation, key);
            const digest = createHash('sha256')
                .update(canonical({ space, target, input }))
                .digest('hex');
            const old = await this.store.receipt(actor, operation, key);
            if (old) {
                if (old.digest !== digest)
                    throw new ShoppingError('IDEMPOTENCY_KEY_REUSED');
                return old.result as T;
            }
            const context = await this.participants.lockForWrite(
                PersonId.from(actor),
                SpaceId.from(space),
            );
            const now = this.clock.now().toISOString();
            const result = await work(context, now);
            await this.store.finish({
                actorId: actor,
                spaceId: space,
                operation,
                key,
                digest,
                result,
                aggregateId: result.id,
                registeredAt: new Date(now),
            });
            return result;
        });
    }
}
