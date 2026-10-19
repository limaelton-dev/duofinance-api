import type { SpaceFinancialContext } from '../../../spaces/application/ports/public/space-financial-context.port.js';
import { FinancesError } from '../../domain/errors/finances.error.js';

export function assertRecurringClosureCutoff(
    context: SpaceFinancialContext | null,
    referenceDate: string,
    recordedFactCount: number,
) {
    if (
        context?.closureCutoffDate &&
        referenceDate >= context.closureCutoffDate &&
        recordedFactCount === 0
    )
        throw new FinancesError('CLOSURE_CUTOFF_REACHED');
}
