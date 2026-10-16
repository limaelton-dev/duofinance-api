import { Injectable, type PipeTransform } from '@nestjs/common';
import { z } from 'zod';
import { IsIn, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { parseZodInput } from '../../../../shared/technical/http/validation/parse-zod-input.js';
import { civilDate } from '../../domain/shared-expense/settlement-cycle.js';
import { SettlementRuleParamsDto } from './configure-default-settlement-rule.dto.js';
import type { PositionDirection } from '../../application/models/inter-member-position.js';
const uuid = z.uuid().transform((v) => v.toLowerCase());
const positive = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const ids = z
    .array(uuid)
    .max(50)
    .refine(
        (items) => new Set(items).size === items.length,
        'Informe cada referência uma única vez.',
    );
const scope = z
    .object({ cycleIds: ids, obligationIds: ids })
    .strict()
    .refine(
        (s) => s.cycleIds.length + s.obligationIds.length > 0,
        'Selecione ao menos um ciclo ou uma pendência.',
    );
const input = z
    .object({
        scope,
        expectedSpaceVersion: positive,
        factDate: z.string().refine((v) => {
            try {
                civilDate(v);
                return true;
            } catch {
                return false;
            }
        }, 'Informe uma data civil válida.'),
        expectedCycleVersions: z
            .array(z.object({ cycleId: uuid, version: positive }).strict())
            .max(50)
            .refine(
                (items) =>
                    new Set(items.map((i) => i.cycleId)).size === items.length,
                'Informe cada ciclo uma única vez.',
            ),
        allocations: z
            .array(
                z
                    .object({
                        obligationId: uuid,
                        expectedObligationVersion: positive,
                        amountInCents: positive,
                    })
                    .strict(),
            )
            .min(2)
            .max(50)
            .refine(
                (items) =>
                    new Set(items.map((i) => i.obligationId)).size ===
                    items.length,
                'Informe cada pendência uma única vez.',
            ),
    })
    .strict();
export type RecordSettlementOffsetDto = z.infer<typeof input>;
@Injectable()
export class RecordSettlementOffsetPipe implements PipeTransform {
    transform(value: unknown) {
        return parseZodInput(input, value);
    }
}
export class SettlementOffsetParamsDto extends SettlementRuleParamsDto {
    @IsUUID('all', { message: 'Informe uma compensação válida.' })
    offsetId!: string;
}
export class SettlementOffsetOptionsQueryDto {
    @IsOptional() @IsString() @MaxLength(1849) cycleIds?: string;
    @IsOptional() @IsString() @MaxLength(1849) obligationIds?: string;
    @IsOptional()
    @IsIn(['ALL', 'PAYABLE', 'RECEIVABLE'], {
        message: 'Informe uma direção válida.',
    })
    direction?: PositionDirection;
    @IsOptional() @IsString() @MaxLength(512) cursor?: string;
}
export class SettlementOffsetHistoryQueryDto {
    @IsOptional()
    @IsUUID('all', { message: 'Informe um ciclo válido.' })
    cycleId?: string;
    @IsOptional()
    @IsUUID('all', { message: 'Informe uma pendência válida.' })
    obligationId?: string;
    @IsOptional() @IsString() @MaxLength(512) cursor?: string;
}
