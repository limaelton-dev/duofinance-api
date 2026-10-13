import {
    BadRequestException,
    Injectable,
    type PipeTransform,
} from '@nestjs/common';
import { z } from 'zod';
import { civilDate } from '../../domain/shared-expense/settlement-cycle.js';

const uuid = z.uuid().transform((value) => value.toLowerCase());
const positive = z.number().int().safe().positive();
const date = z.string().refine((value) => {
    try {
        civilDate(value);
        return true;
    } catch {
        return false;
    }
}, 'Informe uma data civil válida.');
export const settlementTransferInputSchema = z
    .object({
        expectedSpaceVersion: positive,
        payerMemberId: uuid,
        recipientMemberId: uuid,
        amountInCents: positive,
        factDate: date,
        allocations: z
            .array(
                z
                    .object({
                        obligationId: uuid,
                        expectedObligationVersion: positive,
                        amountInCents: positive,
                    })
                    .strict(),
            )
            .min(1),
    })
    .strict()
    .superRefine((value, ctx) => {
        if (value.payerMemberId === value.recipientMemberId)
            ctx.addIssue({
                code: 'custom',
                path: ['recipientMemberId'],
                message: 'Escolha outro membro para receber.',
            });
        const ids = new Set<string>();
        value.allocations.forEach((a, i) => {
            if (ids.has(a.obligationId))
                ctx.addIssue({
                    code: 'custom',
                    path: ['allocations', i, 'obligationId'],
                    message: 'Escolha cada pendência uma única vez.',
                });
            ids.add(a.obligationId);
        });
        if (
            value.allocations.reduce(
                (sum, a) => sum + BigInt(a.amountInCents),
                0n,
            ) !== BigInt(value.amountInCents)
        )
            ctx.addIssue({
                code: 'custom',
                path: ['allocations'],
                message:
                    'A distribuição deve fechar exatamente o valor transferido.',
            });
    });
export type RecordManualSettlementTransferDto = z.infer<
    typeof settlementTransferInputSchema
>;
@Injectable()
export class RecordManualSettlementTransferPipe implements PipeTransform {
    transform(input: unknown): RecordManualSettlementTransferDto {
        const parsed = settlementTransferInputSchema.safeParse(input);
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
                                      messages: [issue.message],
                                  },
                              ],
                    ),
                },
            });
        return parsed.data;
    }
}
