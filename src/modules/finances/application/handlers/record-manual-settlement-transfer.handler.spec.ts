import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { UnitOfWork } from '../../../../shared/application/unit-of-work.js';
import type { SpaceFinancialContextPort } from '../../../spaces/application/ports/public/space-financial-context.port.js';
import { PersonId } from '../../../spaces/domain/person/person-id.js';
import { SpaceId } from '../../../spaces/domain/space/space-id.js';
import { FinancesError } from '../../domain/errors/finances.error.js';
import { InterMemberObligation } from '../../domain/shared-expense/inter-member-obligation.js';
import type { SettlementAllocation } from '../../domain/settlement-transfer/settlement-transfer.js';
import type {
    RecordSettlementTransferCommand,
    SettlementTransferResult,
} from '../models/settlement-transfer.js';
import type {
    SettlementTransferReceipts,
    SettlementTransferRepository,
} from '../ports/private/settlement-transfer.repository.js';
import type { FinancesClock } from '../ports/private/shared-expense.repositories.js';
import { RecordManualSettlementTransferHandler } from './record-manual-settlement-transfer.handler.js';

function setup() {
    const actor = randomUUID(),
        other = randomUUID(),
        payer = randomUUID(),
        recipient = randomUUID(),
        space = randomUUID(),
        id = randomUUID();
    const context = {
        spaceId: space,
        type: 'SHARED' as const,
        status: 'CLOSING' as const,
        version: 2,
        actorMemberId: recipient,
        members: [
            { memberId: payer, personId: other, displayName: 'Pagador' },
            { memberId: recipient, personId: actor, displayName: 'Recebedor' },
        ],
    };
    let obligation = new InterMemberObligation(
        id,
        space,
        randomUUID(),
        randomUUID(),
        payer,
        recipient,
        20000,
        null,
        '2026-10-01',
        '2026-10-01T10:00:00.000Z',
        actor,
    );
    let result: SettlementTransferResult | null = null;
    const uow: UnitOfWork = { execute: (work) => work() };
    const access: SpaceFinancialContextPort = {
        read: vi.fn(async () => context),
        lockForWrite: vi.fn(async () => context),
        lockForSettlement: vi.fn(async () => context),
        lockForFulfillment: vi.fn(async () => context),
    };
    const repo: SettlementTransferRepository = {
        discover: vi.fn(async () => [{ id, cycleId: null }]),
        lockCycles: vi.fn(async () => {}),
        lockObligations: vi.fn(async () => [obligation]),
        save: vi.fn(async (transfer, _before, after) => {
            obligation = after[0];
            result = {
                replayed: false,
                spaceId: space,
                transfer: {
                    id: transfer.id,
                    payerMemberId: payer,
                    recipientMemberId: recipient,
                    amountInCents: transfer.amountInCents,
                    factDate: transfer.factDate,
                    registeredAt: transfer.registeredAt,
                    createdByPersonId: actor,
                    mode: 'MANUAL',
                },
                allocations: transfer.allocations.map(
                    (a: SettlementAllocation) => ({
                        ...a,
                        origin: {
                            commitmentId: obligation.originCommitmentId,
                            disbursementId: obligation.originDisbursementId,
                            description: 'Origem',
                        },
                    }),
                ),
                affectedCycleIds: [],
            };
        }),
        detail: vi.fn(async () => result),
        options: vi.fn(async () => ({
            payable: '0',
            receivable: '0',
            items: [],
        })),
        history: vi.fn(async () => ({ items: [] })),
        hasCycle: vi.fn(async () => true),
        hasObligation: vi.fn(async () => true),
    };
    const receipts: SettlementTransferReceipts = {
        find: vi.fn(async () => null),
        save: vi.fn(async () => {}),
    };
    const clock: FinancesClock = {
        now: () => new Date('2026-10-10T15:00:00Z'),
        today: () => '2026-10-10',
    };
    const command: RecordSettlementTransferCommand = {
        actorId: PersonId.from(actor),
        spaceId: SpaceId.from(space),
        idempotencyKey: randomUUID(),
        expectedSpaceVersion: 2,
        payerMemberId: payer,
        recipientMemberId: recipient,
        amountInCents: 7000,
        factDate: '2026-10-01',
        allocations: [
            {
                obligationId: id,
                expectedObligationVersion: 1,
                amountInCents: 7000,
            },
        ],
    };
    return {
        handler: new RecordManualSettlementTransferHandler(
            uow,
            access,
            repo,
            receipts,
            clock,
        ),
        repo,
        receipts,
        command,
        getObligation: () => obligation,
    };
}
describe('RecordManualSettlementTransfer application', () => {
    it('lets an authorized actor register another member’s payment in CLOSING', async () => {
        const f = setup();
        const response = await f.handler.execute(f.command);
        expect(response.transfer.createdByPersonId).toBe(
            f.command.actorId.value,
        );
        expect(response.transfer.payerMemberId).toBe(f.command.payerMemberId);
        expect(f.getObligation()).toMatchObject({
            status: 'PARTIALLY_SETTLED',
            remainingAmountInCents: 13000,
            version: 2,
        });
        expect(f.repo.lockCycles).toHaveBeenCalledOnce();
        expect(f.receipts.save).toHaveBeenCalledOnce();
    });
    it('rejects an obsolete version without writing any transfer', async () => {
        const f = setup();
        f.command.allocations[0].expectedObligationVersion = 2;
        await expect(f.handler.execute(f.command)).rejects.toMatchObject({
            code: 'CONCURRENT_MODIFICATION',
        });
        expect(f.repo.save).not.toHaveBeenCalled();
        expect(f.receipts.save).not.toHaveBeenCalled();
    });
    it('returns an authorized replay before checking stale context or balances', async () => {
        const f = setup();
        const first = await f.handler.execute(f.command);
        vi.mocked(f.receipts.find).mockResolvedValue(first);
        const replay = await f.handler.execute({
            ...f.command,
            expectedSpaceVersion: 2,
        });
        expect(replay.replayed).toBe(true);
        expect(f.repo.save).toHaveBeenCalledTimes(1);
    });
    it('rejects direction mismatch before saving the set', async () => {
        const f = setup();
        await expect(
            f.handler.execute({
                ...f.command,
                payerMemberId: f.command.recipientMemberId,
                recipientMemberId: f.command.payerMemberId,
            }),
        ).rejects.toBeInstanceOf(FinancesError);
        expect(f.repo.save).not.toHaveBeenCalled();
    });
});
