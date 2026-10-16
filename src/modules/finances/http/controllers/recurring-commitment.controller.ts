import {
    Body,
    Controller,
    Get,
    Header,
    Param,
    Post,
    Put,
    Query,
    Res,
} from '@nestjs/common';
import { IsOptional, IsString } from 'class-validator';
import type { Response } from 'express';
import {
    CurrentActor,
    type RequestActor,
} from '../../../../shared/technical/http/current-actor.decorator.js';
import { IdempotencyKey } from '../../../../shared/technical/http/idempotency-key.decorator.js';
import { PersonId } from '../../../spaces/domain/person/person-id.js';
import { SpaceId } from '../../../spaces/domain/space/space-id.js';
import { RecurringCommitmentHandler } from '../../application/handlers/recurring-commitment.handler.js';
import { FinancesError } from '../../domain/errors/finances.error.js';
import { civilDate } from '../../domain/shared-expense/settlement-cycle.js';
import {
    CreateRecurringCommitmentPipe,
    SetRecurringValuePipe,
    RecurringDisbursementPipe,
    RecurringReceiptPipe,
    RecurringExternalLiabilityPipe,
    RecurringExternalSettlementPipe,
    type CreateRecurringCommitmentDto,
    type SetRecurringValueDto,
    type RecurringDisbursementDto,
    type RecurringReceiptDto,
    type RecurringExternalLiabilityDto,
    type RecurringExternalSettlementDto,
} from '../dto/recurring-commitment.dto.js';

class MonthQuery {
    @IsString({ message: 'Informe o mês no formato YYYY-MM.' }) month!: string;
    @IsOptional()
    @IsString({ message: 'Informe um cursor válido.' })
    cursor?: string;
}

@Controller('spaces/:spaceId/recurring-commitments')
export class RecurringCommitmentController {
    constructor(private readonly handler: RecurringCommitmentHandler) {}

    private ids(actor: RequestActor, spaceId: string) {
        return {
            actorId: PersonId.from(actor.personId.value),
            spaceId: SpaceId.from(spaceId.toLowerCase()),
        };
    }
    private referenceDate(value: string) {
        try {
            return civilDate(value);
        } catch {
            throw new FinancesError('VALIDATION_ERROR', ['referenceDate']);
        }
    }

    @Post()
    @Header('Cache-Control', 'no-store')
    async create(
        @CurrentActor() actor: RequestActor,
        @Param('spaceId') spaceId: string,
        @IdempotencyKey() idempotencyKey: string,
        @Body(CreateRecurringCommitmentPipe)
        input: CreateRecurringCommitmentDto,
        @Res({ passthrough: true }) response: Response,
    ) {
        const result = (await this.handler.create({
            ...this.ids(actor, spaceId),
            ...input,
            idempotencyKey,
        })) as { commitment: { id: string }; replayed: boolean };
        response.setHeader(
            'Location',
            `/v2/spaces/${spaceId}/recurring-commitments/${result.commitment.id}`,
        );
        if (result.replayed) response.status(200);
        return result;
    }

    @Get()
    @Header('Cache-Control', 'no-store')
    list(
        @CurrentActor() actor: RequestActor,
        @Param('spaceId') spaceId: string,
        @Query() query: MonthQuery,
    ) {
        return this.handler.list(
            this.ids(actor, spaceId).actorId,
            this.ids(actor, spaceId).spaceId,
            query.month,
            query.cursor,
        );
    }

    @Get(':id')
    @Header('Cache-Control', 'no-store')
    detail(
        @CurrentActor() actor: RequestActor,
        @Param('spaceId') spaceId: string,
        @Param('id') id: string,
    ) {
        return this.handler.detail(
            this.ids(actor, spaceId).actorId,
            this.ids(actor, spaceId).spaceId,
            id.toLowerCase(),
        );
    }

    @Get(':id/occurrences')
    @Header('Cache-Control', 'no-store')
    occurrences(
        @CurrentActor() actor: RequestActor,
        @Param('spaceId') spaceId: string,
        @Param('id') id: string,
        @Query() query: MonthQuery,
    ) {
        return this.handler.occurrences(
            this.ids(actor, spaceId).actorId,
            this.ids(actor, spaceId).spaceId,
            id.toLowerCase(),
            query.month,
        );
    }

    @Get(':id/occurrences/:referenceDate/options')
    @Header('Cache-Control', 'no-store')
    options(
        @CurrentActor() actor: RequestActor,
        @Param('spaceId') spaceId: string,
        @Param('id') id: string,
        @Param('referenceDate') referenceDate: string,
        @Query('cursor') cursor?: string,
    ) {
        return this.handler.options(
            this.ids(actor, spaceId).actorId,
            this.ids(actor, spaceId).spaceId,
            id.toLowerCase(),
            this.referenceDate(referenceDate),
            cursor,
        );
    }

    @Put(':id/occurrences/:referenceDate/value')
    @Header('Cache-Control', 'no-store')
    async setValue(
        @CurrentActor() actor: RequestActor,
        @Param('spaceId') spaceId: string,
        @Param('id') commitmentId: string,
        @Param('referenceDate') referenceDate: string,
        @IdempotencyKey() idempotencyKey: string,
        @Body(SetRecurringValuePipe) input: SetRecurringValueDto,
        @Res({ passthrough: true }) response: Response,
    ) {
        const result = await this.handler.setValue({
            ...this.ids(actor, spaceId),
            ...input,
            idempotencyKey,
            commitmentId: commitmentId.toLowerCase(),
            referenceDate: this.referenceDate(referenceDate),
        });
        if (result.replayed) response.status(200);
        return result;
    }

    @Post(':id/occurrences/:referenceDate/disbursements')
    @Header('Cache-Control', 'no-store')
    async disburse(
        @CurrentActor() actor: RequestActor,
        @Param('spaceId') spaceId: string,
        @Param('id') commitmentId: string,
        @Param('referenceDate') referenceDate: string,
        @IdempotencyKey() idempotencyKey: string,
        @Body(RecurringDisbursementPipe) input: RecurringDisbursementDto,
        @Res({ passthrough: true }) response: Response,
    ) {
        const result = await this.handler.record({
            ...this.ids(actor, spaceId),
            ...input,
            idempotencyKey,
            commitmentId: commitmentId.toLowerCase(),
            referenceDate: this.referenceDate(referenceDate),
            kind: 'DISBURSEMENT',
        });
        if (result.replayed) response.status(200);
        return result;
    }

    @Post(':id/occurrences/:referenceDate/receipts')
    @Header('Cache-Control', 'no-store')
    async receive(
        @CurrentActor() actor: RequestActor,
        @Param('spaceId') spaceId: string,
        @Param('id') commitmentId: string,
        @Param('referenceDate') referenceDate: string,
        @IdempotencyKey() idempotencyKey: string,
        @Body(RecurringReceiptPipe) input: RecurringReceiptDto,
        @Res({ passthrough: true }) response: Response,
    ) {
        const result = await this.handler.record({
            ...this.ids(actor, spaceId),
            ...input,
            idempotencyKey,
            commitmentId: commitmentId.toLowerCase(),
            referenceDate: this.referenceDate(referenceDate),
            kind: 'RECEIPT',
        });
        if (result.replayed) response.status(200);
        return result;
    }

    @Post(':id/occurrences/:referenceDate/external-liabilities')
    @Header('Cache-Control', 'no-store')
    async liability(
        @CurrentActor() actor: RequestActor,
        @Param('spaceId') spaceId: string,
        @Param('id') commitmentId: string,
        @Param('referenceDate') referenceDate: string,
        @IdempotencyKey() idempotencyKey: string,
        @Body(RecurringExternalLiabilityPipe)
        input: RecurringExternalLiabilityDto,
        @Res({ passthrough: true }) response: Response,
    ) {
        const result = await this.handler.record({
            ...this.ids(actor, spaceId),
            ...input,
            idempotencyKey,
            commitmentId: commitmentId.toLowerCase(),
            referenceDate: this.referenceDate(referenceDate),
            kind: 'EXTERNAL_LIABILITY',
        });
        if (result.replayed) response.status(200);
        return result;
    }

    @Post(
        ':id/occurrences/:referenceDate/external-liabilities/:liabilityId/settlements',
    )
    @Header('Cache-Control', 'no-store')
    async settle(
        @CurrentActor() actor: RequestActor,
        @Param('spaceId') spaceId: string,
        @Param('id') commitmentId: string,
        @Param('referenceDate') referenceDate: string,
        @Param('liabilityId') liabilityId: string,
        @IdempotencyKey() idempotencyKey: string,
        @Body(RecurringExternalSettlementPipe)
        input: RecurringExternalSettlementDto,
        @Res({ passthrough: true }) response: Response,
    ) {
        const result = await this.handler.record({
            ...this.ids(actor, spaceId),
            ...input,
            idempotencyKey,
            commitmentId: commitmentId.toLowerCase(),
            referenceDate: this.referenceDate(referenceDate),
            liabilityId: liabilityId.toLowerCase(),
            kind: 'SETTLE_EXTERNAL_LIABILITY',
        });
        if (result.replayed) response.status(200);
        return result;
    }
}
