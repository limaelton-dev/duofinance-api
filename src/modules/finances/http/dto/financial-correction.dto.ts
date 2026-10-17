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
    expectedCommitmentVersion: integer.min(1),
    expectedSpaceVersion: integer.min(1).optional(),
    reason: z.string().trim().min(1).max(500),
    factDate: date,
};
const settlement = z.discriminatedUnion('mode', [
    z.object({ mode: z.literal('NONE') }).strict(),
    z.object({ mode: z.literal('DATE'), targetDate: date }).strict(),
    z.object({ mode: z.literal('CYCLE'), cycleId: uuid }).strict(),
    z
        .object({
            mode: z.literal('SUGGESTED'),
            referenceDate: date,
            expectedRuleVersion: integer.min(1),
        })
        .strict(),
]);
export const financialCorrectionSettlementSchema = settlement;
export const adjustmentSchema = z
    .object({
        ...common,
        expectedOccurrenceVersion: integer.min(1).optional(),
        occurrenceId: uuid.optional(),
        referenceDate: date.optional(),
        installmentId: uuid.optional(),
        direction: z.enum(['INCREASE', 'DECREASE']),
        amountInCents: integer.min(1),
        distribution: split.optional(),
        settlement: settlement.optional(),
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
export const cancellationSchema = z.object(common).strict();
export type AdjustmentDto = z.infer<typeof adjustmentSchema>;
export type CancellationDto = z.infer<typeof cancellationSchema>;
@Injectable()
export class AdjustmentPipe implements PipeTransform {
    transform(input: unknown) {
        return parseZodInput(adjustmentSchema, input);
    }
}
@Injectable()
export class CancellationPipe implements PipeTransform {
    transform(input: unknown) {
        return parseZodInput(cancellationSchema, input);
    }
}
