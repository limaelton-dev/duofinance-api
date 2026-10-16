import { Injectable, type PipeTransform } from '@nestjs/common';
import { IsUUID } from 'class-validator';
import { z } from 'zod';
import { parseZodInput } from '../../../../shared/technical/http/validation/parse-zod-input.js';
import { civilDate } from '../../domain/shared-expense/settlement-cycle.js';
import { SettlementRuleParamsDto } from './configure-default-settlement-rule.dto.js';
const uuid = z.uuid().transform((v) => v.toLowerCase()),
    positive = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const input = z
    .object({
        expectedSpaceVersion: positive,
        factDate: z.string().refine((v) => {
            try {
                civilDate(v);
                return true;
            } catch {
                return false;
            }
        }, 'Informe uma data civil válida.'),
        expectedObligationVersions: z
            .array(z.object({ obligationId: uuid, version: positive }).strict())
            .min(1)
            .refine(
                (items) =>
                    new Set(items.map((i) => i.obligationId)).size ===
                    items.length,
                'Informe cada pendência uma única vez.',
            ),
        expectedCycleVersions: z
            .array(z.object({ cycleId: uuid, version: positive }).strict())
            .refine(
                (items) =>
                    new Set(items.map((i) => i.cycleId)).size === items.length,
                'Informe cada ciclo uma única vez.',
            ),
        applications: z
            .array(
                z
                    .object({ allocationId: uuid, amountInCents: positive })
                    .strict(),
            )
            .min(1)
            .refine(
                (items) =>
                    new Set(items.map((i) => i.allocationId)).size ===
                    items.length,
                'Informe cada aplicação uma única vez.',
            ),
        correctionCycleId: uuid.optional(),
    })
    .strict();
export type ReverseSettlementDto = z.infer<typeof input>;
@Injectable()
export class ReverseSettlementPipe implements PipeTransform {
    transform(value: unknown) {
        return parseZodInput(input, value);
    }
}
export class TransferReversalParamsDto extends SettlementRuleParamsDto {
    @IsUUID('all', { message: 'Informe uma transferência válida.' })
    transferId!: string;
}
export class OffsetReversalParamsDto extends SettlementRuleParamsDto {
    @IsUUID('all', { message: 'Informe uma compensação válida.' })
    offsetId!: string;
}
