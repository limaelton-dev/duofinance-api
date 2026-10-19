import {
    Body,
    Controller,
    Get,
    Header,
    HttpCode,
    Param,
    Post,
    Put,
    Query,
    Res,
} from '@nestjs/common';
import { IsOptional, IsString, Matches } from 'class-validator';
import { z } from 'zod';
import { parseZodInput } from '../../../../shared/technical/http/validation/parse-zod-input.js';
import { uuid } from '../dto/record-shared-cash-expense.dto.js';
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
    ChangeRecurringCommitmentPipe,
    TerminateRecurringCommitmentPipe,
    CancelRecurringOccurrencePipe,
    type ChangeRecurringCommitmentDto,
    type TerminateRecurringCommitmentDto,
    type CancelRecurringOccurrenceDto,
} from '../dto/recurring-commitment.dto.js';

class MonthQuery {
    @IsString({ message: 'Informe o mês no formato YYYY-MM.' })
    @Matches(/^(?!0000)\d{4}-(0[1-9]|1[0-2])$/, {
        message: 'Informe um mês válido no formato YYYY-MM.',
    })
    month!: string;
    @IsOptional()
    @IsString({ message: 'Informe um cursor válido.' })
    cursor?: string;
}

@Controller('spaces/:spaceId/recurring-commitments')
export class RecurringCommitmentController {
    constructor(private readonly handler: RecurringCommitmentHandler) {}

    private identifier(value: string, field: string) {
        return parseZodInput(z.object({ [field]: uuid }), { [field]: value })[
            field
        ]!;
    }

    private ids(actor: RequestActor, spaceId: string) {
        return {
            actorId: PersonId.from(actor.personId.value),
            spaceId: SpaceId.from(this.identifier(spaceId, 'spaceId')),
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
            this.identifier(id, 'id'),
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
            this.identifier(id, 'id'),
            query.month,
        );
    }

    @Post(':id/change-preview')
    @HttpCode(200)
    @Header('Cache-Control', 'no-store')
    changePreview(
        @CurrentActor() actor: RequestActor,
        @Param('spaceId') spaceId: string,
        @Param('id') id: string,
        @Body(ChangeRecurringCommitmentPipe)
        input: ChangeRecurringCommitmentDto,
    ) {
        const ids = this.ids(actor, spaceId);
        return this.handler.changePreview(
            ids.actorId,
            ids.spaceId,
            this.identifier(id, 'id'),
            input,
        );
    }

    @Post(':id/versions')
    @Header('Cache-Control', 'no-store')
    async changeVersion(
        @CurrentActor() actor: RequestActor,
        @Param('spaceId') spaceId: string,
        @Param('id') commitmentId: string,
        @IdempotencyKey() idempotencyKey: string,
        @Body(ChangeRecurringCommitmentPipe)
        input: ChangeRecurringCommitmentDto,
        @Res({ passthrough: true }) response: Response,
    ) {
        const result = await this.handler.changeVersion({
            ...this.ids(actor, spaceId),
            ...input,
            commitmentId: this.identifier(commitmentId, 'id'),
            idempotencyKey,
        });
        if (result.replayed) response.status(200);
        return result;
    }

    @Post(':id/termination')
    @Header('Cache-Control', 'no-store')
    async terminate(
        @CurrentActor() actor: RequestActor,
        @Param('spaceId') spaceId: string,
        @Param('id') commitmentId: string,
        @IdempotencyKey() idempotencyKey: string,
        @Body(TerminateRecurringCommitmentPipe)
        input: TerminateRecurringCommitmentDto,
        @Res({ passthrough: true }) response: Response,
    ) {
        const result = await this.handler.terminate({
            ...this.ids(actor, spaceId),
            ...input,
            commitmentId: this.identifier(commitmentId, 'id'),
            idempotencyKey,
        });
        if (result.replayed) response.status(200);
        return result;
    }

    @Post(':id/termination-preview')
    @HttpCode(200)
    @Header('Cache-Control', 'no-store')
    terminationPreview(
        @CurrentActor() actor: RequestActor,
        @Param('spaceId') spaceId: string,
        @Param('id') id: string,
        @Body(TerminateRecurringCommitmentPipe)
        input: TerminateRecurringCommitmentDto,
    ) {
        const ids = this.ids(actor, spaceId);
        return this.handler.terminationPreview(
            ids.actorId,
            ids.spaceId,
            this.identifier(id, 'id'),
            input,
        );
    }

    @Post(':id/occurrences/:referenceDate/cancellation')
    @Header('Cache-Control', 'no-store')
    async cancelOccurrence(
        @CurrentActor() actor: RequestActor,
        @Param('spaceId') spaceId: string,
        @Param('id') commitmentId: string,
        @Param('referenceDate') referenceDate: string,
        @IdempotencyKey() idempotencyKey: string,
        @Body(CancelRecurringOccurrencePipe)
        input: CancelRecurringOccurrenceDto,
        @Res({ passthrough: true }) response: Response,
    ) {
        const result = await this.handler.cancelOccurrence({
            ...this.ids(actor, spaceId),
            ...input,
            commitmentId: this.identifier(commitmentId, 'id'),
            referenceDate: this.referenceDate(referenceDate),
            idempotencyKey,
        });
        if (result.replayed) response.status(200);
        return result;
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
            this.identifier(id, 'id'),
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
            commitmentId: this.identifier(commitmentId, 'id'),
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
            commitmentId: this.identifier(commitmentId, 'id'),
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
            commitmentId: this.identifier(commitmentId, 'id'),
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
            commitmentId: this.identifier(commitmentId, 'id'),
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
            commitmentId: this.identifier(commitmentId, 'id'),
            referenceDate: this.referenceDate(referenceDate),
            liabilityId: this.identifier(liabilityId, 'liabilityId'),
            kind: 'SETTLE_EXTERNAL_LIABILITY',
        });
        if (result.replayed) response.status(200);
        return result;
    }
}
