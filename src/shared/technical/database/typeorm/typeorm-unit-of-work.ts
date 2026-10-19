import { Injectable } from '@nestjs/common';
import { UnitOfWork } from '../../../application/unit-of-work.js';
import { DataSource } from 'typeorm';
import { TransactionContext } from './transaction-context.js';

@Injectable()
export class TypeOrmUnitOfWork implements UnitOfWork {
    constructor(
        private readonly dataSource: DataSource,
        private readonly transactionContext: TransactionContext,
    ) {}

    execute<T>(work: () => Promise<T>): Promise<T> {
        if (
            this.transactionContext.getEntityManager()?.queryRunner
                ?.isTransactionActive
        )
            return work();
        return this.dataSource.transaction((entityManager) =>
            this.transactionContext.run(entityManager, work),
        );
    }
}
