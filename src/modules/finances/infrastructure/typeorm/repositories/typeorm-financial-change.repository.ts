import { Injectable } from '@nestjs/common';
import { EntityManagerProvider } from '../../../../../shared/technical/database/typeorm/entity-manager.provider.js';
import type {
    FinancialChangeOrigin,
    FinancialChangeRepository,
    IntegrityReceiptKey,
} from '../../../application/ports/private/financial-change.repository.js';
import { CommitmentChangeProposal } from '../../../domain/commitment-change/commitment-change-proposal.js';
import { FinancesError } from '../../../domain/errors/finances.error.js';
import {
    FinancialChangeProposalOrmEntity,
    FinancialIntegrityReceiptOrmEntity,
} from '../entities/financial-change.orm-entity.js';
import { recordFinancialCommandAudit } from './record-financial-command-audit.js';

@Injectable()
export class TypeOrmFinancialChangeRepository implements FinancialChangeRepository {
    constructor(private readonly managers: EntityManagerProvider) {}
    snapshot<T>(work: () => Promise<T>) {
        return this.managers.readSnapshot(work);
    }
    async origin(
        spaceId: string,
        id: string,
        lock = false,
    ): Promise<FinancialChangeOrigin | null> {
        const m = this.managers.get();
        const rows: FinancialChangeOrigin[] = await m.query(
            'SELECT id,kind,modality,version FROM financial_commitments WHERE space_id=$1 AND id=$2' +
                (lock ? ' FOR UPDATE' : ''),
            [spaceId, id],
        );
        if (!rows[0]) return null;
        const [state]: { fingerprint: string }[] = await m.query(
            "SELECT md5(COALESCE(string_agg(id::text||':'||state_version::text,',' ORDER BY id),'') || ':' || (SELECT COUNT(*) FROM financial_disbursements WHERE space_id=$1 AND commitment_id=$2)::text || ':' || (SELECT COUNT(*) FROM financial_external_liabilities WHERE space_id=$1 AND commitment_id=$2)::text || ':' || (SELECT COUNT(*) FROM financial_receipts WHERE space_id=$1 AND commitment_id=$2)::text || ':' || (SELECT COUNT(*) FROM financial_external_liability_settlements WHERE space_id=$1 AND commitment_id=$2)::text) AS fingerprint FROM financial_occurrences WHERE space_id=$1 AND commitment_id=$2",
            [spaceId, id],
        );
        return { ...rows[0], fingerprint: state.fingerprint };
    }
    private entity(proposal: CommitmentChangeProposal) {
        return {
            ...proposal.state,
            registeredAt: new Date(proposal.state.registeredAt),
            decidedAt: proposal.state.decidedAt
                ? new Date(proposal.state.decidedAt)
                : null,
        };
    }
    private hydrate(entity: FinancialChangeProposalOrmEntity) {
        return new CommitmentChangeProposal({
            ...entity,
            registeredAt: entity.registeredAt.toISOString(),
            decidedAt: entity.decidedAt?.toISOString() ?? null,
        });
    }
    async insert(proposal: CommitmentChangeProposal) {
        await this.managers
            .get()
            .insert(FinancialChangeProposalOrmEntity, this.entity(proposal));
    }
    async update(proposal: CommitmentChangeProposal, expectedVersion: number) {
        const changed = await this.managers.get().update(
            FinancialChangeProposalOrmEntity,
            {
                spaceId: proposal.state.spaceId,
                id: proposal.state.id,
                version: expectedVersion,
                status: 'PROPOSED',
            },
            this.entity(proposal),
        );
        if (changed.affected !== 1)
            throw new FinancesError('CONCURRENT_MODIFICATION');
    }
    async find(spaceId: string, commitmentId: string, id: string) {
        const q = this.managers
            .get()
            .createQueryBuilder(FinancialChangeProposalOrmEntity, 'p')
            .where(
                'p.space_id=:spaceId AND p.commitment_id=:commitmentId AND p.id=:id',
                { spaceId, commitmentId, id },
            );
        q.setLock('pessimistic_write');
        const row = await q.getOne();
        return row ? this.hydrate(row) : null;
    }
    async list(
        spaceId: string,
        recipientMemberId: string | null,
        status: string | null,
        after: string | null,
    ) {
        const q = this.managers
            .get()
            .createQueryBuilder(FinancialChangeProposalOrmEntity, 'p')
            .where('p.space_id=:spaceId', { spaceId });
        if (recipientMemberId)
            q.andWhere('p.recipient_member_id=:recipientMemberId', {
                recipientMemberId,
            });
        if (status) q.andWhere('p.status=:status', { status });
        const totalCount = await q.getCount();
        if (after) q.andWhere('p.id>:after', { after });
        const rows = await q.orderBy('p.id', 'ASC').take(21).getMany();
        return { items: rows.map((r) => this.hydrate(r)), totalCount };
    }
    async receipt(key: IntegrityReceiptKey) {
        const row = await this.managers
            .get()
            .findOneBy(FinancialIntegrityReceiptOrmEntity, {
                actorId: key.actorId,
                operation: key.operation,
                key: key.key,
            });
        if (!row) return null;
        if (row.spaceId !== key.spaceId || !row.requestHash.equals(key.hash))
            throw new FinancesError('IDEMPOTENCY_KEY_REUSED');
        return row.result;
    }
    async saveReceipt(key: IntegrityReceiptKey, result: object, now: string) {
        const manager = this.managers.get();
        if (!manager.queryRunner?.isTransactionActive)
            throw new Error('Financial integrity writes require a transaction');
        await manager.insert(FinancialIntegrityReceiptOrmEntity, {
            actorId: key.actorId,
            operation: key.operation,
            key: key.key,
            spaceId: key.spaceId,
            commitmentId: key.commitmentId,
            requestHash: key.hash,
            result,
            registeredAt: new Date(now),
        });
        await recordFinancialCommandAudit(
            manager,
            {
                actorId: { value: key.actorId },
                spaceId: { value: key.spaceId },
                idempotencyKey: key.key,
            },
            key.operation,
            key.commitmentId,
            now,
        );
    }
}
