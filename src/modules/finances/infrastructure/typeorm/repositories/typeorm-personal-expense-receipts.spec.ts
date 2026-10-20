import { describe, it, expect } from 'vitest';
import { personalExpenseCommandHash } from './typeorm-personal-expense-receipts.js';
import { PersonId } from '../../../../spaces/domain/person/person-id.js';
import { SpaceId } from '../../../../spaces/domain/space/space-id.js';
import type { RecordPersonalExpenseCommand } from '../../../application/models/personal-expense.js';
const c: RecordPersonalExpenseCommand = {
    actorId: PersonId.create(),
    spaceId: SpaceId.create(),
    idempotencyKey: SpaceId.create().value,
    description: 'Consulta',
    amountInCents: 12000,
    factDate: '2026-10-14',
    disbursement: { method: 'PIX' },
};
describe('Personal expense command hash', () => {
    it('normalizes trim and preserves retry identity independently of the key', () => {
        expect(
            personalExpenseCommandHash(c).equals(
                personalExpenseCommandHash({
                    ...c,
                    description: ' Consulta ',
                    idempotencyKey: SpaceId.create().value,
                }),
            ),
        ).toBe(true);
        expect(personalExpenseCommandHash(c)).toHaveLength(32);
    });
    it.each([
        { description: 'Outra' },
        { amountInCents: 1 },
        { factDate: '2026-10-13' },
        { spaceId: SpaceId.create() },
        { disbursement: { method: 'DEBIT' } },
    ])('hashes the full normalized personal input in case %#', (patch) =>
        expect(
            personalExpenseCommandHash(c).equals(
                personalExpenseCommandHash({
                    ...c,
                    ...patch,
                } as RecordPersonalExpenseCommand),
            ),
        ).toBe(false),
    );
});
