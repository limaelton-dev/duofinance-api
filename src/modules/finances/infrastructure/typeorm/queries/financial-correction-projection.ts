import type { EntityManager } from 'typeorm';
import type {
    FinancialAdjustment,
    FinancialCancellation,
} from '../../../domain/corrections/financial-correction.js';
import type { EconomicShare } from '../../../domain/shared-expense/responsibility-split.js';
import {
    FinancialCommitmentAdjustmentOrmEntity,
    FinancialCommitmentCancellationOrmEntity,
} from '../entities/financial-correction.orm-entity.js';

export async function financialCorrections(
    manager: EntityManager,
    spaceId: string,
    commitmentId: string,
    targetId: string,
) {
    const rows = await manager.find(FinancialCommitmentAdjustmentOrmEntity, {
        where: { spaceId, commitmentId, targetId },
        order: { commitmentVersion: 'ASC' },
    });
    const cancellation = await manager.findOneBy(
        FinancialCommitmentCancellationOrmEntity,
        { spaceId, commitmentId },
    );
    return {
        adjustments: rows.map((row) => ({
            ...row,
            registeredAt: row.registeredAt.toISOString(),
        })) as FinancialAdjustment[],
        cancellation: cancellation
            ? ({
                  ...cancellation,
                  registeredAt: cancellation.registeredAt.toISOString(),
              } as FinancialCancellation)
            : null,
    };
}

export function applyFinancialAdjustments(
    amount: number,
    shares: readonly EconomicShare[] | null,
    adjustments: readonly FinancialAdjustment[],
    baseVersion = 1,
) {
    const applicable = adjustments.filter(
        (adjustment) => adjustment.commitmentVersion > baseVersion,
    );
    const effectiveAmountInCents = applicable.reduce(
        (sum, adjustment) =>
            sum +
            (adjustment.direction === 'INCREASE'
                ? adjustment.amountInCents
                : -adjustment.amountInCents),
        amount,
    );
    const economicShares =
        shares?.map((share) => ({
            memberId: share.memberId,
            amountInCents: applicable.reduce(
                (sum, adjustment) =>
                    sum +
                    (adjustment.shareChanges?.find(
                        (change) => change.memberId === share.memberId,
                    )?.amountInCents ?? 0),
                share.amountInCents,
            ),
        })) ?? null;
    return { amountInCents: effectiveAmountInCents, economicShares };
}
