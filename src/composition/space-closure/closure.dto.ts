import { z } from 'zod';
export { parseZodInput } from '../../shared/technical/http/validation/parse-zod-input.js';
const version = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const closureParams = z
    .object({ spaceId: z.uuid().transform((v) => v.toLowerCase()) })
    .strict();
export const startClosure = z
    .object({ expectedSpaceVersion: version })
    .strict();
export const planVersion = startClosure.extend({
    expectedPlanRevision: version,
});
export const cutoffDate = planVersion
    .extend({ cutoffDate: z.iso.date() })
    .strict();
export const diagnosticPage = z
    .object({
        limit: z.coerce.number().int().min(1).max(100).default(20),
        offset: z.coerce
            .number()
            .int()
            .min(0)
            .max(Number.MAX_SAFE_INTEGER)
            .default(0),
    })
    .strict();
export const historyPage = z
    .object({
        limit: z.coerce.number().int().min(1).max(100).default(20),
        cursor: z.string().max(3000).optional(),
    })
    .strict();
