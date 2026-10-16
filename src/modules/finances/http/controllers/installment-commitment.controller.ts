import {
    Body,
    Controller,
    Get,
    Header,
    HttpCode,
    Param,
    Post,
    Query,
    Res,
} from '@nestjs/common';
import type { Response } from 'express';
import {
    CurrentActor,
    type RequestActor,
} from '../../../../shared/technical/http/current-actor.decorator.js';
import { IdempotencyKey } from '../../../../shared/technical/http/idempotency-key.decorator.js';
import { PersonId } from '../../../spaces/domain/person/person-id.js';
import { SpaceId } from '../../../spaces/domain/space/space-id.js';
import { InstallmentCommitmentHandler } from '../../application/handlers/installment-commitment.handler.js';
import { FinancesError } from '../../domain/errors/finances.error.js';
import { uuid } from '../dto/record-shared-cash-expense.dto.js';
import {
    InstallmentCommitmentPipe,
    InstallmentDisbursementPipe,
    InstallmentLiabilityPipe,
    InstallmentSettlementPipe,
    type InstallmentCommitmentDto,
    type InstallmentDisbursementDto,
    type InstallmentLiabilityDto,
    type InstallmentSettlementDto,
} from '../dto/installment-commitment.dto.js';

@Controller('spaces/:spaceId/installment-commitments')
export class InstallmentCommitmentController {
    constructor(private readonly handler: InstallmentCommitmentHandler) {}

    private ids(actor: RequestActor, spaceId: string) {
        return {
            actorId: PersonId.from(actor.personId.value),
            spaceId: SpaceId.from(spaceId.toLowerCase()),
        };
    }
    private id(value: string, field: string) {
        const parsed = uuid.safeParse(value);
        if (!parsed.success)
            throw new FinancesError('VALIDATION_ERROR', [field]);
        return parsed.data;
    }

    @Post('preview')
    @HttpCode(200)
    @Header('Cache-Control', 'no-store')
    preview(
        @CurrentActor() actor: RequestActor,
        @Param('spaceId') spaceId: string,
        @Body(InstallmentCommitmentPipe) input: InstallmentCommitmentDto,
    ) {
        const ids = this.ids(actor, spaceId);
        return this.handler.preview(ids.actorId, ids.spaceId, input);
    }

    @Post()
    @Header('Cache-Control', 'no-store')
    async create(
        @CurrentActor() actor: RequestActor,
        @Param('spaceId') spaceId: string,
        @IdempotencyKey() idempotencyKey: string,
        @Body(InstallmentCommitmentPipe) input: InstallmentCommitmentDto,
        @Res({ passthrough: true }) response: Response,
    ) {
        const result = await this.handler.create({
            ...this.ids(actor, spaceId),
            ...input,
            idempotencyKey,
        });
        response.setHeader(
            'Location',
            `/v2/spaces/${spaceId}/installment-commitments/${(result as unknown as { commitment: { id: string } }).commitment.id}`,
        );
        if ((result as { replayed: boolean }).replayed) response.status(200);
        return result;
    }

    @Get()
    @Header('Cache-Control', 'no-store')
    list(
        @CurrentActor() actor: RequestActor,
        @Param('spaceId') spaceId: string,
        @Query('cursor') cursor?: string,
    ) {
        const ids = this.ids(actor, spaceId);
        return this.handler.list(ids.actorId, ids.spaceId, cursor);
    }

    @Get(':id')
    @Header('Cache-Control', 'no-store')
    detail(
        @CurrentActor() actor: RequestActor,
        @Param('spaceId') spaceId: string,
        @Param('id') id: string,
    ) {
        const ids = this.ids(actor, spaceId);
        return this.handler.detail(ids.actorId, ids.spaceId, this.id(id, 'id'));
    }

    @Get(':id/installments')
    @Header('Cache-Control', 'no-store')
    installments(
        @CurrentActor() actor: RequestActor,
        @Param('spaceId') spaceId: string,
        @Param('id') id: string,
    ) {
        const ids = this.ids(actor, spaceId);
        return this.handler.installments(
            ids.actorId,
            ids.spaceId,
            this.id(id, 'id'),
        );
    }

    @Get(':id/installments/:installmentId/options')
    @Header('Cache-Control', 'no-store')
    options(
        @CurrentActor() actor: RequestActor,
        @Param('spaceId') spaceId: string,
        @Param('id') id: string,
        @Param('installmentId') installmentId: string,
        @Query('cursor') cursor?: string,
    ) {
        const ids = this.ids(actor, spaceId);
        return this.handler.options(
            ids.actorId,
            ids.spaceId,
            this.id(id, 'id'),
            this.id(installmentId, 'installmentId'),
            cursor,
        );
    }

    @Post(':id/installments/:installmentId/disbursements')
    @Header('Cache-Control', 'no-store')
    async disburse(
        @CurrentActor() actor: RequestActor,
        @Param('spaceId') spaceId: string,
        @Param('id') commitmentId: string,
        @Param('installmentId') installmentId: string,
        @IdempotencyKey() idempotencyKey: string,
        @Body(InstallmentDisbursementPipe) input: InstallmentDisbursementDto,
        @Res({ passthrough: true }) response: Response,
    ) {
        const result = await this.handler.record({
            ...this.ids(actor, spaceId),
            ...input,
            idempotencyKey,
            commitmentId: this.id(commitmentId, 'id'),
            installmentId: this.id(installmentId, 'installmentId'),
            kind: 'DISBURSEMENT',
        });
        if ((result as { replayed: boolean }).replayed) response.status(200);
        return result;
    }

    @Post(':id/installments/:installmentId/external-liabilities')
    @Header('Cache-Control', 'no-store')
    async liability(
        @CurrentActor() actor: RequestActor,
        @Param('spaceId') spaceId: string,
        @Param('id') commitmentId: string,
        @Param('installmentId') installmentId: string,
        @IdempotencyKey() idempotencyKey: string,
        @Body(InstallmentLiabilityPipe) input: InstallmentLiabilityDto,
        @Res({ passthrough: true }) response: Response,
    ) {
        const result = await this.handler.record({
            ...this.ids(actor, spaceId),
            ...input,
            idempotencyKey,
            commitmentId: this.id(commitmentId, 'id'),
            installmentId: this.id(installmentId, 'installmentId'),
            kind: 'EXTERNAL_LIABILITY',
        });
        if ((result as { replayed: boolean }).replayed) response.status(200);
        return result;
    }

    @Post(
        ':id/installments/:installmentId/external-liabilities/:liabilityId/settlements',
    )
    @Header('Cache-Control', 'no-store')
    async settle(
        @CurrentActor() actor: RequestActor,
        @Param('spaceId') spaceId: string,
        @Param('id') commitmentId: string,
        @Param('installmentId') installmentId: string,
        @Param('liabilityId') liabilityId: string,
        @IdempotencyKey() idempotencyKey: string,
        @Body(InstallmentSettlementPipe) input: InstallmentSettlementDto,
        @Res({ passthrough: true }) response: Response,
    ) {
        const result = await this.handler.record({
            ...this.ids(actor, spaceId),
            ...input,
            idempotencyKey,
            commitmentId: this.id(commitmentId, 'id'),
            installmentId: this.id(installmentId, 'installmentId'),
            liabilityId: this.id(liabilityId, 'liabilityId'),
            kind: 'SETTLE_EXTERNAL_LIABILITY',
        });
        if ((result as { replayed: boolean }).replayed) response.status(200);
        return result;
    }
}
