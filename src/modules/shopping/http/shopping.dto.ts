import { z } from 'zod';
import { parseZodInput } from '../../../shared/technical/http/validation/parse-zod-input.js';

export const uuid = z.uuid().transform((v) => v.toLowerCase());
export const version = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const listName = z.string().trim().min(1).max(120).nullable();
export const createList = z.object({ name: listName.default(null) }).strict();
export const renameList = z
    .object({ expectedVersion: version, name: listName })
    .strict();
export const pageQuery = z
    .object({
        limit: z.coerce.number().int().min(1).max(100).default(20),
        cursor: z.string().min(1).max(3000).optional(),
    })
    .strict();
export const listQuery = pageQuery.extend({
    status: z.enum(['ACTIVE', 'ARCHIVED', 'ALL']).default('ACTIVE'),
});
export function params(input: unknown) {
    return parseZodInput(
        z.object({ spaceId: uuid, listId: uuid.optional() }).strict(),
        input,
    );
}
export { parseZodInput };
