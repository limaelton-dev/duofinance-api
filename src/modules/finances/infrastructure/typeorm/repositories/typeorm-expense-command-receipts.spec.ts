import { describe, expect, it } from 'vitest';
import { expenseCommandHash } from './typeorm-expense-command-receipts.js';
import type { RecordSharedCashExpenseCommand } from '../../../application/models/shared-cash-expense.js';
import { PersonId } from '../../../../spaces/domain/person/person-id.js';
import { SpaceId } from '../../../../spaces/domain/space/space-id.js';
const id = (n: number) =>
    `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const command: RecordSharedCashExpenseCommand = {
    actorId: PersonId.from(id(1)),
    spaceId: SpaceId.from(id(4)),
    idempotencyKey: id(5),
    expectedSpaceVersion: 2,
    description: 'Mercado',
    amountInCents: 50000,
    factDate: '2026-10-09',
    expectedPayerMemberId: id(2),
    responsibilitySplit: {
        mode: 'AMOUNTS',
        shares: [
            { memberId: id(2), amountInCents: 20000 },
            { memberId: id(3), amountInCents: 30000 },
        ],
    },
    disbursement: { payerMemberId: id(3), method: 'DEBIT' },
    settlement: { mode: 'NONE' },
};
describe('shared expense idempotency hashing', () => {
    it('hashes an informed payer deterministically', () => {
        expect(expenseCommandHash(command).toString('hex')).toBe(
            'a47e4f8722ca73d26a9b01612d72bb04b3cc73e3462ff2b5edf1b9b9dbadf298',
        );
    });
    it('normalizes absence and null, but distinguishes an informed payer', () => {
        const omitted = {
            ...command,
        } as Partial<RecordSharedCashExpenseCommand>;
        delete omitted.expectedPayerMemberId;
        const absentHash = expenseCommandHash(
            omitted as RecordSharedCashExpenseCommand,
        );
        expect(
            absentHash.equals(
                expenseCommandHash({ ...command, expectedPayerMemberId: null }),
            ),
        ).toBe(true);
        expect(absentHash.equals(expenseCommandHash(command))).toBe(false);
    });
});
