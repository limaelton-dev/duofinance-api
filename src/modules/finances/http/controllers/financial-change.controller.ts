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
import { FinancialCommitmentChangesHandler } from '../../application/handlers/financial-commitment-changes.handler.js';
import { FinancesError } from '../../domain/errors/finances.error.js';
import {
    FinancialChangePipe,
    FinancialChangeDecisionPipe,
    FinancialChangeListPipe,
    type FinancialChangeListDto,
    type FinancialChangeDto,
    type FinancialChangeDecisionDto,
} from '../dto/financial-change.dto.js';
import { uuid } from '../dto/record-shared-cash-expense.dto.js';

@Controller('spaces/:spaceId')
export class FinancialChangeController {
    constructor(private readonly changes: FinancialCommitmentChangesHandler) {}
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
    private async result(work: Promise<object>, response: Response) {
        const result = await work;
        if ((result as { replayed: boolean }).replayed) response.status(200);
        return result;
    }
    @Post('financial-commitments/:commitmentId/change-preview')
    @HttpCode(200)
    @Header('Cache-Control', 'no-store')
    preview(
        @CurrentActor() actor: RequestActor,
        @Param('spaceId') space: string,
        @Param('commitmentId') id: string,
        @Body(FinancialChangePipe) input: FinancialChangeDto,
    ) {
        const ids = this.ids(actor, space);
        return this.changes.preview(
            ids.actorId,
            ids.spaceId,
            this.id(id, 'commitmentId'),
            input,
        );
    }
    @Post('financial-commitments/:commitmentId/versions')
    @Header('Cache-Control', 'no-store')
    version(
        @CurrentActor() actor: RequestActor,
        @Param('spaceId') space: string,
        @Param('commitmentId') id: string,
        @IdempotencyKey() key: string,
        @Body(FinancialChangePipe) input: FinancialChangeDto,
        @Res({ passthrough: true }) response: Response,
    ) {
        return this.result(
            this.changes.change(
                {
                    ...this.ids(actor, space),
                    ...input,
                    commitmentId: this.id(id, 'commitmentId'),
                    idempotencyKey: key,
                },
                input,
            ),
            response,
        );
    }
    @Get('financial-commitments/:commitmentId/versions')
    @Header('Cache-Control', 'no-store')
    history(
        @CurrentActor() actor: RequestActor,
        @Param('spaceId') space: string,
        @Param('commitmentId') id: string,
    ) {
        const ids = this.ids(actor, space);
        return this.changes.history(
            ids.actorId,
            ids.spaceId,
            this.id(id, 'commitmentId'),
        );
    }
    @Post('financial-commitments/:commitmentId/change-proposals')
    @Header('Cache-Control', 'no-store')
    propose(
        @CurrentActor() actor: RequestActor,
        @Param('spaceId') space: string,
        @Param('commitmentId') id: string,
        @IdempotencyKey() key: string,
        @Body(FinancialChangePipe) input: FinancialChangeDto,
        @Res({ passthrough: true }) response: Response,
    ) {
        return this.result(
            this.changes.propose(
                {
                    ...this.ids(actor, space),
                    ...input,
                    commitmentId: this.id(id, 'commitmentId'),
                    idempotencyKey: key,
                },
                input,
            ),
            response,
        );
    }
    @Get('financial-change-proposals')
    @Header('Cache-Control', 'no-store')
    inbox(
        @CurrentActor() actor: RequestActor,
        @Param('spaceId') space: string,
        @Query(FinancialChangeListPipe) query: FinancialChangeListDto,
    ) {
        const ids = this.ids(actor, space);
        return this.changes.list(ids.actorId, ids.spaceId, null, query);
    }
    @Get('financial-commitments/:commitmentId/change-proposals')
    @Header('Cache-Control', 'no-store')
    list(
        @CurrentActor() actor: RequestActor,
        @Param('spaceId') space: string,
        @Param('commitmentId') id: string,
        @Query(FinancialChangeListPipe) query: FinancialChangeListDto,
    ) {
        const ids = this.ids(actor, space);
        return this.changes.list(
            ids.actorId,
            ids.spaceId,
            this.id(id, 'commitmentId'),
            query,
        );
    }
    @Get('financial-commitments/:commitmentId/change-proposals/:proposalId')
    @Header('Cache-Control', 'no-store')
    detail(
        @CurrentActor() actor: RequestActor,
        @Param('spaceId') space: string,
        @Param('commitmentId') id: string,
        @Param('proposalId') proposalId: string,
    ) {
        const ids = this.ids(actor, space);
        return this.changes.detail(
            ids.actorId,
            ids.spaceId,
            this.id(id, 'commitmentId'),
            this.id(proposalId, 'proposalId'),
        );
    }
    @Post(
        'financial-commitments/:commitmentId/change-proposals/:proposalId/acceptance',
    )
    @Header('Cache-Control', 'no-store')
    accept(
        @CurrentActor() actor: RequestActor,
        @Param('spaceId') space: string,
        @Param('commitmentId') id: string,
        @Param('proposalId') proposalId: string,
        @IdempotencyKey() key: string,
        @Body(FinancialChangeDecisionPipe) input: FinancialChangeDecisionDto,
        @Res({ passthrough: true }) response: Response,
    ) {
        return this.result(
            this.changes.decide(
                {
                    ...this.ids(actor, space),
                    ...input,
                    commitmentId: this.id(id, 'commitmentId'),
                    proposalId: this.id(proposalId, 'proposalId'),
                    idempotencyKey: key,
                },
                true,
            ),
            response,
        );
    }
    @Post(
        'financial-commitments/:commitmentId/change-proposals/:proposalId/rejection',
    )
    @Header('Cache-Control', 'no-store')
    reject(
        @CurrentActor() actor: RequestActor,
        @Param('spaceId') space: string,
        @Param('commitmentId') id: string,
        @Param('proposalId') proposalId: string,
        @IdempotencyKey() key: string,
        @Body(FinancialChangeDecisionPipe) input: FinancialChangeDecisionDto,
        @Res({ passthrough: true }) response: Response,
    ) {
        return this.result(
            this.changes.decide(
                {
                    ...this.ids(actor, space),
                    ...input,
                    commitmentId: this.id(id, 'commitmentId'),
                    proposalId: this.id(proposalId, 'proposalId'),
                    idempotencyKey: key,
                },
                false,
            ),
            response,
        );
    }
}
