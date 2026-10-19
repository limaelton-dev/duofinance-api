import type { UnitOfWork } from '../../../../shared/application/unit-of-work.js';
import { describe, it, expect, vi } from 'vitest';
import { ConfigureDefaultSettlementRuleHandler } from './configure-default-settlement-rule.handler.js';
import { GetDefaultSettlementRuleQuery } from '../queries/get-default-settlement-rule.query.js';
import { PersonId } from '../../../spaces/domain/person/person-id.js';
import { SpaceId } from '../../../spaces/domain/space/space-id.js';
import type { SpaceAccessPort } from '../../../spaces/application/ports/public/space-access.port.js';
import type { SpaceFinancialContextPort } from '../../../spaces/application/ports/public/space-financial-context.port.js';
import type { DefaultSettlementRuleRepository } from '../ports/private/default-settlement-rule.repository.js';
import type { FinancesCommandReceipts } from '../ports/private/finances-command-receipts.js';
import { FinancesReceiptRaceError } from '../ports/private/finances-command-receipts.js';
import { DefaultSettlementRule } from '../../domain/default-settlement-rule/default-settlement-rule.js';
import { SettlementRule } from '../../domain/settlement-rule/settlement-rule.js';
import { SpacesDomainError } from '../../../spaces/domain/errors/spaces-domain.error.js';
import { FinancesError } from '../../domain/errors/finances.error.js';
function fixture() {
    const command = {
        actorId: PersonId.create(),
        spaceId: SpaceId.create(),
        key: 'key',
        expectedVersion: 0,
        rule: { kind: 'MONTHLY_DAY' as const, dayOfMonth: 10 },
    };
    const context = {
        spaceId: command.spaceId.value,
        type: 'SHARED' as const,
        status: 'ACTIVE' as const,
        actorMemberId: 'member',
    };
    const access = {
        assertCanRead: vi
            .fn<SpaceAccessPort['assertCanRead']>()
            .mockResolvedValue(context),
        assertCanWrite: vi
            .fn<SpaceAccessPort['assertCanWrite']>()
            .mockResolvedValue(context),
    };
    const repository = {
        find: vi
            .fn<DefaultSettlementRuleRepository['find']>()
            .mockResolvedValue(null),
        save: vi
            .fn<DefaultSettlementRuleRepository['save']>()
            .mockResolvedValue(),
    };
    const receipts = {
        find: vi.fn<FinancesCommandReceipts['find']>().mockResolvedValue(null),
        save: vi.fn<FinancesCommandReceipts['save']>().mockResolvedValue(),
    };
    const uow = { execute: vi.fn(async <T>(work: () => Promise<T>) => work()) };
    const readFinancialContext = vi
        .fn<SpaceFinancialContextPort['read']>()
        .mockResolvedValue({
            ...context,
            version: 1,
            members: [
                {
                    memberId: 'member',
                    personId: command.actorId.value,
                    displayName: 'Pessoa',
                },
            ],
        });
    const financialContexts: SpaceFinancialContextPort = {
        read: readFinancialContext,
        lockForWrite: readFinancialContext,
        lockForSettlement: readFinancialContext,
        lockForFulfillment: readFinancialContext,
    };
    return {
        command,
        context,
        access,
        repository,
        receipts,
        uow,
        handler: new ConfigureDefaultSettlementRuleHandler(
            uow as UnitOfWork,
            access,
            repository,
            receipts,
            financialContexts,
        ),
        query: new GetDefaultSettlementRuleQuery(access, repository),
    };
}
describe('ConfigureDefaultSettlementRuleHandler / query', () => {
    it('consulta ausência autorizada sem escrita e sem regra presumida', async () => {
        const f = fixture();
        expect(
            await f.query.execute(f.command.actorId, f.command.spaceId),
        ).toEqual({
            spaceId: f.command.spaceId.value,
            rule: null,
            version: 0,
            updatedAt: null,
        });
        expect(f.repository.save).not.toHaveBeenCalled();
        expect(f.receipts.save).not.toHaveBeenCalled();
        expect(f.access.assertCanWrite).not.toHaveBeenCalled();
    });
    it('configuração inicial cria v1/histórico/recibo na UoW', async () => {
        const f = fixture();
        const result = await f.handler.execute(f.command);
        expect(result).toMatchObject({
            version: 1,
            changed: true,
            replayed: false,
            rule: f.command.rule,
        });
        expect(f.repository.save).toHaveBeenCalledWith(
            expect.any(DefaultSettlementRule),
            0,
            f.command.actorId.value,
            null,
        );
        expect(f.receipts.save).toHaveBeenCalledWith(
            f.command,
            result,
            expect.any(Date),
        );
        expect(f.access.assertCanWrite).toHaveBeenCalledTimes(2);
        expect(f.uow.execute).toHaveBeenCalledTimes(1);
    });
    it('outro membro altera com snapshot anterior independente', async () => {
        const f = fixture();
        const aggregate = DefaultSettlementRule.create(
            f.command.spaceId.value,
            SettlementRule.from(f.command.rule),
            new Date('2026-01-01Z'),
        );
        f.repository.find.mockResolvedValue(aggregate);
        const result = await f.handler.execute({
            ...f.command,
            expectedVersion: 1,
            rule: { kind: 'MONTHLY_DAY', dayOfMonth: 20 },
        });
        expect(result.version).toBe(2);
        expect(f.repository.save).toHaveBeenCalledWith(
            aggregate,
            1,
            f.command.actorId.value,
            { kind: 'MONTHLY_DAY', dayOfMonth: 10 },
        );
    });
    it('no-op exige escrita, persiste só recibo e mantém v1', async () => {
        const f = fixture();
        f.repository.find.mockResolvedValue(
            DefaultSettlementRule.create(
                f.command.spaceId.value,
                SettlementRule.from(f.command.rule),
                new Date(),
            ),
        );
        expect(
            await f.handler.execute({ ...f.command, expectedVersion: 1 }),
        ).toMatchObject({ version: 1, changed: false });
        expect(f.repository.save).not.toHaveBeenCalled();
        expect(f.receipts.save).toHaveBeenCalledTimes(1);
        expect(f.access.assertCanWrite).toHaveBeenCalledTimes(2);
    });
    it('versão obsoleta conflita mesmo com mesmo valor', async () => {
        const f = fixture();
        f.repository.find.mockResolvedValue(
            DefaultSettlementRule.create(
                f.command.spaceId.value,
                SettlementRule.from(f.command.rule),
                new Date(),
            ),
        );
        await expect(f.handler.execute(f.command)).rejects.toMatchObject({
            code: 'CONCURRENT_MODIFICATION',
        });
        expect(f.receipts.save).not.toHaveBeenCalled();
    });
    it('replay autorizado retorna histórico sem executar nova escrita', async () => {
        const f = fixture();
        const original = {
            spaceId: f.command.spaceId.value,
            version: 1,
            rule: f.command.rule,
            updatedAt: '2026-01-01T00:00:00.000Z',
            changed: true,
            replayed: false,
        };
        f.receipts.find.mockResolvedValue(original);
        expect(await f.handler.execute(f.command)).toEqual({
            ...original,
            replayed: true,
        });
        expect(f.access.assertCanWrite).not.toHaveBeenCalled();
        expect(f.repository.find).not.toHaveBeenCalled();
        expect(f.repository.save).not.toHaveBeenCalled();
    });
    it.each(['CLOSING', 'CLOSED'] as const)(
        'replay em %s legível permitido; comando/no-op novo negado',
        async (status) => {
            const f = fixture();
            f.access.assertCanRead.mockResolvedValue({ ...f.context, status });
            f.access.assertCanWrite.mockRejectedValue(
                new SpacesDomainError('SPACE_NOT_ACTIVE'),
            );
            await expect(f.handler.execute(f.command)).rejects.toMatchObject({
                code: 'SPACE_NOT_ACTIVE',
            });
            expect(f.repository.save).not.toHaveBeenCalled();
        },
    );
    it('pessoal é inaplicável antes de consultar regra/recibo', async () => {
        const f = fixture();
        f.access.assertCanRead.mockResolvedValue({
            ...f.context,
            type: 'PERSONAL',
            actorMemberId: null,
        });
        await expect(f.handler.execute(f.command)).rejects.toMatchObject({
            code: 'SHARED_SPACE_REQUIRED',
        });
        await expect(
            f.query.execute(f.command.actorId, f.command.spaceId),
        ).rejects.toMatchObject({ code: 'SHARED_SPACE_REQUIRED' });
        expect(f.receipts.find).not.toHaveBeenCalled();
        expect(f.repository.find).not.toHaveBeenCalled();
    });
    it('revogação bloqueia replay antes de expor resultado', async () => {
        const f = fixture();
        f.access.assertCanRead.mockRejectedValue(
            new SpacesDomainError('SPACE_NOT_FOUND'),
        );
        await expect(f.handler.execute(f.command)).rejects.toMatchObject({
            code: 'SPACE_NOT_FOUND',
        });
        expect(f.receipts.find).not.toHaveBeenCalled();
    });
    it('revalida escrita antes da persistência e propaga perda de acesso', async () => {
        const f = fixture();
        f.access.assertCanWrite
            .mockResolvedValueOnce(f.context)
            .mockRejectedValueOnce(new SpacesDomainError('SPACE_NOT_FOUND'));
        await expect(f.handler.execute(f.command)).rejects.toMatchObject({
            code: 'SPACE_NOT_FOUND',
        });
        expect(f.repository.save).not.toHaveBeenCalled();
        expect(f.receipts.save).not.toHaveBeenCalled();
    });
    it('revalida estado antes de persistir', async () => {
        const f = fixture();
        f.access.assertCanWrite
            .mockResolvedValueOnce(f.context)
            .mockRejectedValueOnce(new SpacesDomainError('SPACE_NOT_ACTIVE'));
        await expect(f.handler.execute(f.command)).rejects.toMatchObject({
            code: 'SPACE_NOT_ACTIVE',
        });
        expect(f.repository.save).not.toHaveBeenCalled();
    });
    it.each([
        new FinancesReceiptRaceError(),
        new FinancesError('CONCURRENT_MODIFICATION'),
    ])(
        'recupera corrida somente após rollback e nova autorização',
        async (error) => {
            const f = fixture();
            const result = {
                spaceId: f.command.spaceId.value,
                rule: f.command.rule,
                version: 1,
                updatedAt: new Date().toISOString(),
                changed: true,
                replayed: false,
            };
            f.receipts.find
                .mockResolvedValueOnce(null)
                .mockResolvedValueOnce(result);
            f.repository.save.mockRejectedValueOnce(error);
            expect(await f.handler.execute(f.command)).toEqual({
                ...result,
                replayed: true,
            });
            expect(f.uow.execute).toHaveBeenCalledTimes(2);
            expect(f.access.assertCanRead).toHaveBeenCalledTimes(2);
        },
    );
    it('corrida com chave diferente mantém conflito; nunca transforma em sucesso', async () => {
        const f = fixture();
        f.repository.save.mockRejectedValue(
            new FinancesError('CONCURRENT_MODIFICATION'),
        );
        await expect(f.handler.execute(f.command)).rejects.toMatchObject({
            code: 'CONCURRENT_MODIFICATION',
        });
    });
    it('recuperação da corrida nega replay após revogação', async () => {
        const f = fixture();
        f.repository.save.mockRejectedValue(new FinancesReceiptRaceError());
        f.access.assertCanRead
            .mockResolvedValueOnce(f.context)
            .mockRejectedValueOnce(new SpacesDomainError('SPACE_NOT_FOUND'));
        await expect(f.handler.execute(f.command)).rejects.toMatchObject({
            code: 'SPACE_NOT_FOUND',
        });
        expect(f.receipts.find).toHaveBeenCalledTimes(1);
    });
    it('falha do recibo é propagada para rollback da UoW', async () => {
        const f = fixture();
        f.receipts.save.mockRejectedValue(new Error('failure'));
        await expect(f.handler.execute(f.command)).rejects.toThrow('failure');
        expect(f.uow.execute).toHaveBeenCalledTimes(1);
    });
    it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
        'versão %s inválida antes de qualquer efeito',
        async (expectedVersion) => {
            const f = fixture();
            await expect(
                f.handler.execute({ ...f.command, expectedVersion }),
            ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
            expect(f.uow.execute).not.toHaveBeenCalled();
        },
    );
});
