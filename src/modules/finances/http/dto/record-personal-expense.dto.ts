import {
    BadRequestException,
    Injectable,
    type PipeTransform,
} from '@nestjs/common';
import { z } from 'zod';
import { civilDate } from '../../domain/shared-expense/settlement-cycle.js';
export const personalExpenseInputSchema = z
    .object({
        description: z.string().trim().min(1).max(160),
        amountInCents: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
        factDate: z.string().refine((value) => {
            try {
                civilDate(value);
                return true;
            } catch {
                return false;
            }
        }, 'Informe uma data civil válida no formato YYYY-MM-DD.'),
        disbursement: z
            .object({ method: z.enum(['PIX', 'DEBIT', 'CASH']) })
            .strict(),
    })
    .strict();
export type RecordPersonalExpenseDto = z.infer<
    typeof personalExpenseInputSchema
>;
@Injectable()
export class RecordPersonalExpensePipe implements PipeTransform {
    transform(input: unknown): RecordPersonalExpenseDto {
        const parsed = personalExpenseInputSchema.safeParse(input);
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
