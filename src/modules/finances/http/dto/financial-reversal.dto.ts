import { Injectable, type PipeTransform } from '@nestjs/common';
import { z } from 'zod';
import { parseZodInput } from '../../../../shared/technical/http/validation/parse-zod-input.js';
import { date, integer, uuid } from './record-shared-cash-expense.dto.js';
import { financialCorrectionSettlementSchema } from './financial-correction.dto.js';

export const financialReversalSchema = z
    .object({
        expectedCommitmentVersion: integer.min(1),
        expectedSpaceVersion: integer.min(1).optional(),
        expectedOccurrenceVersion: integer.min(1).optional(),
        occurrenceId: uuid.optional(),
        referenceDate: date.optional(),
        installmentId: uuid.optional(),
        originalKind: z.enum([
            'DISBURSEMENT',
            'EXTERNAL_LIABILITY',
            'EXTERNAL_SETTLEMENT',
            'RECEIPT',
        ]),
        originalId: uuid,
        amountInCents: integer.min(1),
        reason: z.string().trim().min(1).max(500),
        factDate: date,
        settlement: financialCorrectionSettlementSchema.optional(),
    })
    .strict()
    .superRefine((input, ctx) => {
        if (input.installmentId && (input.occurrenceId || input.referenceDate))
            ctx.addIssue({
                code: 'custom',
                path: ['installmentId'],
                message: 'Informe somente o alvo correspondente à modalidade.',
            });
    });
export const financialReversalListSchema = z
    .object({ cursor: z.string().min(1).max(2048).optional() })
    .strict();
export type FinancialReversalDto = z.infer<typeof financialReversalSchema>;
export type FinancialReversalListDto = z.infer<
    typeof financialReversalListSchema
>;
@Injectable()
export class FinancialReversalPipe implements PipeTransform {
    transform(input: unknown) {
        return parseZodInput(financialReversalSchema, input);
    }
}
@Injectable()
export class FinancialReversalListPipe implements PipeTransform {
    transform(input: unknown) {
        return parseZodInput(financialReversalListSchema, input);
    }
}
