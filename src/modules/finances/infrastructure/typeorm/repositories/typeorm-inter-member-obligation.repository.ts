import { Injectable } from '@nestjs/common';
import { EntityManagerProvider } from '../../../../../shared/technical/database/typeorm/entity-manager.provider.js';
import type { InterMemberObligationRepository } from '../../../application/ports/private/shared-expense.repositories.js';
import { InterMemberObligation } from '../../../domain/shared-expense/shared-expense.js';
import {
    obligationChangeRow,
    obligationRow,
} from '../../mappers/shared-expense.mapper.js';
import {
    InterMemberObligationChangeOrmEntity,
    InterMemberObligationOrmEntity,
} from '../entities/shared-expense.orm-entity.js';
function transaction(provider: EntityManagerProvider) {
    const manager = provider.get();
    if (!manager.queryRunner?.isTransactionActive)
        throw new Error('Expense writes require a transaction');
    return manager;
}
@Injectable()
export class TypeOrmInterMemberObligationRepository implements InterMemberObligationRepository {
    constructor(private readonly provider: EntityManagerProvider) {}
    async save(o: InterMemberObligation): Promise<void> {
        const m = transaction(this.provider);
        await m.insert(InterMemberObligationOrmEntity, obligationRow(o));
        await m.insert(
            InterMemberObligationChangeOrmEntity,
            obligationChangeRow(o),
        );
    }
}
