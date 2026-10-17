import { z } from 'zod';
import {
    date,
    integer,
    split,
    uuid,
} from './record-shared-cash-expense.dto.js';

const common = {
    kind: z.enum(['EXPENSE', 'INCOME']),
    description: z.string().trim().min(1).max(160),
    amountInCents: integer.min(1),
    effectiveFrom: date,
    expectedCommitmentVersion: integer.min(1),
    installmentIds: z.array(uuid).min(1).optional(),
};

export const nonRecurringChangeSchema = z.discriminatedUnion('scope', [
    z.object({ ...common, scope: z.literal('PERSONAL') }).strict(),
    z
        .object({
            ...common,
            scope: z.literal('SHARED'),
            expectedSpaceVersion: integer.min(1),
            distribution: split,
            expectedMemberId: uuid.nullable().optional(),
        })
        .strict(),
]);

export type NonRecurringChangeDto = z.infer<typeof nonRecurringChangeSchema>;
