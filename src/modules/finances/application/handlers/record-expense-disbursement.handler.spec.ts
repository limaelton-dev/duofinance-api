import { describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { UnitOfWork } from '../../../../shared/application/unit-of-work.js';
import {
    FinancialCommitment,
    type PersonalCommitmentVersion,
    type ExpenseVersion,
} from '../../domain/shared-expense/financial-commitment.js';
import { Money } from '../../domain/shared-expense/money.js';
import { PersonId } from '../../../spaces/domain/person/person-id.js';
import { SpaceId } from '../../../spaces/domain/space/space-id.js';
import { FinancesError } from '../../domain/errors/finances.error.js';
import { SpacesDomainError } from '../../../spaces/domain/errors/spaces-domain.error.js';
import type { FinancialCommitmentRepository } from '../ports/private/shared-expense.repositories.js';
import type { ExpenseDisbursementReceipts } from '../ports/private/expense-disbursement.ports.js';
import type {
    ExpenseDisbursementResult,
    RecordExpenseDisbursementCommand,
} from '../models/expense-disbursement.js';
import { RecordExpenseDisbursementHandler } from './record-expense-disbursement.handler.js';
import { ReconcileFinancialOrigin } from './reconcile-financial-origin.js';
import type { SettlementAdjustmentRepository } from '../ports/private/settlement-adjustment.repository.js';
const actor = PersonId.from(randomUUID()),
    space = SpaceId.from(randomUUID()),
    today = '2026-10-15',
    now = '2026-10-15T12:00:00.000Z';
function setup() {
    let root: FinancialCommitment<ExpenseVersion> =
        new FinancialCommitment<PersonalCommitmentVersion>(
            randomUUID(),
            space.value,
            'Despesa',
            actor.value,
            now,
            {
                version: 1,
                ownerPersonId: actor.value,
                amount: Money.from(100000),
                factDate: today,
            },
            {
                id: randomUUID(),
                payerPersonId: actor.value,
                method: 'PIX',
                amountInCents: 30000,
                factDate: today,
                registeredAt: now,
            },
            today,
        );
    const access = {
        assertCanRead: vi.fn(async () => ({
            spaceId: space.value,
            type: 'PERSONAL' as const,
            status: 'ACTIVE' as const,
            actorMemberId: null,
        })),
        assertCanWrite: vi.fn(async () => ({
            spaceId: space.value,
            type: 'PERSONAL' as const,
            status: 'ACTIVE' as const,
            actorMemberId: null,
        })),
    };
    const context = {
        read: vi.fn(),
        lockForWrite: vi.fn(),
        lockForSettlement: vi.fn(),
        lockForFulfillment: vi.fn(),
    };
    const commitments: FinancialCommitmentRepository = {
        saveExternalLiability: vi.fn(),
        save: vi.fn(),
        detail: vi.fn(),
        find: vi.fn(async () => root),
        saveDisbursement: vi.fn(async (next) => {
            root = next;
        }),
    };
    const saved = new Map<string, ExpenseDisbursementResult>();
    const receipts: ExpenseDisbursementReceipts = {
        find: vi.fn(async (c) => saved.get(c.idempotencyKey) ?? null),
        save: vi.fn(async (c, r) => {
            saved.set(c.idempotencyKey, r);
        }),
    };
    const adjustments: SettlementAdjustmentRepository = {
        readSnapshot: async <T>(work: () => Promise<T>) => work(),
        findReceipt: vi.fn(),
        saveReceipt: vi.fn(),
        commitment: vi.fn(),
        saveRule: vi.fn(),
        effectiveRule: vi.fn<SettlementAdjustmentRepository['effectiveRule']>(
            async (_space, _commitment, rule, version) => ({
                source: 'INHERITED',
                rule,
                version,
            }),
        ),
        cycle: vi.fn(),
        cycleForDate: vi.fn(),
        createCycleForDate: vi.fn(),
        lockCycles: vi.fn(),
        saveAssignment: vi.fn(),
        options: vi.fn(),
    };
    const reconcile = new ReconcileFinancialOrigin(
        {
            save: vi.fn(),
            history: vi.fn(),
            originState: vi.fn(),
            lockOrigin: vi.fn(),
            saveReconciliation: vi.fn(),
        },
        { lockExisting: vi.fn(), lockForDate: vi.fn(), listOpen: vi.fn() },
        adjustments,
    );
    const reconcileSpy = vi.spyOn(reconcile, 'execute');
    const uow = { execute: vi.fn(async <T>(work: () => Promise<T>) => work()) };
    const handler = new RecordExpenseDisbursementHandler(
        uow as UnitOfWork,
        access,
        context,
        commitments,
        receipts,
        { today: () => today, now: () => new Date(now) },
        reconcile,
    );
    const command: RecordExpenseDisbursementCommand = {
        actorId: actor,
        spaceId: space,
        commitmentId: root.id,
        idempotencyKey: randomUUID(),
        amountInCents: 20000,
        expectedCommitmentVersion: 1,
        factDate: '2026-10-13',
        method: 'CASH',
    };
    return {
        handler,
        command,
        access,
        context,
        commitments,
        receipts,
        reconcileSpy,
        uow,
        root: () => root,
    };
}
describe('RecordExpenseDisbursement application', () => {
    it('records a separate fact from a retroactive date and preserves original identity and amount', async () => {
        const f = setup(),
            initial = f.root(),
            result = await f.handler.execute(f.command);
        expect(result.commitment).toMatchObject({
            id: initial.id,
            amountInCents: 100000,
            version: 2,
        });
        expect(result).toMatchObject({
            paidAmountInCents: 50000,
            remainingAmountInCents: 50000,
            status: 'PARTIALLY_PAID',
        });
        expect(result.disbursement!.id).toBe(initial.disbursement!.id);
        expect(result.disbursements).toHaveLength(2);
        expect(result.disbursements[1]).toMatchObject({
            payerPersonId: actor.value,
            recordedByPersonId: actor.value,
            factDate: '2026-10-13',
            amountInCents: 20000,
        });
        expect(f.context.lockForFulfillment).not.toHaveBeenCalled();
        expect(f.reconcileSpy).not.toHaveBeenCalled();
        expect(f.uow.execute).toHaveBeenCalledOnce();
    });
    it('replays the original attempt after another fact, rechecking access without creating a fact', async () => {
        const f = setup(),
            first = await f.handler.execute(f.command);
        await f.handler.execute({
            ...f.command,
            idempotencyKey: randomUUID(),
            expectedCommitmentVersion: 2,
            amountInCents: 50000,
        });
        expect(await f.handler.execute(f.command)).toEqual({
            ...first,
            replayed: true,
        });
        expect(f.root().disbursements).toHaveLength(3);
        expect(f.access.assertCanRead).toHaveBeenCalledTimes(3);
        expect(f.commitments.saveDisbursement).toHaveBeenCalledTimes(2);
    });
    it('refuses an inaccessible replay before reading its receipt', async () => {
        const f = setup();
        await f.handler.execute(f.command);
        vi.mocked(f.receipts.find).mockClear();
        f.access.assertCanRead.mockRejectedValue(
            new SpacesDomainError('SPACE_NOT_FOUND'),
        );
        await expect(f.handler.execute(f.command)).rejects.toMatchObject({
            code: 'SPACE_NOT_FOUND',
        });
        expect(f.receipts.find).not.toHaveBeenCalled();
    });
    it('refuses stale versions before persisting another payment', async () => {
        const f = setup();
        f.command.expectedCommitmentVersion = 2;
        await expect(f.handler.execute(f.command)).rejects.toMatchObject({
            code: 'CONCURRENT_MODIFICATION',
        });
        expect(f.commitments.saveDisbursement).not.toHaveBeenCalled();
        expect(f.receipts.save).not.toHaveBeenCalled();
    });
    it.each([0, -1, 0.5, 70001, Number.MAX_SAFE_INTEGER + 1, Infinity])(
        'refuses invalid amount %s without persisting it',
        async (amountInCents) => {
            const f = setup();
            await expect(
                f.handler.execute({ ...f.command, amountInCents }),
            ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
            expect(f.commitments.saveDisbursement).not.toHaveBeenCalled();
        },
    );
    it('refuses shared fields in the personal context', async () => {
        const f = setup();
        await expect(
            f.handler.execute({
                ...f.command,
                payerMemberId: randomUUID(),
                expectedSpaceVersion: 1,
                settlement: { mode: 'NONE' },
            }),
        ).rejects.toMatchObject({ code: 'PERSONAL_SPACE_REQUIRED' });
        expect(f.commitments.find).not.toHaveBeenCalled();
    });
    it('refuses an origin absent from this space', async () => {
        const f = setup();
        vi.mocked(f.commitments.find).mockResolvedValue(null);
        await expect(f.handler.execute(f.command)).rejects.toMatchObject({
            code: 'FINANCIAL_COMMITMENT_NOT_FOUND',
        });
        expect(f.receipts.save).not.toHaveBeenCalled();
    });
    it('returns an attempt that committed while waiting for the root lock', async () => {
        const f = setup(),
            first = await f.handler.execute(f.command);
        vi.mocked(f.receipts.find)
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce(first);
        vi.mocked(f.commitments.saveDisbursement).mockClear();
        expect(await f.handler.execute(f.command)).toEqual({
            ...first,
            replayed: true,
        });
        expect(f.commitments.saveDisbursement).not.toHaveBeenCalled();
    });
    it('propagates a receipt failure through the same unit of work', async () => {
        const f = setup();
        vi.mocked(f.receipts.save).mockRejectedValue(
            new FinancesError('IDEMPOTENCY_KEY_REUSED'),
        );
        await expect(f.handler.execute(f.command)).rejects.toMatchObject({
            code: 'IDEMPOTENCY_KEY_REUSED',
        });
        expect(f.uow.execute).toHaveBeenCalledOnce();
    });
});
