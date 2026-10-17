import { createHash } from 'node:crypto';
import type { PersonId } from '../../../spaces/domain/person/person-id.js';
import type { SpaceId } from '../../../spaces/domain/space/space-id.js';
import type {
    InstallmentCommitmentDto,
    InstallmentDisbursementDto,
    InstallmentLiabilityDto,
    InstallmentSettlementDto,
    InstallmentAnticipationDto,
    InstallmentPayoffDto,
    InstallmentCancellationDto,
} from '../../http/dto/installment-commitment.dto.js';

export type Base = {
    actorId: PersonId;
    spaceId: SpaceId;
    idempotencyKey: string;
};

export type Create = Base & InstallmentCommitmentDto;

export type Fulfillment = Base & {
    commitmentId: string;
    installmentId: string;
} & (
        | ({ kind: 'DISBURSEMENT' } & InstallmentDisbursementDto)
        | ({ kind: 'EXTERNAL_LIABILITY' } & InstallmentLiabilityDto)
        | ({
              kind: 'SETTLE_EXTERNAL_LIABILITY';
              liabilityId: string;
          } & InstallmentSettlementDto)
    );

export type Anticipation = Base & {
    commitmentId: string;
} & InstallmentAnticipationDto;

export type Payoff = Base & { commitmentId: string } & InstallmentPayoffDto;

export type Cancellation = Base & {
    commitmentId: string;
} & InstallmentCancellationDto;

export function digest(
    operation: string,
    spaceId: string,
    payload: unknown,
): Buffer {
    const canonical = (value: unknown): unknown =>
        Array.isArray(value)
            ? value.map(canonical)
            : value && typeof value === 'object'
              ? Object.fromEntries(
                    Object.entries(value)
                        .sort(([a], [b]) => a.localeCompare(b))
                        .map(([key, item]) => [key, canonical(item)]),
                )
              : value;
    return createHash('sha256')
        .update(JSON.stringify([operation, spaceId, canonical(payload)]))
        .digest();
}
