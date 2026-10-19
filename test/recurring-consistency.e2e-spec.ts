import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import 'reflect-metadata';
import { DataSource } from 'typeorm';
import {
    afterEach,
    beforeAll,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { AppModule } from '../dist/app.module.js';
import { TODAY_CLOCK } from '../dist/composition/today/today.clock.js';
import { configureApp } from '../dist/configure-app.js';
import { RecurringCommitmentHandler } from '../dist/modules/finances/application/handlers/recurring-commitment.handler.js';
import {
    RECURRING_COMMITMENT_REPOSITORY,
    type RecurringCommitmentRepository,
} from '../dist/modules/finances/application/ports/private/recurring-commitment.repository.js';
import { FINANCES_CLOCK } from '../dist/modules/finances/application/ports/private/shared-expense.repositories.js';
import {
    SPACE_ACCESS_PORT,
    type SpaceAccessPort,
} from '../dist/modules/spaces/application/ports/public/space-access.port.js';
import { PersonId } from '../dist/modules/spaces/domain/person/person-id.js';
import { SpaceId } from '../dist/modules/spaces/domain/space/space-id.js';
import migrationSource from '../dist/shared/technical/database/typeorm/data-source.js';
import { EntityManagerProvider } from '../dist/shared/technical/database/typeorm/entity-manager.provider.js';
import { financeBase, financeBrowser } from './settlement-fixture.js';
import { TEST_DATABASE_URL } from './setup-env.js';

describe('Recurring read consistency and HTTP input validation', () => {
    let app: INestApplication<Server>;
    let db: DataSource;
    const instant = new Date('2026-10-14T15:00:00Z');
    const today = () => '2026-10-14';

    beforeAll(async () => {
        if (
            migrationSource.options.type !== 'postgres' ||
            migrationSource.options.url !== TEST_DATABASE_URL
        )
            throw new Error('Expected disposable PostgreSQL');
        await migrationSource.initialize();
        try {
            await migrationSource.dropDatabase();
            await migrationSource.runMigrations();
        } finally {
            await migrationSource.destroy();
        }
    });
    beforeEach(async () => {
        const module = await Test.createTestingModule({ imports: [AppModule] })
            .overrideProvider(FINANCES_CLOCK)
            .useValue({ now: () => instant, today })
            .overrideProvider(TODAY_CLOCK)
            .useValue({ now: () => instant })
            .compile();
        app = module.createNestApplication();
        configureApp(app);
        await app.init();
        db = app.get(DataSource);
        await db.query('TRUNCATE persons CASCADE');
    });
    afterEach(async () => {
        vi.restoreAllMocks();
        await app?.close();
    });

    async function recurring() {
        const browser = await financeBrowser(app);
        const space = browser.context.personalSpace.id as string;
        const base = `${financeBase(space)}/recurring-commitments`;
        const input = {
            scope: 'PERSONAL' as const,
            valueMode: 'VARIABLE' as const,
            kind: 'EXPENSE' as const,
            description: 'Energia',
            expectedAmountInCents: 1000,
            recurrence: { frequency: 'MONTHLY' as const, dayOfMonth: 14 },
            startsOn: '2026-10-01',
        };
        const root = (await browser.post(base, input).expect(201)).body
            .commitment;
        return { browser, space, base, input, root };
    }

    it.each(['occurrences', 'options', 'detail'] as const)(
        'keeps %s coherent while a separate writer commits version and materialization',
        async (kind) => {
            const f = await recurring();
            const handler = app.get(RecurringCommitmentHandler);
            const repository = app.get<RecurringCommitmentRepository>(
                RECURRING_COMMITMENT_REPOSITORY,
            );
            const provider = app.get(EntityManagerProvider);
            const access = app.get<SpaceAccessPort>(SPACE_ACCESS_PORT);
            const originalFind = repository.find.bind(repository);
            const runWriter = AsyncLocalStorage.snapshot();
            const actorId = PersonId.from(f.browser.context.person.id);
            const spaceId = SpaceId.from(f.space);
            let writing = false;
            let writerPid = 0;
            let readerPid = 0;
            let afterWriter: unknown;
            const authorizations: boolean[] = [];
            const originalAccess = access.assertCanRead.bind(access);
            vi.spyOn(access, 'assertCanRead').mockImplementation(
                async (...args) => {
                    if (!writing)
                        authorizations.push(
                            !!provider.get().queryRunner?.isTransactionActive,
                        );
                    return originalAccess(...args);
                },
            );
            const saveVersion = repository.saveVersion.bind(repository);
            vi.spyOn(repository, 'saveVersion').mockImplementation(
                async (...args) => {
                    writerPid = (
                        await provider
                            .get()
                            .query('SELECT pg_backend_pid() AS pid')
                    )[0].pid;
                    return saveVersion(...args);
                },
            );
            const snapshot = async () =>
                (
                    await db.query(
                        `SELECT
                  (SELECT count(*)::int FROM financial_occurrences) AS occurrences,
                  (SELECT count(*)::int FROM financial_recurrence_versions) AS versions,
                  (SELECT count(*)::int FROM financial_command_audit) AS audit,
                  (SELECT count(*)::int FROM financial_recurrence_command_receipts) AS receipts`,
                    )
                )[0];
            vi.spyOn(repository, 'find').mockImplementationOnce(
                async (...args) => {
                    const root = await originalFind(...args);
                    const manager = provider.get();
                    expect(
                        (await manager.query('SHOW transaction_isolation'))[0]
                            .transaction_isolation,
                    ).toBe('repeatable read');
                    expect(
                        (await manager.query('SHOW transaction_read_only'))[0]
                            .transaction_read_only,
                    ).toBe('on');
                    readerPid = (
                        await manager.query('SELECT pg_backend_pid() AS pid')
                    )[0].pid;
                    writing = true;
                    try {
                        await runWriter(async () => {
                            await handler.changeVersion({
                                ...f.input,
                                actorId,
                                spaceId,
                                commitmentId: f.root.id,
                                idempotencyKey: randomUUID(),
                                effectiveFrom: '2026-11-01',
                                expectedCommitmentVersion: 1,
                                expectedAmountInCents: 2000,
                            });
                            await handler.setValue({
                                actorId,
                                spaceId,
                                commitmentId: f.root.id,
                                idempotencyKey: randomUUID(),
                                referenceDate: '2026-11-14',
                                expectedCommitmentVersion: 2,
                                expectedOccurrenceVersion: 1,
                                amountInCents: 2500,
                            });
                            afterWriter = await snapshot();
                        });
                    } finally {
                        writing = false;
                    }
                    return root;
                },
            );
            const path =
                kind === 'detail'
                    ? `${f.base}/${f.root.id}`
                    : kind === 'options'
                      ? `${f.base}/${f.root.id}/occurrences/2026-11-14/options`
                      : `${f.base}/${f.root.id}/occurrences?month=2026-11`;
            const old = (await f.browser.agent.get(path).expect(200)).body;
            expect(writerPid).not.toBe(readerPid);
            expect(authorizations).toEqual([false, false]);
            if (kind === 'detail')
                expect(old.commitment.economicVersion).toBe(1);
            else {
                const occurrence =
                    kind === 'options' ? old.occurrence : old.items[0];
                expect(occurrence).toMatchObject({
                    id: null,
                    economicVersion: 1,
                    amountInCents: null,
                    expectedAmountInCents: 1000,
                    facts: [],
                });
            }
            expect(await snapshot()).toEqual(afterWriter);
            const fresh = (await f.browser.agent.get(path).expect(200)).body;
            if (kind === 'detail')
                expect(fresh.commitment.economicVersion).toBe(2);
            else {
                const occurrence =
                    kind === 'options' ? fresh.occurrence : fresh.items[0];
                expect(occurrence).toMatchObject({
                    economicVersion: 2,
                    amountInCents: 2500,
                    expectedAmountInCents: 2000,
                });
                expect(occurrence.id).toEqual(expect.any(String));
            }
            expect(await snapshot()).toEqual(afterWriter);
        },
    );

    it.each(['2026-13', '2026-00', '0000-10', '2026-1', '2026-10-01'])(
        'rejects invalid month %s on list and occurrences before repository reads',
        async (month) => {
            const f = await recurring();
            const repo = app.get<RecurringCommitmentRepository>(
                RECURRING_COMMITMENT_REPOSITORY,
            );
            const find = vi.spyOn(repo, 'find');
            const list = vi.spyOn(repo, 'list');
            for (const path of [f.base, `${f.base}/${f.root.id}/occurrences`]) {
                const response = await f.browser.agent
                    .get(path)
                    .query({ month })
                    .expect(400);
                expect(response.body).toMatchObject({
                    code: 'VALIDATION_ERROR',
                    details: {
                        fields: [expect.objectContaining({ field: 'month' })],
                    },
                });
                expect(JSON.stringify(response.body)).toContain('mês');
            }
            expect(find).not.toHaveBeenCalled();
            expect(list).not.toHaveBeenCalled();
        },
    );

    it('rejects malformed recurring route identifiers and civil dates before repository reads', async () => {
        const f = await recurring();
        const repo = app.get<RecurringCommitmentRepository>(
            RECURRING_COMMITMENT_REPOSITORY,
        );
        const find = vi.spyOn(repo, 'find');
        for (const [suffix, field] of [
            ['not-a-uuid', 'id'],
            ['not-a-uuid/occurrences?month=2026-11', 'id'],
            ['not-a-uuid/occurrences/2026-11-14/options', 'id'],
            [`${f.root.id}/occurrences/2026-02-30/options`, 'referenceDate'],
        ]) {
            const response = await f.browser.agent
                .get(`${f.base}/${suffix}`)
                .expect(400);
            expect(response.body).toMatchObject({
                code: 'VALIDATION_ERROR',
                details: { fields: [expect.objectContaining({ field })] },
            });
        }
        const response = await f.browser
            .post(
                `${f.base}/${f.root.id}/occurrences/2026-11-14/external-liabilities/not-a-uuid/settlements`,
                {
                    expectedOccurrenceVersion: 1,
                    amountInCents: 100,
                    factDate: today(),
                },
            )
            .expect(400);
        expect(response.body.details.fields[0].field).toBe('liabilityId');
        expect(find).not.toHaveBeenCalled();
    });
});
