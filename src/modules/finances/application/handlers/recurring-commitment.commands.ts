import type { PersonId } from '../../../spaces/domain/person/person-id.js';
import type { SpaceId } from '../../../spaces/domain/space/space-id.js';
import type {
    CreateRecurringCommitmentDto,
    RecurringDisbursementDto,
    RecurringExternalLiabilityDto,
    RecurringExternalSettlementDto,
    RecurringReceiptDto,
    SetRecurringValueDto,
} from '../../http/dto/recurring-commitment.dto.js';
export type Base = {
    actorId: PersonId;
    spaceId: SpaceId;
    idempotencyKey: string;
};
export type Create = Base & CreateRecurringCommitmentDto;
export type SetValue = Base &
    SetRecurringValueDto & { commitmentId: string; referenceDate: string };
export type Fulfillment = Base & {
    commitmentId: string;
    referenceDate: string;
} & (
        | ({ kind: 'DISBURSEMENT' } & RecurringDisbursementDto)
        | ({ kind: 'RECEIPT' } & RecurringReceiptDto)
        | ({ kind: 'EXTERNAL_LIABILITY' } & RecurringExternalLiabilityDto)
        | ({
              kind: 'SETTLE_EXTERNAL_LIABILITY';
              liabilityId: string;
          } & RecurringExternalSettlementDto)
    );
