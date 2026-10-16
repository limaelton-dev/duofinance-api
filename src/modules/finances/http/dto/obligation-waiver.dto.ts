import { Injectable, type PipeTransform } from '@nestjs/common';
import { IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { z } from 'zod';
import { parseZodInput } from '../../../../shared/technical/http/validation/parse-zod-input.js';
import { civilDate } from '../../domain/shared-expense/settlement-cycle.js';
import { SettlementRuleParamsDto } from './configure-default-settlement-rule.dto.js';
const positive = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const input = z
    .object({
        amountInCents: positive,
        factDate: z.string().refine((v) => {
            try {
                civilDate(v);
                return true;
            } catch {
                return false;
            }
        }, 'Informe uma data civil válida.'),
        expectedSpaceVersion: positive,
        expectedObligationVersion: positive,
        reason: z.string().trim().max(500).optional(),
    })
    .strict();
export type WaiveObligationDto = z.infer<typeof input>;
@Injectable()
export class WaiveObligationPipe implements PipeTransform {
    transform(value: unknown) {
        return parseZodInput(input, value);
    }
}
export class ObligationWaiverParamsDto extends SettlementRuleParamsDto {
    @IsUUID('all', { message: 'Informe uma pendência válida.' })
    obligationId!: string;
}
export class WaiverDetailParamsDto extends ObligationWaiverParamsDto {
    @IsUUID('all', { message: 'Informe uma dispensa válida.' })
    waiverId!: string;
}
export class WaiverHistoryQueryDto {
    @IsOptional() @IsString() @MaxLength(512) cursor?: string;
}
