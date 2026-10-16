import { parseZodInput } from '../../../../shared/technical/http/validation/parse-zod-input.js';
import { Injectable, type PipeTransform } from '@nestjs/common';
import { z } from 'zod';
import { civilDate } from '../../domain/shared-expense/settlement-cycle.js';
const uuid = z.uuid().transform((v) => v.toLowerCase());
const integer = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const date = z.string().refine((v) => {
    try {
        civilDate(v);
        return true;
    } catch {
        return false;
    }
}, 'Informe uma data civil válida.');
const settlement = z.discriminatedUnion('mode', [
    z.object({ mode: z.literal('NONE') }).strict(),
    z.object({ mode: z.literal('DATE'), targetDate: date }).strict(),
    z.object({ mode: z.literal('CYCLE'), cycleId: uuid }).strict(),
    z
        .object({
            mode: z.literal('SUGGESTED'),
            referenceDate: date,
            expectedRuleVersion: integer,
        })
        .strict(),
]);
const common = {
    amountInCents: integer,
    factDate: date,
    method: z.enum(['PIX', 'DEBIT', 'CASH']),
    expectedCommitmentVersion: integer,
};
export const expenseDisbursementInputSchema = z.union([
    z.object(common).strict(),
    z
        .object({
            ...common,
            payerMemberId: uuid,
            expectedSpaceVersion: integer,
            settlement,
        })
        .strict(),
]);
export type RecordExpenseDisbursementDto = z.infer<
    typeof expenseDisbursementInputSchema
>;
@Injectable()
export class RecordExpenseDisbursementPipe implements PipeTransform {
    transform(input: unknown): RecordExpenseDisbursementDto {
        return parseZodInput(expenseDisbursementInputSchema, input);
    }
}
