import { describe, expect, it } from 'vitest';
import { FinancesError } from '../errors/finances.error.js';
import {
    createInstallmentSchedule,
    Installment,
    InstallmentPlan,
} from './installment-plan.js';
import { InstallmentCommitment } from './installment-commitment.js';

describe('finite installment plan', () => {
    it('anchors periodic dates, splits the fixed total with final residue, and keeps exact member totals', () => {
        const schedule = createInstallmentSchedule({
            count: 3,
            firstDueDate: '2026-01-31',
            cadence: 'MONTHLY',
            totalAmountInCents: 100000,
        });
        expect(schedule).toEqual([
            { position: 1, dueDate: '2026-01-31', amountInCents: 33333 },
            { position: 2, dueDate: '2026-02-28', amountInCents: 33333 },
            { position: 3, dueDate: '2026-03-31', amountInCents: 33334 },
        ]);
        const root = new InstallmentCommitment(
            'root',
            'space',
            'Compra',
            'author',
            '2026-01-10T15:00:00Z',
            1,
            new InstallmentPlan(
                'plan',
                'root',
                'space',
                schedule.map(
                    (item) =>
                        new Installment(
                            `item-${item.position}`,
                            item.position,
                            item.dueDate,
                            item.amountInCents,
                        ),
                ),
            ),
            {
                type: 'SHARED',
                distribution: {
                    mode: 'AMOUNTS',
                    shares: [
                        { memberId: 'a', amountInCents: 40000 },
                        { memberId: 'b', amountInCents: 60000 },
                    ],
                },
                expectedMemberId: 'a',
                settlementRuleSnapshot: null,
                settlementRuleSourceVersion: 0,
            },
            'MONTHLY',
            'CARD',
        );
        for (let position = 1; position <= 3; position++)
            expect(
                root
                    .sharesFor(position)!
                    .reduce((sum, share) => sum + share.amountInCents, 0),
            ).toBe(schedule[position - 1]!.amountInCents);
        for (const member of ['a', 'b'])
            expect(
                [1, 2, 3].reduce(
                    (sum, position) =>
                        sum +
                        root
                            .sharesFor(position)!
                            .find((share) => share.memberId === member)!
                            .amountInCents,
                    0,
                ),
            ).toBe(member === 'a' ? 40000 : 60000);
    });

    it('allows explicit unequal values and rejects invalid count, dates, mixed modes and impossible totals', () => {
        expect(
            createInstallmentSchedule({
                count: 2,
                explicitDueDates: ['2026-10-20', '2027-02-02'],
                amountsInCents: [1200, 800],
            }),
        ).toEqual([
            { position: 1, dueDate: '2026-10-20', amountInCents: 1200 },
            { position: 2, dueDate: '2027-02-02', amountInCents: 800 },
        ]);
        for (const input of [
            {
                count: 0,
                firstDueDate: '2026-10-20',
                cadence: 'MONTHLY' as const,
                totalAmountInCents: 100,
            },
            {
                count: 2,
                explicitDueDates: ['2026-02-30', '2026-03-30'],
                totalAmountInCents: 100,
            },
            {
                count: 2,
                explicitDueDates: ['2026-10-20', '2026-10-20'],
                totalAmountInCents: 100,
            },
            {
                count: 2,
                firstDueDate: '2026-10-20',
                cadence: 'MONTHLY' as const,
                explicitDueDates: ['2026-10-20', '2026-11-20'],
                totalAmountInCents: 100,
            },
            {
                count: 3,
                firstDueDate: '2026-10-20',
                cadence: 'MONTHLY' as const,
                totalAmountInCents: 2,
            },
            {
                count: 2,
                firstDueDate: '2026-10-20',
                cadence: 'MONTHLY' as const,
                totalAmountInCents: 100,
                baseAmountInCents: 50,
            },
        ])
            expect(() => createInstallmentSchedule(input)).toThrow(
                FinancesError,
            );
    });

    it('preserves leap-year annual anchor and independent child state', () => {
        const schedule = createInstallmentSchedule({
            count: 3,
            firstDueDate: '2024-02-29',
            cadence: 'ANNUAL',
            baseAmountInCents: 100,
        });
        expect(schedule.map((item) => item.dueDate)).toEqual([
            '2024-02-29',
            '2025-02-28',
            '2026-02-28',
        ]);
        const plan = new InstallmentPlan('plan', 'root', 'space', [
            new Installment('first', 1, '2026-10-20', 100, 'FULFILLED', 100, 2),
            new Installment('second', 2, '2026-11-20', 100),
        ]);
        expect(plan).toMatchObject({ status: 'OPEN', totalAmountInCents: 200 });
        expect(plan.installments[1]).toMatchObject({
            status: 'PENDING',
            remainingAmountInCents: 100,
        });
    });

    it('selects the farthest open installments and allocates manual adjustments without increasing the other member', () => {
        const root = new InstallmentCommitment(
            'root',
            'space',
            'Compra',
            'author',
            '2026-10-01T12:00:00Z',
            1,
            new InstallmentPlan('plan', 'root', 'space', [
                new Installment('first', 1, '2026-11-20', 10000),
                new Installment('second', 2, '2026-12-20', 10000),
            ]),
            {
                type: 'SHARED',
                distribution: {
                    mode: 'AMOUNTS',
                    shares: [
                        { memberId: 'a', amountInCents: 10000 },
                        { memberId: 'b', amountInCents: 10000 },
                    ],
                },
                expectedMemberId: 'a',
                settlementRuleSnapshot: null,
                settlementRuleSourceVersion: 0,
            },
            'MONTHLY',
            null,
        );
        const selected = root.selectForAnticipation(
            { mode: 'FROM_END', quantity: 2 },
            [
                {
                    installmentId: 'second',
                    expectedInstallmentVersion: 1,
                    paidAmountInCents: 8000,
                },
                {
                    installmentId: 'first',
                    expectedInstallmentVersion: 1,
                    paidAmountInCents: 12000,
                },
            ],
            '2026-10-14',
            '2026-10-14',
            'a',
        );
        expect(selected.map((item) => item.installmentId)).toEqual([
            'second',
            'first',
        ]);
        expect(selected.map((item) => item.adjustmentInCents)).toEqual([
            -2000, 2000,
        ]);
        expect(selected[0]!.effectiveEconomicShares).toEqual([
            { memberId: 'a', amountInCents: 4000 },
            { memberId: 'b', amountInCents: 4000 },
        ]);
        expect(selected[1]!.effectiveEconomicShares).toEqual([
            { memberId: 'a', amountInCents: 7000 },
            { memberId: 'b', amountInCents: 5000 },
        ]);
        expect(() =>
            root.selectForAnticipation(
                { mode: 'FROM_END', quantity: 2 },
                [
                    {
                        installmentId: 'first',
                        expectedInstallmentVersion: 1,
                        paidAmountInCents: 10000,
                    },
                    {
                        installmentId: 'second',
                        expectedInstallmentVersion: 1,
                        paidAmountInCents: 10000,
                    },
                ],
                '2026-10-14',
                '2026-10-14',
                'a',
            ),
        ).toThrow(FinancesError);
    });

    it('closes only the remaining amount of a partially fulfilled installment and keeps its due date', () => {
        const root = new InstallmentCommitment(
            'root',
            'space',
            'Compra',
            'author',
            '2026-10-01T12:00:00Z',
            2,
            new InstallmentPlan('plan', 'root', 'space', [
                new Installment(
                    'first',
                    1,
                    '2026-11-20',
                    10000,
                    'PARTIALLY_FULFILLED',
                    2000,
                    2,
                ),
            ]),
            { type: 'PERSONAL', ownerPersonId: 'author' },
            'MONTHLY',
            null,
        );
        const [item] = root.selectForAnticipation(
            { mode: 'IDS', installmentIds: ['first'] },
            [
                {
                    installmentId: 'first',
                    expectedInstallmentVersion: 2,
                    paidAmountInCents: 7000,
                },
            ],
            '2026-10-14',
            '2026-10-14',
            null,
        );
        expect(item).toMatchObject({
            dueDate: '2026-11-20',
            plannedAmountInCents: 10000,
            previouslyFulfilledAmountInCents: 2000,
            expectedRemainingAmountInCents: 8000,
            effectiveAmountInCents: 9000,
            adjustmentInCents: -1000,
        });
        expect(() =>
            root.selectForAnticipation(
                { mode: 'IDS', installmentIds: ['first'] },
                null,
                '2026-11-20',
                '2026-10-14',
                null,
            ),
        ).toThrow(FinancesError);
    });
});
