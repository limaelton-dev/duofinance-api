import { describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { SettleExternalLiabilityHandler } from './settle-external-liability.handler.js';
import {
    FinancialCommitment,
    type ExpenseVersion,
} from '../../domain/shared-expense/financial-commitment.js';
import { Money } from '../../domain/shared-expense/money.js';
import { PersonId } from '../../../spaces/domain/person/person-id.js';
import { SpaceId } from '../../../spaces/domain/space/space-id.js';
import { FinancesError } from '../../domain/errors/finances.error.js';
import type {
    ExternalLiabilitySettlementResult,
    SettleExternalLiabilityCommand,
} from '../models/external-liability-settlement.js';
import { externalLiabilitySettlementCommandHash } from '../../infrastructure/typeorm/repositories/typeorm-external-liability-settlement-receipts.js';
import { ExpenseReceiptRaceError } from '../ports/private/shared-expense.repositories.js';
const today = '2026-10-15',
    now = '2026-10-15T15:00:00.000Z';
function setup() {
    const actor = PersonId.from(randomUUID()),
        space = SpaceId.from(randomUUID()),
        liabilityId = randomUUID();
    let root: FinancialCommitment<ExpenseVersion> = new FinancialCommitment(
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
                id: liabilityId,
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
        save: vi.fn(),
        saveDisbursement: vi.fn(),
        saveExternalLiability: vi.fn(),
        find: vi.fn(async () => root),
        detail: vi.fn(),
    };
    const settlements = {
        findHolder: vi.fn(async () => ({
            holderPersonId: actor.value,
            holderMemberId: null,
            personalOwnerPersonId: actor.value,
        })),
        saveExternalLiabilitySettlement: vi.fn(
            async (next: FinancialCommitment<ExpenseVersion>) => {
                root = next;
            },
        ),
        listOpen: vi.fn(),
    };
    const saved = new Map<
        string,
        { hash: Buffer; result: ExternalLiabilitySettlementResult }
    >();
    const receipts = {
        find: vi.fn(async (c: SettleExternalLiabilityCommand) => {
            const existing = saved.get(c.idempotencyKey);
            if (
                existing &&
                !existing.hash.equals(externalLiabilitySettlementCommandHash(c))
            )
                throw new FinancesError('IDEMPOTENCY_KEY_REUSED');
            return existing?.result ?? null;
        }),
        save: vi.fn(
            async (
                c: SettleExternalLiabilityCommand,
                result: ExternalLiabilitySettlementResult,
            ) => {
                saved.set(c.idempotencyKey, {
                    hash: externalLiabilitySettlementCommandHash(c),
                    result,
                });
            },
        ),
    };
    const uow = {
        execute: async <T>(work: () => Promise<T>) => {
            const before = root;
            try {
                return await work();
            } catch (error) {
                root = before;
                throw error;
            }
        },
    };
    const handler = new SettleExternalLiabilityHandler(
        uow,
        access,
        context,
        commitments,
        settlements,
        receipts,
        { today: () => today, now: () => new Date(now) },
    );
    const command: SettleExternalLiabilityCommand = {
        actorId: actor,
        spaceId: space,
        commitmentId: root.id,
        externalLiabilityId: liabilityId,
        idempotencyKey: randomUUID(),
        amountInCents: 6000,
        factDate: today,
        expectedCommitmentVersion: 1,
    };
    return {
        handler,
        command,
        access,
        context,
        commitments,
        settlements,
        receipts,
        root: () => root,
    };
}
describe('SettleExternalLiability application', () => {
    it('persists the later cash fact with immutable author/holder and independent totals', async () => {
        const f = setup(),
            r = await f.handler.execute(f.command);
        expect(r).toMatchObject({
            externalSettledAmountInCents: 6000,
            externalOutstandingAmountInCents: 14000,
            paidAmountInCents: 0,
            assumedAmountInCents: 20000,
            supportedAmountInCents: 20000,
            replayed: false,
            commitment: { version: 2 },
        });
        expect(r.settlement).toMatchObject({
            holderPersonId: f.command.actorId.value,
            recordedByPersonId: f.command.actorId.value,
            externalLiabilityId: f.command.externalLiabilityId,
            amountInCents: 6000,
        });
        expect(f.commitments.saveDisbursement).not.toHaveBeenCalled();
        expect(f.commitments.saveExternalLiability).not.toHaveBeenCalled();
    });
    it('replays the historical result after later settlements and rejects changed payload', async () => {
        const f = setup(),
            initial = await f.handler.execute(f.command);
        await f.handler.execute({
            ...f.command,
            idempotencyKey: randomUUID(),
            amountInCents: 14000,
            expectedCommitmentVersion: 2,
        });
        const replay = await f.handler.execute(f.command);
        expect(replay).toEqual({ ...initial, replayed: true });
        expect(f.root().externalOutstandingAmountInCents).toBe(0);
        expect(
            f.settlements.saveExternalLiabilitySettlement,
        ).toHaveBeenCalledTimes(2);
        await expect(
            f.handler.execute({ ...f.command, amountInCents: 6001 }),
        ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
    });
    it('checks current authorization and holder before looking up a receipt', async () => {
        const f = setup();
        await f.handler.execute(f.command);
        f.receipts.find.mockClear();
        f.access.assertCanRead.mockRejectedValueOnce(new Error('removed'));
        await expect(f.handler.execute(f.command)).rejects.toThrow('removed');
        expect(f.receipts.find).not.toHaveBeenCalled();
        f.settlements.findHolder.mockResolvedValueOnce({
            holderMemberId: null,
            holderPersonId: randomUUID(),
            personalOwnerPersonId: f.command.actorId.value,
        });
        await expect(f.handler.execute(f.command)).rejects.toMatchObject({
            code: 'EXTERNAL_LIABILITY_HOLDER_REQUIRED',
        });
        expect(f.receipts.find).not.toHaveBeenCalled();
    });
    it('uses a single immutable holder read before replay, not a torn aggregate', async () => {
        const f = setup();
        await f.handler.execute(f.command);
        f.commitments.find.mockClear();
        await f.handler.execute(f.command);
        expect(f.commitments.find).not.toHaveBeenCalled();
        expect(f.settlements.findHolder).toHaveBeenCalledTimes(2);
    });
    it('rolls back fact and version if the receipt fails', async () => {
        const f = setup(),
            before = f.root();
        f.receipts.save.mockRejectedValueOnce(new Error('receipt failed'));
        await expect(f.handler.execute(f.command)).rejects.toThrow(
            'receipt failed',
        );
        expect(f.root()).toBe(before);
    });
    it('rejects stale versions, invalid amounts, unknown origins, and wrong scope versions before writes', async () => {
        const f = setup();
        await expect(
            f.handler.execute({ ...f.command, expectedCommitmentVersion: 2 }),
        ).rejects.toMatchObject({ code: 'CONCURRENT_MODIFICATION' });
        await expect(
            f.handler.execute({ ...f.command, amountInCents: 20001 }),
        ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
        await expect(
            f.handler.execute({ ...f.command, expectedSpaceVersion: 1 }),
        ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
        f.settlements.findHolder.mockResolvedValueOnce(null as never);
        await expect(f.handler.execute(f.command)).rejects.toMatchObject({
            code: 'EXTERNAL_LIABILITY_NOT_FOUND',
        });
        expect(
            f.settlements.saveExternalLiabilitySettlement,
        ).not.toHaveBeenCalled();
    });
    it('reauthorizes receipt-race recovery', async () => {
        const f = setup();
        f.receipts.save.mockRejectedValueOnce(new ExpenseReceiptRaceError());
        f.access.assertCanRead
            .mockResolvedValueOnce({
                spaceId: f.command.spaceId.value,
                type: 'PERSONAL',
                status: 'ACTIVE',
                actorMemberId: null,
            })
            .mockRejectedValueOnce(new Error('removed during race'));
        await expect(f.handler.execute(f.command)).rejects.toThrow(
            'removed during race',
        );
        expect(f.root().version).toBe(1);
    });
});
