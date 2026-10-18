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
import { ROUTINE_STORE, type RoutineStore } from './routine-store.js';
import { ROUTINE_CLOCK, type RoutineClock } from './routine-clock.js';
import { RoutineError } from '../domain/routine-error.js';
import type { Participant } from '../domain/task.js';

function canonical(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
    if (value !== null && typeof value === 'object')
        return `{${Object.entries(value)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
            .join(',')}}`;
    return JSON.stringify(value);
}
export function resolveAssignee(
    context: SpaceParticipantsContext,
    memberId: string | null | undefined,
): Participant | null {
    if (context.type === 'PERSONAL') {
        if (memberId)
            throw new RoutineError('INVALID_ASSIGNEE', 'assigneeMemberId');
        const p = context.participants[0];
        return { personId: p.personId, memberId: null };
    }
    if (!memberId) return null;
    const p = context.participants.find((p) => p.memberId === memberId);
    if (!p) throw new RoutineError('INVALID_ASSIGNEE', 'assigneeMemberId');
    return { personId: p.personId, memberId: p.memberId };
}
@Injectable()
export class RoutineCommands {
    constructor(
        @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
        @Inject(SPACE_PARTICIPANTS_PORT)
        private readonly participants: SpaceParticipantsPort,
        @Inject(ROUTINE_STORE) private readonly store: RoutineStore,
        @Inject(ROUTINE_CLOCK) private readonly clock: RoutineClock,
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
            const context = await this.participants.lockForWrite(
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
                    throw new RoutineError('IDEMPOTENCY_KEY_REUSED');
                return old.result as T;
            }
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
