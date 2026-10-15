import {
    BadRequestException,
    Injectable,
    type PipeTransform,
} from '@nestjs/common';
import { z } from 'zod';
import { civilDate } from '../../domain/shared-expense/settlement-cycle.js';

const uuid = z.uuid().transform((value) => value.toLowerCase());
const positive = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const version = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const date = z.string().refine((value) => {
    try {
        civilDate(value);
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
            expectedRuleVersion: version,
        })
        .strict(),
]);
const split = z.discriminatedUnion('mode', [
    z
        .object({
            mode: z.literal('AMOUNTS'),
            shares: z
                .array(
                    z
                        .object({
                            memberId: uuid,
                            amountInCents: z
                                .number()
                                .int()
                                .min(0)
                                .max(Number.MAX_SAFE_INTEGER),
                        })
                        .strict(),
                )
                .min(1)
                .max(2),
        })
        .strict(),
    z
        .object({
            mode: z.literal('PERCENTAGES'),
            shares: z
                .array(
                    z
                        .object({
                            memberId: uuid,
                            basisPoints: z.number().int().min(0).max(10000),
                        })
                        .strict(),
                )
                .min(1)
                .max(2),
        })
        .strict(),
]);
const common = {
    description: z.string().trim().min(1).max(160),
    amountInCents: positive,
    expectedReceiptDate: date,
};
export const incomeInputSchema = z.union([
    z
        .object({
            ...common,
            receipt: z.object({ factDate: date }).strict().nullable(),
        })
        .strict(),
    z
        .object({
            ...common,
            expectedSpaceVersion: version,
            participationSplit: split,
            expectedRecipientMemberId: uuid.nullable(),
            receipt: z
                .object({ factDate: date, recipientMemberId: uuid, settlement })
                .strict()
                .nullable(),
        })
        .strict(),
]);
export const incomeReceiptInputSchema = z.union([
    z.object({ expectedCommitmentVersion: version, factDate: date }).strict(),
    z
        .object({
            expectedCommitmentVersion: version,
            factDate: date,
            expectedSpaceVersion: version,
            recipientMemberId: uuid,
            settlement,
        })
        .strict(),
]);
export type RecordIncomeDto = z.infer<typeof incomeInputSchema>;
export type RecordIncomeReceiptDto = z.infer<typeof incomeReceiptInputSchema>;

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
    const result = schema.safeParse(input);
    if (result.success) return result.data;
    throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: 'Verifique os dados informados.',
        details: {
            fields: result.error.issues.map((issue) => ({
                field: issue.path.join('.'),
                messages: [issue.message],
            })),
        },
    });
}

@Injectable()
export class RecordIncomePipe implements PipeTransform {
    transform(input: unknown): RecordIncomeDto {
        return parse(incomeInputSchema, input);
    }
}

@Injectable()
export class RecordIncomeReceiptPipe implements PipeTransform {
    transform(input: unknown): RecordIncomeReceiptDto {
        return parse(incomeReceiptInputSchema, input);
    }
}
