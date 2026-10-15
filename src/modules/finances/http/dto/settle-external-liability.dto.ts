import {
    BadRequestException,
    Injectable,
    type PipeTransform,
} from '@nestjs/common';
import { z } from 'zod';
import { civilDate } from '../../domain/shared-expense/settlement-cycle.js';
const integer = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const date = z.string().refine((v) => {
    try {
        civilDate(v);
        return true;
    } catch {
        return false;
    }
}, 'Informe uma data civil válida.');
export const externalLiabilitySettlementInputSchema = z
    .object({
        amountInCents: integer,
        factDate: date,
        expectedCommitmentVersion: integer,
        expectedSpaceVersion: integer.optional(),
    })
    .strict();
export type SettleExternalLiabilityDto = z.infer<
    typeof externalLiabilitySettlementInputSchema
>;
@Injectable()
export class SettleExternalLiabilityPipe implements PipeTransform {
    transform(input: unknown): SettleExternalLiabilityDto {
        const parsed = externalLiabilitySettlementInputSchema.safeParse(input);
        if (parsed.success) return parsed.data;
        throw new BadRequestException({
            code: 'VALIDATION_ERROR',
            message: 'Verifique os dados informados.',
            details: {
                fields: parsed.error.issues.map((issue) => ({
                    field: issue.path.join('.'),
                    messages: [issue.message],
                })),
            },
        });
    }
}
