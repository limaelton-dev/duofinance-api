import { describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { ExternalLiabilityQueries } from './external-liability.queries.js';
import { PersonId } from '../../../spaces/domain/person/person-id.js';
import { SpaceId } from '../../../spaces/domain/space/space-id.js';
import { FinancialCommitment } from '../../domain/shared-expense/financial-commitment.js';
import { Money } from '../../domain/shared-expense/money.js';
const actor = PersonId.from(randomUUID()),
    space = SpaceId.from(randomUUID()),
    today = '2026-10-15',
    now = '2026-10-15T15:00:00.000Z';
function setup() {
    const c = new FinancialCommitment(
        randomUUID(),
        space.value,
        'Purchase',
        actor.value,
        now,
        {
            version: 1,
            ownerPersonId: actor.value,
            amount: Money.from(20000),
            factDate: today,
        },
        [],
        today,
        1,
        [
            {
                id: randomUUID(),
                holderPersonId: actor.value,
                amountInCents: 20000,
                remainingAmountInCents: 20000,
                factDate: today,
                registeredAt: now,
                recordedByPersonId: actor.value,
            },
        ],
    );
    const access = {
        assertCanRead: vi.fn(async () => ({
            spaceId: space.value,
            type: 'PERSONAL' as const,
            status: 'ACTIVE' as const,
            actorMemberId: null,
        })),
        assertCanWrite: vi.fn(),
    };
    const context = {
        read: vi.fn(),
        lockForWrite: vi.fn(),
        lockForSettlement: vi.fn(),
        lockForFulfillment: vi.fn(),
    };
    const commitments = {
        find: vi.fn(async () => c),
        save: vi.fn(),
        saveDisbursement: vi.fn(),
        saveExternalLiability: vi.fn(),
        detail: vi.fn(),
    };
    const item = {
        commitmentId: c.id,
        commitmentVersion: 1,
        description: c.description,
        externalLiability: c.externalLiabilities[0],
    };
    const settlements = {
        listOpen: vi.fn(async () => [item]),
        findHolder: vi.fn(),
        saveExternalLiabilitySettlement: vi.fn(),
    };
    return {
        query: new ExternalLiabilityQueries(
            access,
            context,
            commitments,
            settlements,
            { today: () => today, now: () => new Date(now) },
        ),
        access,
        context,
        commitments,
        settlements,
        c,
        item,
    };
}
describe('External liability queries', () => {
    it('lists only current holder and never invokes write ports', async () => {
        const f = setup();
        expect(await f.query.list(actor, space)).toMatchObject({
            items: [f.item],
            nextCursor: null,
            canSettle: true,
        });
        expect(f.settlements.listOpen).toHaveBeenCalledWith(
            space.value,
            { personId: actor.value },
            null,
        );
        expect(f.access.assertCanRead).toHaveBeenCalledTimes(2);
        expect(f.access.assertCanWrite).not.toHaveBeenCalled();
        expect(
            f.settlements.saveExternalLiabilitySettlement,
        ).not.toHaveBeenCalled();
    });
    it('binds pagination to actor and space', async () => {
        const f = setup();
        f.settlements.listOpen.mockResolvedValueOnce(
            Array.from({ length: 21 }, (_, i) => ({
                ...f.item,
                externalLiability: {
                    ...f.item.externalLiability,
                    id: randomUUID(),
                    amountInCents: i + 1,
                },
            })),
        );
        const page = await f.query.list(actor, space);
        expect(page.items).toHaveLength(20);
        expect(page.nextCursor).toBeTypeOf('string');
        await f.query.list(actor, space, page.nextCursor!);
        expect(f.settlements.listOpen).toHaveBeenLastCalledWith(
            space.value,
            { personId: actor.value },
            { targetDate: today, id: page.items[19].externalLiability.id },
        );
        await expect(
            f.query.list(PersonId.from(randomUUID()), space, page.nextCursor!),
        ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
        await expect(
            f.query.list(actor, SpaceId.from(randomUUID()), page.nextCursor!),
        ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    });
    it('rechecks access after read and hides data when membership was removed', async () => {
        const f = setup();
        f.access.assertCanRead
            .mockResolvedValueOnce({
                spaceId: space.value,
                type: 'PERSONAL',
                status: 'ACTIVE',
                actorMemberId: null,
            })
            .mockRejectedValueOnce(new Error('removed'));
        await expect(f.query.list(actor, space)).rejects.toThrow('removed');
    });
    it('offers current version, amount, and history then disables fully settled origin', async () => {
        const f = setup(),
            liability = f.c.externalLiabilities[0];
        expect(
            await f.query.options(actor, space, f.c.id, liability.id),
        ).toMatchObject({
            expectedCommitmentVersion: 1,
            canSettle: true,
            externalLiability: liability,
        });
        f.commitments.find.mockResolvedValueOnce(
            f.c.settleExternalLiability(
                liability.id,
                {
                    id: randomUUID(),
                    amountInCents: 20000,
                    factDate: today,
                    registeredAt: now,
                    recordedByPersonId: actor.value,
                },
                1,
                today,
            ),
        );
        expect(
            await f.query.options(actor, space, f.c.id, liability.id),
        ).toMatchObject({
            expectedCommitmentVersion: 2,
            canSettle: false,
            externalLiability: { remainingAmountInCents: 0 },
        });
    });
});
