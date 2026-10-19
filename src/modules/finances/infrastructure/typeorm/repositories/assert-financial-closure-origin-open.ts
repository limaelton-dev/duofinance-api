import type { EntityManager } from 'typeorm';
import { FinancesError } from '../../../domain/errors/finances.error.js';

export async function assertFinancialClosureOriginOpen(
    manager: EntityManager,
    spaceId: string,
    originId: string,
    targetId?: string,
    referenceDate?: string | null,
) {
    const effects: { id: string }[] = await manager.query(
        `SELECT e.id FROM financial_closure_effects e WHERE e.space_id=$1 AND e.origin_id=$2
            AND ($3::uuid IS NULL OR EXISTS (SELECT 1 FROM jsonb_array_elements(e.snapshot->'originSnapshot'->'futureItems') item
                WHERE item->>'originItemId'=$3::text) OR (e.snapshot->>'originType'='RECURRING' AND $4::date>=e.cutoff_date)) LIMIT 1`,
        [spaceId, originId, targetId ?? null, referenceDate ?? null],
    );
    if (effects.length)
        throw new FinancesError('FINANCIAL_CLOSURE_DESTINATION_APPLIED');
}
