import {
    BadRequestException,
    Injectable,
    type PipeTransform,
} from '@nestjs/common';
import { z } from 'zod';
import { civilDate } from '../../domain/shared-expense/settlement-cycle.js';
const uuid = z
    .uuid({ error: 'Informe um identificador válido.' })
    .transform((value) => value.toLowerCase());
const integer = z
    .number({ error: 'Informe um número inteiro.' })
    .int({ error: 'Informe um número inteiro seguro.' })
    .min(0)
    .max(Number.MAX_SAFE_INTEGER);
const date = z.string({ error: 'Informe uma data válida.' }).refine((value) => {
    try {
        civilDate(value);
        return true;
    } catch {
        return false;
    }
}, 'Informe uma data civil válida no formato YYYY-MM-DD.');
const split = z.discriminatedUnion('mode', [
    z
        .object({
            mode: z.literal('AMOUNTS'),
            shares: z
                .array(
                    z
                        .object({ memberId: uuid, amountInCents: integer })
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
                            basisPoints: integer.max(10000),
                        })
                        .strict(),
                )
                .min(1)
                .max(2),
        })
        .strict(),
]);
export const expenseInputSchema = z
    .object({
        expectedSpaceVersion: integer.min(1),
        description: z
            .string({ error: 'Informe a descrição.' })
            .trim()
            .min(1, { error: 'Informe a descrição.' })
            .max(160, { error: 'Use no máximo 160 caracteres.' }),
        amountInCents: integer.min(1, {
            error: 'O valor deve ser maior que zero.',
        }),
        factDate: date,
        responsibilitySplit: split,
        expectedPayerMemberId: uuid
            .nullable()
            .optional()
            .transform((value) => value ?? null),
        disbursement: z
            .object({
                payerMemberId: uuid,
                amountInCents: integer.min(1).optional(),
                method: z.enum(['PIX', 'DEBIT', 'CASH'], {
                    error: 'Escolha PIX, débito ou dinheiro.',
                }),
            })
            .strict(),
        settlement: z.discriminatedUnion('mode', [
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
        ]),
    })
    .strict()
    .superRefine((value, ctx) => {
        const shares = value.responsibilitySplit.shares;
        const ids = new Set<string>();
        shares.forEach((share, index) => {
            if (ids.has(share.memberId))
                ctx.addIssue({
                    code: 'custom',
                    message: 'Informe cada membro uma única vez.',
                    path: ['responsibilitySplit', 'shares', index, 'memberId'],
                });
            ids.add(share.memberId);
        });
        const sum = shares.reduce(
            (total, s) =>
                total +
                BigInt('amountInCents' in s ? s.amountInCents : s.basisPoints),
            0n,
        );
        if (
            sum !==
            BigInt(
                value.responsibilitySplit.mode === 'AMOUNTS'
                    ? value.amountInCents
                    : 10000,
            )
        )
            ctx.addIssue({
                code: 'custom',
                message: 'A divisão deve fechar exatamente o total.',
                path: ['responsibilitySplit', 'shares'],
            });
    });
export type RecordSharedCashExpenseDto = z.infer<typeof expenseInputSchema>;
@Injectable()
export class RecordSharedCashExpensePipe implements PipeTransform {
    transform(input: unknown): RecordSharedCashExpenseDto {
        const parsed = expenseInputSchema.safeParse(input);
        if (!parsed.success)
            throw new BadRequestException({
                code: 'VALIDATION_ERROR',
                message: 'Verifique os dados informados.',
                details: {
                    fields: parsed.error.issues.flatMap((issue) =>
                        issue.code === 'unrecognized_keys'
                            ? issue.keys.map((key) => ({
                                  field: [...issue.path, key].join('.'),
                                  messages: ['Este campo não é permitido.'],
                              }))
                            : [
                                  {
                                      field: issue.path.join('.'),
                                      messages: [
                                          issue.code === 'custom'
                                              ? issue.message
                                              : issue.code === 'too_small'
                                                ? 'Informe um valor que respeite o limite mínimo.'
                                                : issue.code === 'too_big'
                                                  ? 'Informe um valor que respeite o limite máximo.'
                                                  : 'Informe um valor válido para este campo.',
                                      ],
                                  },
                              ],
                    ),
                },
            });
        return parsed.data;
    }
}
