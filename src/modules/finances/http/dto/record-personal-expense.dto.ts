import { parseZodInput } from '../../../../shared/technical/http/validation/parse-zod-input.js';
import { Injectable, type PipeTransform } from '@nestjs/common';
import { z } from 'zod';
import { civilDate } from '../../domain/shared-expense/settlement-cycle.js';
export const personalExpenseInputSchema = z
    .object({
        description: z.string().trim().min(1).max(160),
        amountInCents: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
        factDate: z.string().refine((value) => {
            try {
                civilDate(value);
                return true;
            } catch {
                return false;
            }
        }, 'Informe uma data civil válida no formato YYYY-MM-DD.'),
        disbursement: z
            .object({
                method: z.enum(['PIX', 'DEBIT', 'CASH']),
                amountInCents: z
                    .number()
                    .int()
                    .min(1)
                    .max(Number.MAX_SAFE_INTEGER)
                    .optional(),
            })
            .strict(),
    })
    .strict();
export type RecordPersonalExpenseDto = z.infer<
    typeof personalExpenseInputSchema
>;
@Injectable()
export class RecordPersonalExpensePipe implements PipeTransform {
    transform(input: unknown): RecordPersonalExpenseDto {
        return parseZodInput(personalExpenseInputSchema, input);
    }
}
