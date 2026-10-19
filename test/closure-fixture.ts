import type { INestApplication } from '@nestjs/common';
import type { Server } from 'node:http';
import type { DataSource } from 'typeorm';
import { financeBrowser } from './settlement-fixture.js';

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
