import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { QueryFailedError } from 'typeorm';
import { EntityManagerProvider } from '../../../../../shared/technical/database/typeorm/entity-manager.provider.js';
import type {
    RecordSettlementTransferCommand,
    SettlementTransferResult,
} from '../../../application/models/settlement-transfer.js';
import {
    SettlementTransferReceiptRaceError,
    type SettlementTransferReceipts,
} from '../../../application/ports/private/settlement-transfer.repository.js';
import { FinancesError } from '../../../domain/errors/finances.error.js';

export function settlementTransferHash(
    c: RecordSettlementTransferCommand,
): Buffer {
    return createHash('sha256')
        .update(
            JSON.stringify([
                'RECORD_MANUAL_SETTLEMENT_TRANSFER',
                c.spaceId.value.toLowerCase(),
                c.expectedSpaceVersion,
                c.payerMemberId.toLowerCase(),
                c.recipientMemberId.toLowerCase(),
                c.amountInCents,
                c.factDate,
                c.allocations
                    .map((a) => [
                        a.obligationId.toLowerCase(),
                        a.expectedObligationVersion,
                        a.amountInCents,
                    ])
                    .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
            ]),
        )
        .digest();
}
@Injectable()
export class TypeOrmSettlementTransferReceipts implements SettlementTransferReceipts {
    constructor(private readonly provider: EntityManagerProvider) {}
    async find(
        c: RecordSettlementTransferCommand,
    ): Promise<SettlementTransferResult | null> {
        const rows: {
            request_hash: Buffer;
            result: SettlementTransferResult;
        }[] = await this.provider
            .get()
            .query(
                `SELECT request_hash,result FROM financial_settlement_command_receipts WHERE actor_id=$1 AND operation='RECORD_MANUAL_SETTLEMENT_TRANSFER' AND idempotency_key=$2`,
                [c.actorId.value, c.idempotencyKey],
            );
        if (!rows.length) return null;
        if (!rows[0].request_hash.equals(settlementTransferHash(c)))
            throw new FinancesError('IDEMPOTENCY_KEY_REUSED');
        return rows[0].result;
    }
    async save(
        c: RecordSettlementTransferCommand,
        result: SettlementTransferResult,
    ): Promise<void> {
        const m = this.provider.get();
        if (!m.queryRunner?.isTransactionActive)
            throw new Error('Settlement receipt requires a transaction');
        try {
            await m.query(
                `INSERT INTO financial_settlement_command_receipts(actor_id,operation,idempotency_key,request_hash,status,space_id,transfer_id,result,created_at) VALUES ($1,'RECORD_MANUAL_SETTLEMENT_TRANSFER',$2,$3,'COMPLETED',$4,$5,$6,$7)`,
                [
                    c.actorId.value,
                    c.idempotencyKey,
                    settlementTransferHash(c),
                    c.spaceId.value,
                    result.transfer.id,
                    JSON.stringify(result),
                    result.transfer.registeredAt,
                ],
            );
        } catch (error) {
            if (
                error instanceof QueryFailedError &&
                error.driverError.code === '23505' &&
                error.driverError.constraint ===
                    'financial_settlement_command_receipts_pkey'
            )
                throw new SettlementTransferReceiptRaceError();
            throw error;
        }
    }
}
