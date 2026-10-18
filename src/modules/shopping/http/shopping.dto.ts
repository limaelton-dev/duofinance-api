import { z } from 'zod';
import { parseZodInput } from '../../../shared/technical/http/validation/parse-zod-input.js';
import { Quantity } from '../domain/quantity.js';

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
export const positiveQuantity = z.string().transform((value, context) => {
    try {
        return Quantity.from(value).toString();
    } catch {
        context.addIssue({
            code: 'custom',
            message:
                'Informe uma quantidade positiva com até 3 casas decimais e máximo 999999999999.999.',
        });
        return z.NEVER;
    }
});
export const unit = z.string().trim().min(1).max(30).nullable();
export const nonNegativeQuantity = z.string().transform((value, context) => {
    try {
        return Quantity.from(value, 'quantity', true).toString();
    } catch {
        context.addIssue({
            code: 'custom',
            message:
                'Informe uma quantidade igual ou maior que zero com até 3 casas decimais e máximo 999999999999.999.',
        });
        return z.NEVER;
    }
});
export const correctPurchase = z
    .object({ expectedVersion: version, quantity: nonNegativeQuantity })
    .strict();
export const recordPurchase = z
    .object({ expectedVersion: version, quantity: positiveQuantity })
    .strict();
export const addItem = z
    .object({
        expectedVersion: version,
        description: z.string().trim().min(1).max(500),
        desiredQuantity: positiveQuantity,
        unit: unit.default(null),
    })
    .strict();
export const changeNeed = z
    .object({
        expectedVersion: version,
        desiredQuantity: positiveQuantity.optional(),
        unit: unit.optional(),
    })
    .strict()
    .refine(
        (input) =>
            input.desiredQuantity !== undefined || input.unit !== undefined,
        { message: 'Informe a quantidade desejada ou a unidade a alterar.' },
    );
export const itemQuery = pageQuery.extend({
    status: z
        .enum(['ACTIVE', 'PENDING', 'PURCHASED', 'REMOVED', 'ALL'])
        .default('ACTIVE'),
});
export function params(input: unknown) {
    return parseZodInput(
        z
            .object({
                spaceId: uuid,
                listId: uuid.optional(),
                itemId: uuid.optional(),
                purchaseId: uuid.optional(),
            })
            .strict(),
        input,
    );
}
export { parseZodInput };
