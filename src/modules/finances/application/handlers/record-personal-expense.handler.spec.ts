import { describe, it, expect, vi } from 'vitest';
import type { UnitOfWork } from '../../../../shared/application/unit-of-work.js';
import { RecordPersonalExpenseHandler } from './record-personal-expense.handler.js';
import { PersonId } from '../../../spaces/domain/person/person-id.js';
import { SpaceId } from '../../../spaces/domain/space/space-id.js';
import { SpacesDomainError } from '../../../spaces/domain/errors/spaces-domain.error.js';
import {
    ExpenseReceiptRaceError,
    type FinancialCommitmentRepository,
} from '../ports/private/shared-expense.repositories.js';
import type { SpaceAccessContext } from '../../../spaces/application/ports/public/space-access.port.js';
import type {
    RecordPersonalExpenseCommand,
    PersonalExpenseResult,
} from '../models/personal-expense.js';
const command = (): RecordPersonalExpenseCommand => ({
    actorId: PersonId.from('00000000-0000-4000-8000-000000000001'),
    spaceId: SpaceId.from('00000000-0000-4000-8000-000000000002'),
    idempotencyKey: '00000000-0000-4000-8000-000000000003',
    description: ' Consulta ',
    amountInCents: 12000,
    factDate: '2026-10-14',
    disbursement: { method: 'PIX' },
});
function setup() {
    const context: SpaceAccessContext = {
        spaceId: command().spaceId.value,
        type: 'PERSONAL',
        status: 'ACTIVE',
        actorMemberId: null,
    };
    const access = {
        assertCanRead: vi.fn(async () => context),
        assertCanWrite: vi.fn(async () => context),
    };
    const commitments: FinancialCommitmentRepository = {
        find: vi.fn(),
        saveDisbursement: vi.fn(),
        save: vi.fn(),
        detail: vi.fn(),
    };
    const receipts = {
        find: vi.fn<() => Promise<PersonalExpenseResult | null>>(
            async () => null,
        ),
        save: vi.fn(),
    };
    const uow = { execute: vi.fn(async <T>(work: () => Promise<T>) => work()) };
    const handler = new RecordPersonalExpenseHandler(
        uow as UnitOfWork,
        access,
        commitments,
        receipts,
        {
            now: () => new Date('2026-10-14T15:00:00Z'),
            today: () => '2026-10-14',
        },
    );
    return { handler, access, commitments, receipts, uow, context };
}
describe('RecordPersonalExpense', () => {
    it('uses only public access, root and receipt ports in one transaction', async () => {
        const s = setup(),
            c = command(),
            r = await s.handler.execute(c);
        expect(s.access.assertCanWrite).toHaveBeenCalledWith(
            c.actorId,
            c.spaceId,
        );
        expect(s.uow.execute).toHaveBeenCalledOnce();
        expect(r.commitment).toMatchObject({
            ownerPersonId: c.actorId.value,
            createdByPersonId: c.actorId.value,
            description: 'Consulta',
            amountInCents: 12000,
        });
        expect(r.disbursement).toMatchObject({
            payerPersonId: c.actorId.value,
            amountInCents: 12000,
        });
        expect(s.commitments.save).toHaveBeenCalledOnce();
        expect(s.receipts.save).toHaveBeenCalledOnce();
        for (const field of ['members', 'obligation', 'settlementCycle'])
            expect(r).not.toHaveProperty(field);
    });
    it('revalidates authorization for replay and performs no additional write', async () => {
        const s = setup(),
            r = await s.handler.execute(command());
        s.receipts.find.mockResolvedValue(r);
        expect(await s.handler.execute(command())).toEqual({
            ...r,
            replayed: true,
        });
        expect(s.access.assertCanWrite).toHaveBeenCalledTimes(2);
        expect(s.commitments.save).toHaveBeenCalledOnce();
    });
    it('rejects SHARED before receipt or finance writes', async () => {
        const s = setup();
        s.context.type = 'SHARED';
        await expect(s.handler.execute(command())).rejects.toMatchObject({
            code: 'PERSONAL_SPACE_REQUIRED',
        });
        expect(s.receipts.find).not.toHaveBeenCalled();
        expect(s.commitments.save).not.toHaveBeenCalled();
    });
    it('rejects inaccessible personal space before a replay', async () => {
        const s = setup();
        s.access.assertCanWrite.mockRejectedValue(
            new SpacesDomainError('SPACE_NOT_FOUND'),
        );
        await expect(s.handler.execute(command())).rejects.toMatchObject({
            code: 'SPACE_NOT_FOUND',
        });
        expect(s.receipts.find).not.toHaveBeenCalled();
    });
    it.each(['2026-10-15', '2026-02-30'])(
        'rejects %s before writes',
        async (factDate) => {
            const s = setup();
            await expect(
                s.handler.execute({ ...command(), factDate }),
            ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
            expect(s.commitments.save).not.toHaveBeenCalled();
        },
    );
    it('reads a race winner in a new authorized transaction', async () => {
        const s = setup(),
            r = await s.handler.execute(command());
        s.receipts.save.mockRejectedValueOnce(new ExpenseReceiptRaceError());
        s.receipts.find.mockResolvedValueOnce(null).mockResolvedValueOnce(r);
        expect(await s.handler.execute(command())).toEqual({
            ...r,
            replayed: true,
        });
        expect(s.uow.execute).toHaveBeenCalledTimes(3);
        expect(s.access.assertCanRead).toHaveBeenCalledOnce();
    });
    it('does not reinterpret unrelated persistence errors as replay', async () => {
        const s = setup(),
            error = new Error('unrelated constraint');
        s.commitments.save = vi.fn().mockRejectedValue(error);
        await expect(s.handler.execute(command())).rejects.toBe(error);
        expect(s.uow.execute).toHaveBeenCalledOnce();
    });
});
