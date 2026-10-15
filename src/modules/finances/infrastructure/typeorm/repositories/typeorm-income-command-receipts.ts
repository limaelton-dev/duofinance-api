import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { QueryFailedError } from 'typeorm';
import { EntityManagerProvider } from '../../../../../shared/technical/database/typeorm/entity-manager.provider.js';
import type { IncomeResult } from '../../../application/models/income.js';
import {
    IncomeReceiptRaceError,
    type IncomeCommand,
    type IncomeCommandReceipts,
} from '../../../application/ports/private/income.ports.js';
import { FinancesError } from '../../../domain/errors/finances.error.js';
import { FinancialIncomeCommandReceiptOrmEntity } from '../entities/income.orm-entity.js';

function operation(c: IncomeCommand): string {
    return 'commitmentId' in c ? 'RECORD_INCOME_RECEIPT' : 'RECORD_INCOME';
}

function hash(c: IncomeCommand): Buffer {
    const input =
        'commitmentId' in c
            ? [
                  c.commitmentId.toLowerCase(),
                  c.expectedCommitmentVersion,
                  c.factDate,
                  c.expectedSpaceVersion ?? null,
                  c.recipientMemberId?.toLowerCase() ?? null,
                  c.settlement ?? null,
              ]
            : [
                  c.description.trim(),
                  c.amountInCents,
                  c.expectedReceiptDate,
                  'expectedSpaceVersion' in c ? c.expectedSpaceVersion : null,
                  'participationSplit' in c
                      ? {
                            ...c.participationSplit,
                            shares: [...c.participationSplit.shares].sort(
                                (a, b) => a.memberId.localeCompare(b.memberId),
                            ),
                        }
                      : null,
                  'expectedRecipientMemberId' in c
                      ? (c.expectedRecipientMemberId?.toLowerCase() ?? null)
                      : null,
                  c.receipt,
              ];
    return createHash('sha256')
        .update(
            JSON.stringify([
                operation(c),
                c.spaceId.value.toLowerCase(),
                input,
            ]),
        )
        .digest();
}

@Injectable()
export class TypeOrmIncomeCommandReceipts implements IncomeCommandReceipts {
    constructor(private readonly provider: EntityManagerProvider) {}

    async find(c: IncomeCommand): Promise<IncomeResult | null> {
        const row = await this.provider
            .get()
            .findOneBy(FinancialIncomeCommandReceiptOrmEntity, {
                actorId: c.actorId.value,
                operation: operation(c),
                idempotencyKey: c.idempotencyKey,
            });
        if (!row) return null;
        if (!row.requestHash.equals(hash(c)))
            throw new FinancesError('IDEMPOTENCY_KEY_REUSED');
        return row.result as IncomeResult;
    }

    async save(
        c: IncomeCommand,
        result: IncomeResult,
        registeredAt: string,
    ): Promise<void> {
        try {
            await this.provider
                .get()
                .insert(FinancialIncomeCommandReceiptOrmEntity, {
                    actorId: c.actorId.value,
                    operation: operation(c),
                    idempotencyKey: c.idempotencyKey,
                    requestHash: hash(c),
                    status: 'COMPLETED',
                    commitmentId: result.commitment.id,
                    result,
                    createdAt: new Date(registeredAt),
                });
        } catch (error) {
            if (
                error instanceof QueryFailedError &&
                error.driverError.code === '23505'
            )
                throw new IncomeReceiptRaceError();
            throw error;
        }
    }
}
