import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { DataSource } from 'typeorm';

export const financeBase = (space: string) => `/v2/spaces/${space}`;
export const commitmentPath = (space: string, id: string) =>
    `${financeBase(space)}/financial-commitments/${id}`;
export const obligationPath = (space: string, id: string) =>
    `${financeBase(space)}/inter-member-obligations/${id}`;

export async function financeBrowser(
    app: INestApplication<Server>,
    name = 'Titular',
) {
    const agent = request.agent(app.getHttpServer());
    const csrf = (await agent.get('/v2/auth/csrf').expect(200)).body.csrfToken;
    const context = (
        await agent
            .post('/v2/auth/register')
            .set('Origin', 'http://localhost:3000')
            .set('X-CSRF-Token', csrf)
            .send({
                displayName: name,
                email: randomUUID() + '@example.com',
                password: 'uma-senha-de-teste',
            })
            .expect(201)
    ).body;
    const headers = {
        Origin: 'http://localhost:3000',
        'X-CSRF-Token': (await agent.get('/v2/auth/csrf').expect(200)).body
            .csrfToken,
    };
    return {
        agent,
        context,
        post: (path: string, body: object, key: string = randomUUID()) =>
            agent
                .post(path)
                .set(headers)
                .set('Idempotency-Key', key)
                .send(body),
        put: (path: string, body: object, key: string = randomUUID()) =>
            agent.put(path).set(headers).set('Idempotency-Key', key).send(body),
    };
}

export async function sharedFinance(app: INestApplication<Server>) {
    const a = await financeBrowser(app, 'Pessoa A');
    const b = await financeBrowser(app, 'Pessoa B');
    const created = (await a.post('/v2/spaces', { name: 'Casa' }).expect(201))
        .body;
    const space = created.space.id as string;
    const token = new URLSearchParams(
        new URL(created.inviteUrl).hash.slice(1),
    ).get('token');
    await b
        .post('/v2/invitations/respond', {
            token,
            decision: 'ACCEPT',
            expectedVersion: created.space.version,
        })
        .expect(200);
    const context = (
        await a.agent
            .get(`${financeBase(space)}/financial-entry-context`)
            .expect(200)
    ).body;
    const ma = context.members.find(
        (m: { personId: string }) => m.personId === a.context.person.id,
    ).memberId as string;
    const mb = context.members.find(
        (m: { personId: string }) => m.personId === b.context.person.id,
    ).memberId as string;
    return { a, b, space, context, ma, mb };
}

export type SharedFinance = Awaited<ReturnType<typeof sharedFinance>>;

export function sharedExpenseInput(
    f: SharedFinance,
    amount = 50000,
    paid = amount,
    settlement: object = { mode: 'NONE' },
) {
    return {
        description: 'Despesa compartilhada',
        amountInCents: amount,
        factDate: '2026-10-14',
        expectedSpaceVersion: f.context.version,
        expectedPayerMemberId: f.ma,
        responsibilitySplit: {
            mode: 'AMOUNTS',
            shares: [
                { memberId: f.ma, amountInCents: Math.floor(amount * 0.6) },
                {
                    memberId: f.mb,
                    amountInCents: amount - Math.floor(amount * 0.6),
                },
            ],
        },
        disbursement: {
            method: 'PIX',
            payerMemberId: f.ma,
            amountInCents: paid,
        },
        settlement,
    };
}

export async function financeSnapshot(db: DataSource) {
    const tables = (await db.query(
        "SELECT tablename FROM pg_tables WHERE schemaname='public' AND (tablename LIKE 'financial_%' OR tablename LIKE 'inter_member_%' OR tablename LIKE 'settlement_%' OR tablename LIKE 'default_settlement_%') ORDER BY tablename",
    )) as { tablename: string }[];
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
