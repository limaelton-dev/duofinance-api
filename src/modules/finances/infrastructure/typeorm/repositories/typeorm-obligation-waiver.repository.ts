import { Injectable } from '@nestjs/common';
import { EntityManagerProvider } from '../../../../../shared/technical/database/typeorm/entity-manager.provider.js';
import type { ObligationWaiverRepository } from '../../../application/ports/private/obligation-waiver.repository.js';
import type {
    ObligationWaiverOptions,
    ObligationWaiverResult,
} from '../../../application/models/obligation-waiver.js';
import type { PositionKey } from '../../../application/models/inter-member-position.js';
import type { ObligationWaiver } from '../../../domain/shared-expense/obligation-waiver.js';
import type { InterMemberObligation } from '../../../domain/shared-expense/inter-member-obligation.js';
import { FinancesError } from '../../../domain/errors/finances.error.js';
import { ClosureResolutionAudit } from './closure-resolution-audit.js';
import { ObligationWaiverOrmEntity } from '../entities/obligation-waiver.orm-entity.js';
import {
    InterMemberObligationChangeOrmEntity,
    InterMemberObligationOrmEntity,
} from '../entities/shared-expense.orm-entity.js';
@Injectable()
export class TypeOrmObligationWaiverRepository implements ObligationWaiverRepository {
    constructor(
        private readonly provider: EntityManagerProvider,
        private readonly closureAudit: ClosureResolutionAudit,
    ) {}
    private transaction() {
        const m = this.provider.get();
        if (!m.queryRunner?.isTransactionActive)
            throw new Error('Obligation waiver requires a transaction');
        return m;
    }
    async save(
        waiver: ObligationWaiver,
        before: InterMemberObligation,
        after: InterMemberObligation,
    ) {
        const m = this.transaction();
        await m.insert(ObligationWaiverOrmEntity, {
            ...waiver,
            spaceId: before.spaceId,
            registeredAt: new Date(waiver.registeredAt),
        });
        const update = await m.update(
            InterMemberObligationOrmEntity,
            { spaceId: before.spaceId, id: before.id, version: before.version },
            {
                remainingAmountInCents: after.remainingAmountInCents,
                status: after.status,
                version: after.version,
            },
        );
        if (update.affected !== 1)
            throw new FinancesError('CONCURRENT_MODIFICATION');
        const closureAudit = await this.closureAudit.context(
            waiver.createdByPersonId,
            before.spaceId,
        );
        await m.insert(InterMemberObligationChangeOrmEntity, {
            spaceId: before.spaceId,
            obligationId: before.id,
            version: after.version,
            actorId: waiver.createdByPersonId,
            type: 'WAIVED',
            allocationId: null,
            snapshot: {
                waiverId: waiver.id,
                cycleId: before.cycleId,
                appliedAmountInCents: waiver.amountInCents,
                beforeAmountInCents: before.remainingAmountInCents,
                remainingAmountInCents: after.remainingAmountInCents,
                status: after.status,
                reason: waiver.reason,
                ...closureAudit,
            },
            registeredAt: new Date(waiver.registeredAt),
        });
    }
    async options(
        spaceId: string,
        obligationId: string,
    ): Promise<ObligationWaiverOptions | null> {
        const rows: ObligationWaiverOptions[] = await this.provider
            .get()
            .query(
                `SELECT (jsonb_build_object('id',o.id,'version',o.version,'status',o.status,'debtorMemberId',o.debtor_member_id,'creditorMemberId',o.creditor_member_id,'cycleId',o.cycle_id,'remainingAmountInCents',o.remaining_amount_in_cents)||CASE WHEN o.closure_agreement_id IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('closureAgreementId',o.closure_agreement_id) END) AS obligation,CASE WHEN c.id IS NULL THEN NULL ELSE jsonb_build_object('id',c.id,'version',c.version,'status',c.status,'targetDate',to_char(c.target_date,'YYYY-MM-DD')) END AS "settlementCycle" FROM inter_member_obligations o LEFT JOIN settlement_cycles c ON c.space_id=o.space_id AND c.id=o.cycle_id WHERE o.space_id=$1 AND o.id=$2`,
                [spaceId, obligationId],
            );
        return rows[0] ?? null;
    }
    private async details(
        spaceId: string,
        obligationId: string,
        after: PositionKey | null,
    ) {
        const rows: { result: ObligationWaiverResult }[] = await this.provider
            .get()
            .query(
                `WITH page AS MATERIALIZED (SELECT * FROM obligation_waivers WHERE space_id=$1 AND obligation_id=$2 AND ($3::timestamptz IS NULL OR (registered_at,id)<($3::timestamptz,$4::uuid)) ORDER BY registered_at DESC,id DESC LIMIT 21)
            SELECT jsonb_build_object('spaceId',w.space_id,'waiver',jsonb_build_object('id',w.id,'obligationId',w.obligation_id,'creditorMemberId',w.creditor_member_id,'amountInCents',w.amount_in_cents,'factDate',to_char(w.fact_date,'YYYY-MM-DD'),'registeredAt',to_char(w.registered_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'createdByPersonId',w.created_by,'reason',w.reason),
            'obligation',jsonb_build_object('id',o.id,'version',o.version,'status',o.status,'cycleId',o.cycle_id,'remainingAmountInCents',o.remaining_amount_in_cents)||CASE WHEN o.closure_agreement_id IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('closureAgreementId',o.closure_agreement_id) END,'affectedCycleIds',CASE WHEN ch.snapshot->>'cycleId' IS NULL THEN '[]'::jsonb ELSE jsonb_build_array(ch.snapshot->>'cycleId') END,'replayed',false) AS result
            FROM page w JOIN inter_member_obligations o ON o.space_id=w.space_id AND o.id=w.obligation_id JOIN inter_member_obligation_changes ch ON ch.space_id=w.space_id AND ch.obligation_id=w.obligation_id AND ch.type='WAIVED' AND ch.snapshot->>'waiverId'=w.id::text ORDER BY w.registered_at DESC,w.id DESC`,
                [
                    spaceId,
                    obligationId,
                    after?.registeredAt ?? null,
                    after?.id ?? null,
                ],
            );
        return rows.map((r) => r.result);
    }
    history(spaceId: string, obligationId: string, after: PositionKey | null) {
        return this.provider.readSnapshot(() =>
            this.details(spaceId, obligationId, after),
        );
    }
}
