import { Injectable, type PipeTransform } from '@nestjs/common';
import { z } from 'zod';
import { parseZodInput } from '../../../../shared/technical/http/validation/parse-zod-input.js';
import { changeRecurringCommitmentSchema } from './recurring-commitment.dto.js';
import { nonRecurringChangeSchema } from './non-recurring-change.dto.js';
import { integer } from './record-shared-cash-expense.dto.js';

export const financialChangeSchema = z.union([
    changeRecurringCommitmentSchema,
    nonRecurringChangeSchema,
]);
export type FinancialChangeDto = z.infer<typeof financialChangeSchema>;
export const financialChangeDecisionSchema = z
    .object({
        expectedCommitmentVersion: integer.min(1),
        expectedProposalVersion: integer.min(1),
        expectedSpaceVersion: integer.min(1),
    })
    .strict();
export type FinancialChangeDecisionDto = z.infer<
    typeof financialChangeDecisionSchema
>;
export const financialChangeListSchema = z
    .object({
        status: z
            .enum(['PROPOSED', 'ACCEPTED', 'REJECTED', 'CANCELLED'])
            .optional(),
        recipient: z.literal('ME').optional(),
        cursor: z.string().max(2048).optional(),
    })
    .strict();
export type FinancialChangeListDto = z.infer<typeof financialChangeListSchema>;
@Injectable()
export class FinancialChangePipe implements PipeTransform {
    transform(input: unknown) {
        return parseZodInput(financialChangeSchema, input);
    }
}
@Injectable()
export class FinancialChangeDecisionPipe implements PipeTransform {
    transform(input: unknown) {
        return parseZodInput(financialChangeDecisionSchema, input);
    }
}
@Injectable()
export class FinancialChangeListPipe implements PipeTransform {
    transform(input: unknown) {
        return parseZodInput(financialChangeListSchema, input);
    }
}
