import type {
    NonRecurringChangeTarget,
    NonRecurringEconomicVersion,
} from '../../../domain/changes/non-recurring-version.js';

export const NON_RECURRING_CHANGE_REPOSITORY = Symbol(
    'NON_RECURRING_CHANGE_REPOSITORY',
);

export interface NonRecurringChangeState {
    id: string;
    spaceId: string;
    kind: 'EXPENSE' | 'INCOME';
    modality: 'ONE_TIME' | 'INSTALLMENT';
    version: number;
    description: string;
    ownerPersonId: string | null;
    targets: NonRecurringChangeTarget[];
    versions: NonRecurringEconomicVersion[];
}

export interface NonRecurringChangeRepository {
    read(
        spaceId: string,
        commitmentId: string,
        effectiveFrom: string,
        lock: boolean,
    ): Promise<NonRecurringChangeState | null>;
    snapshot<T>(work: () => Promise<T>): Promise<T>;
    save(
        state: NonRecurringChangeState,
        versions: readonly NonRecurringEconomicVersion[],
    ): Promise<void>;
}
