import { Injectable, type PipeTransform } from '@nestjs/common';
import { z } from 'zod';
import { parseZodInput } from '../../../../shared/technical/http/validation/parse-zod-input.js';
import {
    date,
    integer,
    split,
    uuid,
} from './record-shared-cash-expense.dto.js';

const common = {
    description: z.string().trim().min(1).max(160),
    amountInCents: integer.min(1),
    expectedPaymentDate: date,
};

export const plannedExpenseInputSchema = z.discriminatedUnion('scope', [
    z.object({ scope: z.literal('PERSONAL'), ...common }).strict(),
    z
        .object({
            scope: z.literal('SHARED'),
            ...common,
            expectedSpaceVersion: integer.min(1),
            responsibilitySplit: split,
            expectedPayerMemberId: uuid.nullable().optional(),
        })
        .strict(),
]);

export type CreatePlannedExpenseDto = z.infer<typeof plannedExpenseInputSchema>;

@Injectable()
export class CreatePlannedExpensePipe implements PipeTransform {
    transform(input: unknown): CreatePlannedExpenseDto {
        return parseZodInput(plannedExpenseInputSchema, input);
    }
}
