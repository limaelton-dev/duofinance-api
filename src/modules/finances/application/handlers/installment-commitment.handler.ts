import { Injectable } from '@nestjs/common';
import type { PersonId } from '../../../spaces/domain/person/person-id.js';
import type { SpaceId } from '../../../spaces/domain/space/space-id.js';
import type {
    InstallmentCommitmentDto,
    InstallmentAnticipationPreviewDto,
    InstallmentPayoffPreviewDto,
} from '../../http/dto/installment-commitment.dto.js';
import { CreateInstallmentCommitmentHandler } from './create-installment-commitment.handler.js';
import { InstallmentCommitmentQueries } from './installment-commitment.queries.js';
import { AnticipateInstallmentCommitmentHandler } from './anticipate-installment-commitment.handler.js';
import { ResolveInstallmentCommitmentHandler } from './resolve-installment-commitment.handler.js';
import { CancelInstallmentCommitmentHandler } from './cancel-installment-commitment.handler.js';
import { RecordInstallmentCommitmentHandler } from './record-installment-commitment.handler.js';
import type {
    Create,
    Fulfillment,
    Anticipation,
    Payoff,
    Cancellation,
} from './installment-commitment.commands.js';
@Injectable()
export class InstallmentCommitmentHandler {
    constructor(
        private readonly creation: CreateInstallmentCommitmentHandler,
        private readonly queries: InstallmentCommitmentQueries,
        private readonly anticipation: AnticipateInstallmentCommitmentHandler,
        private readonly resolution: ResolveInstallmentCommitmentHandler,
        private readonly cancellation: CancelInstallmentCommitmentHandler,
        private readonly fulfillment: RecordInstallmentCommitmentHandler,
    ) {}

    async preview(
        actorId: PersonId,
        spaceId: SpaceId,
        input: InstallmentCommitmentDto,
    ) {
        return this.creation.preview(actorId, spaceId, input);
    }

    async create(c: Create) {
        return this.creation.create(c);
    }

    async detail(actor: PersonId, space: SpaceId, id: string) {
        return this.queries.detail(actor, space, id);
    }

    async list(actor: PersonId, space: SpaceId, cursor?: string) {
        return this.queries.list(actor, space, cursor);
    }

    async installments(actor: PersonId, space: SpaceId, id: string) {
        return this.queries.installments(actor, space, id);
    }

    async options(
        actor: PersonId,
        space: SpaceId,
        id: string,
        installmentId: string,
        cursor?: string,
    ) {
        return this.queries.options(actor, space, id, installmentId, cursor);
    }

    async anticipationOptions(
        actor: PersonId,
        space: SpaceId,
        id: string,
        cursor?: string,
    ) {
        return this.anticipation.anticipationOptions(actor, space, id, cursor);
    }

    async anticipationPreview(
        actor: PersonId,
        space: SpaceId,
        id: string,
        input: InstallmentAnticipationPreviewDto,
    ) {
        return this.anticipation.anticipationPreview(actor, space, id, input);
    }

    async anticipate(c: Anticipation) {
        return this.anticipation.anticipate(c);
    }

    async resolutionOptions(
        actor: PersonId,
        space: SpaceId,
        id: string,
        cursor?: string,
    ) {
        return this.resolution.resolutionOptions(actor, space, id, cursor);
    }

    async payoffPreview(
        actor: PersonId,
        space: SpaceId,
        id: string,
        input: InstallmentPayoffPreviewDto,
    ) {
        return this.resolution.payoffPreview(actor, space, id, input);
    }

    async payoff(c: Payoff) {
        return this.resolution.payoff(c);
    }

    async cancelFuture(c: Cancellation) {
        return this.cancellation.cancelFuture(c);
    }

    async record(c: Fulfillment) {
        return this.fulfillment.record(c);
    }
}
