import { Injectable, type PipeTransform } from '@nestjs/common';
import { z } from 'zod';
import { parseZodInput } from '../../../../shared/technical/http/validation/parse-zod-input.js';
import {
    date,
    integer,
    split,
    uuid,
} from './record-shared-cash-expense.dto.js';

const schedule = {
    count: integer.min(1).max(1200),
    firstDueDate: date.optional(),
    cadence: z.enum(['MONTHLY', 'ANNUAL']).optional(),
    explicitDueDates: z.array(date).min(1).max(1200).optional(),
    totalAmountInCents: integer.min(1).optional(),
    baseAmountInCents: integer.min(1).optional(),
    amountsInCents: z.array(integer.min(1)).min(1).max(1200).optional(),
};
const common = {
    description: z.string().trim().min(1).max(160),
    ...schedule,
    plannedPaymentMethod: z
        .enum(['CARD', 'PIX', 'DEBIT', 'CASH'])
        .nullable()
        .optional(),
};
export const installmentCommitmentSchema = z.discriminatedUnion('scope', [
    z.object({ scope: z.literal('PERSONAL'), ...common }).strict(),
    z
        .object({
            scope: z.literal('SHARED'),
            ...common,
            distribution: split,
            expectedMemberId: uuid.nullable().optional(),
            expectedSpaceVersion: integer.min(1).optional(),
            expectedRuleVersion: integer.optional(),
        })
        .strict(),
]);
export type InstallmentCommitmentDto = z.infer<
    typeof installmentCommitmentSchema
>;

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
const fulfillmentCommon = {
    expectedCommitmentVersion: integer.min(1),
    expectedInstallmentVersion: integer.min(1),
    amountInCents: integer.min(1),
    factDate: date,
};
export const installmentDisbursementSchema = z.union([
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
export const installmentLiabilitySchema = z.union([
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
export const installmentSettlementSchema = z.union([
    z
        .object({
            expectedCommitmentVersion: integer.min(1),
            expectedInstallmentVersion: integer.min(1),
            amountInCents: integer.min(1),
            factDate: date,
        })
        .strict(),
    z
        .object({
            expectedCommitmentVersion: integer.min(1),
            expectedInstallmentVersion: integer.min(1),
            amountInCents: integer.min(1),
            factDate: date,
            expectedSpaceVersion: integer.min(1),
        })
        .strict(),
]);
export type InstallmentDisbursementDto = z.infer<
    typeof installmentDisbursementSchema
>;
export type InstallmentLiabilityDto = z.infer<
    typeof installmentLiabilitySchema
>;
export type InstallmentSettlementDto = z.infer<
    typeof installmentSettlementSchema
>;

@Injectable()
export class InstallmentCommitmentPipe implements PipeTransform {
    transform(input: unknown): InstallmentCommitmentDto {
        return parseZodInput(installmentCommitmentSchema, input);
    }
}
@Injectable()
export class InstallmentDisbursementPipe implements PipeTransform {
    transform(input: unknown): InstallmentDisbursementDto {
        return parseZodInput(installmentDisbursementSchema, input);
    }
}
@Injectable()
export class InstallmentLiabilityPipe implements PipeTransform {
    transform(input: unknown): InstallmentLiabilityDto {
        return parseZodInput(installmentLiabilitySchema, input);
    }
}
@Injectable()
export class InstallmentSettlementPipe implements PipeTransform {
    transform(input: unknown): InstallmentSettlementDto {
        return parseZodInput(installmentSettlementSchema, input);
    }
}
