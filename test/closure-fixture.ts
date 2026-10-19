import type { INestApplication } from '@nestjs/common';
import type { Server } from 'node:http';
import type { DataSource } from 'typeorm';
import { expect, vi } from 'vitest';
import { financeBrowser, sharedFinance } from './settlement-fixture.js';

export const closurePath = (spaceId: string) => `/v2/spaces/${spaceId}/closure`;

export async function formingSharedSpace(app: INestApplication<Server>) {
    const a = await financeBrowser(app, 'Criador');
    const created = (await a.post('/v2/spaces', { name: 'Casa' }).expect(201))
        .body;
    const space = created.space.id as string;
    const context = (
        await a.agent
            .get(`/v2/spaces/${space}/financial-entry-context`)
            .expect(200)
    ).body;
    return {
        a,
        space,
        created,
        context,
        memberId: created.actorMembership.id as string,
        token: new URLSearchParams(
            new URL(created.inviteUrl).hash.slice(1),
        ).get('token')!,
        path: closurePath(space),
    };
}

export async function closureSnapshot(db: DataSource) {
    const tables: { tablename: string }[] = await db.query(
        "SELECT tablename FROM pg_tables WHERE schemaname='public' AND (tablename='spaces' OR tablename LIKE 'space_%' OR tablename LIKE '%closure%') ORDER BY tablename",
    );
    return Object.fromEntries(
        await Promise.all(
            tables.map(async ({ tablename }) => [
                tablename,
                await db.query(
                    `SELECT * FROM ${tablename} ORDER BY to_jsonb(${tablename})::text`,
                ),
            ]),
        ),
    );
}

export async function closureFinance(
    app: INestApplication<Server>,
    mode: 'solo' | 'bilateral' = 'bilateral',
) {
    if (mode === 'solo') {
        const f = await formingSharedSpace(app);
        return {
            a: f.a,
            b: null,
            space: f.space,
            context: f.context,
            ma: f.memberId,
            mb: null,
            path: f.path,
        };
    }
    const f = await sharedFinance(app);
    return { ...f, path: closurePath(f.space) };
}

type ClosureFinance = Awaited<ReturnType<typeof closureFinance>>;

export async function futureClosureRecurrence(
    f: ClosureFinance,
    startsOn: string,
    variable = false,
) {
    const ids = [f.ma, ...(f.mb ? [f.mb] : [])];
    return (
        await f.a
            .post(`/v2/spaces/${f.space}/recurring-commitments`, {
                scope: 'SHARED',
                kind: 'EXPENSE',
                description: 'Compromisso futuro da casa',
                ...(variable
                    ? { valueMode: 'VARIABLE', expectedAmountInCents: 3000 }
                    : { amountInCents: 3000 }),
                recurrence: { frequency: 'MONTHLY', dayOfMonth: 20 },
                startsOn,
                expectedSpaceVersion: f.context.version,
                expectedMemberId: f.ma,
                distribution: {
                    mode: 'PERCENTAGES',
                    shares: ids.map((memberId) => ({
                        memberId,
                        basisPoints: 10000 / ids.length,
                    })),
                },
            })
            .expect(201)
    ).body.commitment;
}

export async function futureClosureInstallments(
    f: ClosureFinance,
    firstDueDate: string,
) {
    const ids = [f.ma, ...(f.mb ? [f.mb] : [])];
    return (
        await f.a
            .post(`/v2/spaces/${f.space}/installment-commitments`, {
                scope: 'SHARED',
                description: 'Parcelas futuras da casa',
                count: 2,
                firstDueDate,
                cadence: 'MONTHLY',
                totalAmountInCents: 2000,
                expectedSpaceVersion: f.context.version,
                expectedRuleVersion: 0,
                expectedMemberId: f.ma,
                distribution: {
                    mode: 'PERCENTAGES',
                    shares: ids.map((memberId) => ({
                        memberId,
                        basisPoints: 10000 / ids.length,
                    })),
                },
            })
            .expect(201)
    ).body.commitment;
}

export async function competingClosureCommands<T>(
    db: DataSource,
    spaceId: string,
    firstCommand: () => PromiseLike<T>,
    secondCommand: () => PromiseLike<T>,
) {
    const gate = db.createQueryRunner(),
        pending: Promise<T>[] = [];
    await gate.connect();
    await gate.startTransaction();
    try {
        const [{ pid }] = await gate.query('SELECT pg_backend_pid() AS pid');
        await gate.query('SELECT id FROM spaces WHERE id=$1 FOR UPDATE', [
            spaceId,
        ]);
        const awaitContenders = (count: number) =>
            vi.waitFor(
                async () => {
                    const rows = await db.query(
                        `WITH RECURSIVE blocked(pid) AS (
                SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid))
                UNION SELECT waiting.pid FROM pg_stat_activity waiting JOIN blocked prior ON prior.pid=ANY(pg_blocking_pids(waiting.pid))
                WHERE waiting.datname=current_database()
            ) SELECT pid FROM blocked`,
                        [pid],
                    );
                    expect(rows).toHaveLength(count);
                },
                { timeout: 10000, interval: 20 },
            );
        const first = Promise.resolve(firstCommand());
        pending.push(first);
        await awaitContenders(1);
        const second = Promise.resolve(secondCommand());
        pending.push(second);
        await awaitContenders(2);
        await gate.commitTransaction();
        return await Promise.all([first, second]);
    } finally {
        if (gate.isTransactionActive) await gate.rollbackTransaction();
        await gate.release();
        await Promise.allSettled(pending);
    }
}
