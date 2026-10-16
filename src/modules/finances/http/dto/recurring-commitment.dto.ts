import { Injectable, type PipeTransform } from '@nestjs/common';
import { z } from 'zod';
import { parseZodInput } from '../../../../shared/technical/http/validation/parse-zod-input.js';
import {
    date,
    integer,
    split,
    uuid,
} from './record-shared-cash-expense.dto.js';

const recurrence = z.discriminatedUnion('frequency', [
    z
        .object({
            frequency: z.literal('MONTHLY'),
            dayOfMonth: integer.min(1).max(31),
        })
        .strict(),
    z
        .object({
            frequency: z.literal('ANNUAL'),
            monthOfYear: integer.min(1).max(12),
            dayOfMonth: integer.min(1).max(31),
        })
        .strict(),
]);
const common = {
    kind: z.enum(['EXPENSE', 'INCOME']),
    description: z.string().trim().min(1).max(160),
    amountInCents: integer.min(1),
    recurrence,
    startsOn: date.optional(),
    endsOn: date.nullable().optional(),
};

const amount = integer.min(1);
const fulfillmentCommon = {
    expectedCommitmentVersion: integer.min(1),
    expectedOccurrenceVersion: integer.min(1),
    amountInCents: amount,
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

export const createRecurringCommitmentSchema = z.discriminatedUnion('scope', [
    z.object({ scope: z.literal('PERSONAL'), ...common }).strict(),
    z
        .object({
            scope: z.literal('SHARED'),
            ...common,
            expectedSpaceVersion: integer.min(1),
            distribution: split,
            expectedMemberId: uuid.nullable().optional(),
        })
        .strict(),
]);

export type CreateRecurringCommitmentDto = z.infer<
    typeof createRecurringCommitmentSchema
>;

@Injectable()
export class CreateRecurringCommitmentPipe implements PipeTransform {
    transform(input: unknown): CreateRecurringCommitmentDto {
        return parseZodInput(createRecurringCommitmentSchema, input);
    }
}

export const recurringDisbursementSchema = z.union([
    z
        .object({
            ...fulfillmentCommon,
            method: z.enum(['PIX', 'DEBIT', 'CASH']),
        })
        .strict(),
    z
        .object({
            ...fulfillmentCommon,
            method: z.enum(['PIX', 'DEBIT', 'CASH']),
            payerMemberId: uuid,
            expectedSpaceVersion: integer.min(1),
            settlement,
        })
        .strict(),
]);
export const recurringReceiptSchema = z.union([
    z.object(fulfillmentCommon).strict(),
    z
        .object({
            ...fulfillmentCommon,
            recipientMemberId: uuid,
            expectedSpaceVersion: integer.min(1),
            settlement,
        })
        .strict(),
]);
export const recurringExternalLiabilitySchema = z.union([
    z.object(fulfillmentCommon).strict(),
    z
        .object({
            ...fulfillmentCommon,
            holderMemberId: uuid,
            expectedSpaceVersion: integer.min(1),
            settlement,
        })
        .strict(),
]);
export const recurringExternalSettlementSchema = z.union([
    z
        .object({
            expectedOccurrenceVersion: integer.min(1),
            amountInCents: amount,
            factDate: date,
        })
        .strict(),
    z
        .object({
            expectedOccurrenceVersion: integer.min(1),
            amountInCents: amount,
            factDate: date,
            expectedSpaceVersion: integer.min(1),
        })
        .strict(),
]);
export type RecurringDisbursementDto = z.infer<
    typeof recurringDisbursementSchema
>;
export type RecurringReceiptDto = z.infer<typeof recurringReceiptSchema>;
export type RecurringExternalLiabilityDto = z.infer<
    typeof recurringExternalLiabilitySchema
>;
export type RecurringExternalSettlementDto = z.infer<
    typeof recurringExternalSettlementSchema
>;

@Injectable()
export class RecurringDisbursementPipe implements PipeTransform {
    transform(input: unknown): RecurringDisbursementDto {
        return parseZodInput(recurringDisbursementSchema, input);
    }
}
@Injectable()
export class RecurringReceiptPipe implements PipeTransform {
    transform(input: unknown): RecurringReceiptDto {
        return parseZodInput(recurringReceiptSchema, input);
    }
}
@Injectable()
export class RecurringExternalLiabilityPipe implements PipeTransform {
    transform(input: unknown): RecurringExternalLiabilityDto {
        return parseZodInput(recurringExternalLiabilitySchema, input);
    }
}
@Injectable()
export class RecurringExternalSettlementPipe implements PipeTransform {
    transform(input: unknown): RecurringExternalSettlementDto {
        return parseZodInput(recurringExternalSettlementSchema, input);
    }
}
