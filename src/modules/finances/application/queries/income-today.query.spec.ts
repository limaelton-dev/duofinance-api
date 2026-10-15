import { describe, expect, it, vi } from 'vitest';
import { PersonId } from '../../../spaces/domain/person/person-id.js';
import { SpaceId } from '../../../spaces/domain/space/space-id.js';
import type { IncomeRepository } from '../ports/private/income.ports.js';
import { GetIncomeTodayQuery } from './income-today.query.js';

describe('income Today partial fulfillment', () => {
    it('exposes the original, received and remaining amounts without duplicating the commitment', async () => {
        const actor = PersonId.create(),
            space = SpaceId.create(),
            commitmentId = SpaceId.create().value;
        const access = { assertCanRead: vi.fn(), assertCanWrite: vi.fn() };
        const upcoming = vi.fn().mockResolvedValue({
            items: [
                {
                    id: commitmentId,
                    description: 'Receita parcial',
                    expectedReceiptDate: '2026-10-15',
                    amountInCents: 100000,
                    receivedAmountInCents: 30000,
                    remainingAmountInCents: 70000,
                },
            ],
            totalCount: 1,
        });
        const query = new GetIncomeTodayQuery(access, {
            upcoming,
        } as unknown as IncomeRepository);
        expect(await query.readUpcoming(actor, space, '2026-10-15')).toEqual({
            items: [
                {
                    commitmentId,
                    kind: 'INCOME',
                    description: 'Receita parcial',
                    expectedReceiptDate: '2026-10-15',
                    amountInCents: 100000,
                    receivedAmountInCents: 30000,
                    remainingAmountInCents: 70000,
                },
            ],
            totalCount: 1,
        });
        expect(upcoming).toHaveBeenCalledExactlyOnceWith(
            space.value,
            '2026-10-15',
        );
        expect(access.assertCanRead).toHaveBeenCalledTimes(2);
        expect(access.assertCanWrite).not.toHaveBeenCalled();
    });
});
