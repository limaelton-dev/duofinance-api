import { describe, expect, it, vi } from 'vitest';
import { PersonId } from '../../../spaces/domain/person/person-id.js';
import { SpaceId } from '../../../spaces/domain/space/space-id.js';
import { SpacesDomainError } from '../../../spaces/domain/errors/spaces-domain.error.js';
import {
    GetInterMemberPositionQuery,
    encodePositionCursor,
    decodePositionCursor,
    positionSummary,
} from './inter-member-position.query.js';
const actor = PersonId.create(),
    space = SpaceId.create(),
    id = SpaceId.create().value;
const timestamp = '2026-10-10T15:00:00.123456Z';
describe('inter-member position exact summary', () => {
    it.each([
        ['35000', '8000', 'PAYABLE', '27000'],
        ['8000', '35000', 'RECEIVABLE', '27000'],
        ['8000', '8000', 'BALANCED', '0'],
        ['0', '0', 'BALANCED', '0'],
        ['18014398509481982', '1', 'PAYABLE', '18014398509481981'],
    ])('preserves totals %s/%s', (payable, receivable, direction, amount) => {
        expect(positionSummary(payable, receivable)).toEqual({
            payableAmountInCents: payable,
            receivableAmountInCents: receivable,
            net: { direction, amountInCents: amount },
        });
    });
});
describe('versioned inter-member cursor', () => {
    const cursor = encodePositionCursor(space.value, actor.value, 'ALL', {
        registeredAt: timestamp,
        id,
    });
    it('preserves microseconds and context', () => {
        expect(
            decodePositionCursor(cursor, space.value, actor.value, 'ALL'),
        ).toEqual({ registeredAt: timestamp, id });
        expect(
            decodePositionCursor(undefined, space.value, actor.value, 'ALL'),
        ).toBeNull();
    });
    it.each([
        '',
        'x',
        'a'.repeat(513),
        cursor + '=',
        Buffer.from(
            JSON.stringify([2, space.value, actor.value, 'ALL', timestamp, id]),
        ).toString('base64url'),
        Buffer.from(
            JSON.stringify([
                1,
                space.value,
                actor.value,
                'ALL',
                '2026-02-30T15:00:00.123456Z',
                id,
            ]),
        ).toString('base64url'),
        Buffer.from(
            JSON.stringify([
                1,
                space.value,
                actor.value,
                'ALL',
                '2026-10-10T15:00:60.123456Z',
                id,
            ]),
        ).toString('base64url'),
        Buffer.from(
            JSON.stringify([
                1,
                space.value,
                actor.value,
                'ALL',
                '2026-10-10T15:00:00.123Z',
                id,
            ]),
        ).toString('base64url'),
        Buffer.from(
            JSON.stringify(
                [1, space.value, actor.value, 'ALL', timestamp, id],
                null,
                1,
            ),
        ).toString('base64url'),
    ])('rejects malformed cursor %s', (value) => {
        expect(() =>
            decodePositionCursor(value, space.value, actor.value, 'ALL'),
        ).toThrow(
            expect.objectContaining({
                code: 'VALIDATION_ERROR',
                fields: ['cursor'],
            }),
        );
    });
    it.each(['actor', 'space', 'direction'])(
        'rejects another %s context',
        (context) => {
            expect(() =>
                decodePositionCursor(
                    cursor,
                    context === 'space' ? id : space.value,
                    context === 'actor' ? id : actor.value,
                    context === 'direction' ? 'PAYABLE' : 'ALL',
                ),
            ).toThrow();
        },
    );
});
describe('GetInterMemberPositionQuery authorization', () => {
    function fixture() {
        const context = {
            spaceId: space.value,
            type: 'SHARED' as const,
            status: 'ACTIVE' as const,
            version: 1,
            actorMemberId: id,
            members: [],
        };
        const access = {
            read: vi.fn().mockResolvedValue(context),
            lockForWrite: vi.fn(),
            lockForSettlement: vi.fn(),
            lockForFulfillment: vi.fn(),
        };
        const reader = {
            read: vi.fn().mockResolvedValue({
                payableAmountInCents: '0',
                receivableAmountInCents: '0',
                items: [],
            }),
        };
        return {
            access,
            reader,
            query: new GetInterMemberPositionQuery(access, reader),
        };
    }
    it('authorizes before financial read and again before response', async () => {
        const f = fixture();
        expect(await f.query.execute(actor, space)).toMatchObject({
            spaceId: space.value,
            spaceStatus: 'ACTIVE',
            actorMemberId: id,
            scope: 'OPEN_OBLIGATIONS',
            page: { direction: 'ALL', pageSize: 20, nextCursor: null },
        });
        expect(f.access.read).toHaveBeenCalledTimes(2);
        expect(f.reader.read).toHaveBeenCalledWith(
            space.value,
            id,
            'ALL',
            null,
        );
        expect(f.access.lockForWrite).not.toHaveBeenCalled();
    });
    it('blocks inaccessible context before reader', async () => {
        const f = fixture();
        f.access.read.mockRejectedValue(
            new SpacesDomainError('SPACE_NOT_FOUND'),
        );
        await expect(f.query.execute(actor, space)).rejects.toMatchObject({
            code: 'SPACE_NOT_FOUND',
        });
        expect(f.reader.read).not.toHaveBeenCalled();
    });
    it('discards results after loss of access', async () => {
        const f = fixture();
        f.access.read
            .mockReset()
            .mockResolvedValueOnce({ spaceId: space.value, actorMemberId: id })
            .mockRejectedValueOnce(new SpacesDomainError('SPACE_NOT_FOUND'));
        await expect(f.query.execute(actor, space)).rejects.toMatchObject({
            code: 'SPACE_NOT_FOUND',
        });
        expect(f.reader.read).toHaveBeenCalledTimes(1);
    });
    it.each(['CLOSING', 'CLOSED'])('permits readable %s', async (status) => {
        const f = fixture();
        f.access.read.mockResolvedValue({
            spaceId: space.value,
            actorMemberId: id,
            status,
            members: [],
        });
        expect(await f.query.execute(actor, space)).toMatchObject({
            spaceStatus: status,
        });
    });
    it('never reads financial rows with invalid cursor', async () => {
        const f = fixture();
        await expect(
            f.query.execute(actor, space, 'ALL', ''),
        ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
        expect(f.reader.read).not.toHaveBeenCalled();
    });
});
