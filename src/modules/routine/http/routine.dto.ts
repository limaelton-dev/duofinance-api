import { z } from 'zod';
import { parseZodInput } from '../../../shared/technical/http/validation/parse-zod-input.js';
import { validDate } from '../domain/task.js';
export const uuid = z.uuid().transform((v) => v.toLowerCase());
export const civilDate = z
    .string()
    .refine(validDate, 'Informe uma data civil válida.');
export const deadline = z
    .object({
        date: civilDate,
        time: z
            .string()
            .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
            .nullable()
            .default(null),
    })
    .strict()
    .nullable();
export const urgency = z.enum(['LOW', 'NORMAL', 'HIGH', 'URGENT']);
export const version = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const createTask = z
    .object({
        description: z.string().trim().min(1).max(500),
        assigneeMemberId: uuid.nullable().optional(),
        deadline: deadline.optional(),
        urgency: urgency.default('NORMAL'),
    })
    .strict();
export const assignTask = z
    .object({ expectedVersion: version, assigneeMemberId: uuid.nullable() })
    .strict();
export const pageQuery = z
    .object({
        limit: z.coerce.number().int().min(1).max(100).default(20),
        cursor: z.string().min(1).max(3000).optional(),
    })
    .strict();
export const attentionQuery = pageQuery
    .extend({
        status: z
            .enum(['PENDING', 'COMPLETED', 'CANCELLED', 'SKIPPED', 'ALL'])
            .default('PENDING'),
        scope: z.enum(['MINE', 'ALL']).default('ALL'),
        attention: z
            .enum(['TODAY', 'URGENT', 'OVERDUE', 'UPCOMING', 'NO_DEADLINE'])
            .optional(),
        from: civilDate.optional(),
        to: civilDate.optional(),
    })
    .refine((q) => !q.from || !q.to || q.from <= q.to, {
        path: ['to'],
        message: 'O fim deve ser igual ou posterior ao início.',
    })
    .refine(
        (q) =>
            !q.from ||
            !q.to ||
            new Date(q.to).getTime() - new Date(q.from).getTime() <=
                365 * 86400000,
        { path: ['to'], message: 'Consulte no máximo 366 dias por período.' },
    );
export function params(input: unknown) {
    return parseZodInput(
        z.object({ spaceId: uuid, taskId: uuid.optional() }).strict(),
        input,
    );
}
export { parseZodInput };
