import { Injectable } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { TransactionContext } from './transaction-context.js';

@Injectable()
export class EntityManagerProvider {
    constructor(
        private readonly dataSource: DataSource,
        private readonly transactionContext: TransactionContext,
    ) {}

    /** Keep composite financial reads on one MVCC snapshot without write locks.
     * Existing command transactions retain their isolation and locking rules.
     */
    readSnapshot<T>(work: () => Promise<T>): Promise<T> {
        if (this.get().queryRunner?.isTransactionActive) return work();
        return this.dataSource.transaction(
            'REPEATABLE READ',
            async (manager) => {
                await manager.query('SET TRANSACTION READ ONLY');
                return this.transactionContext.run(manager, work);
            },
        );
    }

    get(): EntityManager {
        return (
            this.transactionContext.getEntityManager() ??
            this.dataSource.manager
        );
    }
}
