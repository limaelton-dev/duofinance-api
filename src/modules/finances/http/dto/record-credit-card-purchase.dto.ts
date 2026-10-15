import {
    BadRequestException,
    Injectable,
    type PipeTransform,
} from '@nestjs/common';
import { z } from 'zod';
import { expenseInputSchema } from './record-shared-cash-expense.dto.js';
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
});
const personal = z
    .object({
        description: z.string().trim().min(1).max(160),
        amountInCents: integer,
        factDate: date,
        externalLiability: z
            .object({ amountInCents: integer.optional() })
            .strict(),
    })
    .strict();
const { disbursement: _omittedDisbursement, ...sharedShape } =
    expenseInputSchema.shape;
const shared = z
    .object(sharedShape)
    .strict()
    .extend({
        externalLiability: z
            .object({ amountInCents: integer.optional(), holderMemberId: uuid })
            .strict(),
    });
export const creditCardPurchaseInputSchema = z.union([personal, shared]);
const additionalPersonal = z
    .object({
        amountInCents: integer,
        factDate: date,
        expectedCommitmentVersion: integer,
    })
    .strict();
const additionalShared = z
    .object({
        ...additionalPersonal.shape,
        holderMemberId: uuid,
        expectedSpaceVersion: integer,
        settlement: expenseInputSchema.shape.settlement,
    })
    .strict();
export const externalLiabilityInputSchema = z.union([
    additionalPersonal,
    additionalShared,
]);
export type RecordCreditCardPurchaseDto = z.infer<
    typeof creditCardPurchaseInputSchema
>;
export type RecordExternalLiabilityDto = z.infer<
    typeof externalLiabilityInputSchema
>;
function parse<T>(schema: z.ZodType<T>, input: unknown): T {
    const parsed = schema.safeParse(input);
    if (parsed.success) return parsed.data;
    throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: 'Verifique os dados informados.',
        details: {
            fields: parsed.error.issues.map((i) => ({
                field: i.path.join('.'),
                messages: [i.message],
            })),
        },
    });
}
@Injectable()
export class RecordCreditCardPurchasePipe implements PipeTransform {
    transform(input: unknown): RecordCreditCardPurchaseDto {
        return parse(creditCardPurchaseInputSchema, input);
    }
}
@Injectable()
export class RecordExternalLiabilityPipe implements PipeTransform {
    transform(input: unknown): RecordExternalLiabilityDto {
        return parse(externalLiabilityInputSchema, input);
    }
}
