import { Injectable } from '@nestjs/common';
import type { PersonId } from '../../../spaces/domain/person/person-id.js';
import type { SpaceId } from '../../../spaces/domain/space/space-id.js';
import type {
    CancelRecurringOccurrenceDto,
    ChangeRecurringCommitmentDto,
    TerminateRecurringCommitmentDto,
} from '../../http/dto/recurring-commitment.dto.js';
import { ChangeRecurringCommitmentHandler } from './change-recurring-commitment.handler.js';
import { CreateRecurringCommitmentHandler } from './create-recurring-commitment.handler.js';
import { MaintainRecurringCommitmentHandler } from './maintain-recurring-commitment.handler.js';
import { RecordRecurringCommitmentHandler } from './record-recurring-commitment.handler.js';
import type {
    Base,
    Create,
    Fulfillment,
    SetValue,
} from './recurring-commitment.commands.js';
import { RecurringCommitmentQueries } from './recurring-commitment.queries.js';
import { SetRecurringValueHandler } from './set-recurring-value.handler.js';
@Injectable()
export class RecurringCommitmentHandler {
    constructor(
        private readonly creation: CreateRecurringCommitmentHandler,
        private readonly queries: RecurringCommitmentQueries,
        private readonly changes: ChangeRecurringCommitmentHandler,
        private readonly maintenance: MaintainRecurringCommitmentHandler,
        private readonly values: SetRecurringValueHandler,
        private readonly fulfillment: RecordRecurringCommitmentHandler,
    ) {}
    async create(c: Create) {
        return this.creation.create(c);
    }
    async detail(actor: PersonId, space: SpaceId, id: string) {
        return this.queries.detail(actor, space, id);
    }
    async list(
        actor: PersonId,
        space: SpaceId,
        month: string,
        cursor?: string,
    ) {
        return this.queries.list(actor, space, month, cursor);
    }
    async occurrences(
        actor: PersonId,
        space: SpaceId,
        id: string,
        month: string,
    ) {
        return this.queries.occurrences(actor, space, id, month);
    }
    async options(
        actor: PersonId,
        space: SpaceId,
        id: string,
        referenceDate: string,
        cursor?: string,
    ) {
        return this.queries.options(actor, space, id, referenceDate, cursor);
    }
    async changePreview(
        actor: PersonId,
        space: SpaceId,
        id: string,
        input: ChangeRecurringCommitmentDto,
    ) {
        return this.changes.changePreview(actor, space, id, input);
    }
    changeVersion(
        c: Base & { commitmentId: string } & ChangeRecurringCommitmentDto,
    ) {
        return this.changes.changeVersion(c);
    }
    async applyVersion(
        c: Base & { commitmentId: string } & ChangeRecurringCommitmentDto,
        acceptance?: { proposedByMemberId: string; acceptedByMemberId: string },
    ) {
        return this.changes.applyVersion(c, acceptance);
    }
    async terminationPreview(
        actor: PersonId,
        space: SpaceId,
        id: string,
        input: TerminateRecurringCommitmentDto,
    ) {
        return this.maintenance.terminationPreview(actor, space, id, input);
    }
    terminate(
        c: Base & { commitmentId: string } & TerminateRecurringCommitmentDto,
    ) {
        return this.maintenance.terminate(c);
    }
    cancelOccurrence(
        c: Base & {
            commitmentId: string;
            referenceDate: string;
        } & CancelRecurringOccurrenceDto,
    ) {
        return this.maintenance.cancelOccurrence(c);
    }
    async setValue(c: SetValue) {
        return this.values.setValue(c);
    }
    async record(c: Fulfillment) {
        return this.fulfillment.record(c);
    }
}
