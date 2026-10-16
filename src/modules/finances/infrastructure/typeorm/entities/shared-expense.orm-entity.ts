import {
    Check,
    Column,
    Entity,
    ForeignKey,
    Index,
    PrimaryColumn,
    Unique,
    type ValueTransformer,
} from 'typeorm';
import type { SplitInput } from '../../../domain/shared-expense/responsibility-split.js';
export const safeBigInt: ValueTransformer = {
    to(value: number | null): string | null {
        if (value === null) return null;
        if (!Number.isSafeInteger(value)) throw new Error('Unsafe integer');
        return String(value);
    },
    from(value: string | null): number | null {
        if (value === null) return null;
        const result = Number(value);
        if (!Number.isSafeInteger(result)) throw new Error('Unsafe integer');
        return result;
    },
};
const money = (column: string, positive = false) =>
    `"${column}" >= ${positive ? 1 : 0} AND "${column}" <= 9007199254740991`;
@Entity('financial_commitments')
@Unique('UQ_financial_commitments_space_id', ['spaceId', 'id'])
@Check(
    'CHK_financial_commitments_scope',
    `kind IN ('EXPENSE','INCOME') AND modality = 'ONE_TIME' AND version > 0 AND length(description) BETWEEN 1 AND 160 AND description = btrim(description) AND (personal_owner_person_id IS NULL OR personal_owner_person_id = created_by)`,
)
@Index('IDX_financial_commitments_space_registered', [
    'spaceId',
    'registeredAt',
    'id',
])
export class FinancialCommitmentOrmEntity {
    @PrimaryColumn('uuid') id!: string;
    @Column({ name: 'personal_owner_person_id', type: 'uuid', nullable: true })
    @ForeignKey('persons', 'id', {
        name: 'FK_financial_commitments_personal_owner',
        onDelete: 'RESTRICT',
    })
    personalOwnerPersonId!: string | null;
    @Column({ name: 'space_id', type: 'uuid' })
    @ForeignKey('spaces', 'id', {
        name: 'FK_financial_commitments_space',
        onDelete: 'RESTRICT',
    })
    spaceId!: string;
    @Column({ type: 'varchar', length: 16 }) kind!: string;
    @Column({ type: 'varchar', length: 16 }) modality!: string;
    @Column({ type: 'varchar', length: 160 }) description!: string;
    @Column({ name: 'created_by', type: 'uuid' })
    @ForeignKey('persons', 'id', {
        name: 'FK_financial_commitments_author',
        onDelete: 'RESTRICT',
    })
    createdBy!: string;
    @Column('integer') version!: number;
    @Column({ name: 'registered_at', type: 'timestamptz' }) registeredAt!: Date;
}
@Entity('financial_commitment_versions')
@Unique('UQ_financial_versions_space', ['spaceId', 'commitmentId', 'version'])
@Check(
    'CHK_financial_versions_values',
    `${money('amount_in_cents', true)} AND version = 1 AND ((split_mode IS NOT NULL AND split_mode IN ('AMOUNTS','PERCENTAGES') AND split_input IS NOT NULL) OR (split_mode IS NULL AND split_input IS NULL AND expected_payer_member_id IS NULL AND rule_snapshot IS NULL AND rule_source_version = 0 AND suggested_target_date IS NULL)) AND rule_source_version >= 0 AND (rule_snapshot IS NULL) = (rule_source_version = 0) AND (suggested_target_date IS NULL OR rule_snapshot IS NOT NULL)`,
)
@ForeignKey(
    () => FinancialCommitmentOrmEntity,
    ['spaceId', 'commitmentId'],
    ['spaceId', 'id'],
    { name: 'FK_financial_versions_commitment', onDelete: 'RESTRICT' },
)
@ForeignKey(
    'space_members',
    ['spaceId', 'expectedPayerMemberId'],
    ['spaceId', 'id'],
    { name: 'FK_financial_versions_expected_payer', onDelete: 'RESTRICT' },
)
export class FinancialCommitmentVersionOrmEntity {
    @PrimaryColumn({ name: 'commitment_id', type: 'uuid' })
    commitmentId!: string;
    @PrimaryColumn('integer') version!: number;
    @Column({ name: 'space_id', type: 'uuid' }) spaceId!: string;
    @Column({
        name: 'amount_in_cents',
        type: 'bigint',
        transformer: safeBigInt,
    })
    amountInCents!: number;
    @Column({ name: 'expected_payer_member_id', type: 'uuid', nullable: true })
    expectedPayerMemberId!: string | null;
    @Column({ name: 'fact_date', type: 'date' }) factDate!: string;
    @Column({ name: 'split_mode', type: 'varchar', length: 16, nullable: true })
    splitMode!: string | null;
    @Column({ name: 'split_input', type: 'jsonb', nullable: true })
    splitInput!: SplitInput | null;
    @Column({ name: 'rule_snapshot', type: 'jsonb', nullable: true })
    ruleSnapshot!: { kind: 'MONTHLY_DAY'; dayOfMonth: number } | null;
    @Column({ name: 'rule_source_version', type: 'integer' })
    ruleSourceVersion!: number;
    @Column({ name: 'suggested_target_date', type: 'date', nullable: true })
    suggestedTargetDate!: string | null;
}
@Entity('financial_commitment_shares')
@Check(
    'CHK_financial_shares_values',
    `${money('amount_in_cents')} AND ((split_mode = 'AMOUNTS' AND original_amount_in_cents IS NOT NULL AND original_amount_in_cents = amount_in_cents AND basis_points IS NULL) OR (split_mode = 'PERCENTAGES' AND original_amount_in_cents IS NULL AND basis_points IS NOT NULL AND basis_points BETWEEN 0 AND 10000))`,
)
@ForeignKey(
    () => FinancialCommitmentVersionOrmEntity,
    ['spaceId', 'commitmentId', 'version'],
    ['spaceId', 'commitmentId', 'version'],
    { name: 'FK_financial_shares_version', onDelete: 'RESTRICT' },
)
@ForeignKey('space_members', ['spaceId', 'memberId'], ['spaceId', 'id'], {
    name: 'FK_financial_shares_member',
    onDelete: 'RESTRICT',
})
export class FinancialCommitmentShareOrmEntity {
    @PrimaryColumn({ name: 'commitment_id', type: 'uuid' })
    commitmentId!: string;
    @PrimaryColumn('integer') version!: number;
    @PrimaryColumn({ name: 'member_id', type: 'uuid' }) memberId!: string;
    @Column({ name: 'space_id', type: 'uuid' }) spaceId!: string;
    @Column({
        name: 'amount_in_cents',
        type: 'bigint',
        transformer: safeBigInt,
    })
    amountInCents!: number;
    @Column({ name: 'split_mode', type: 'varchar', length: 16 })
    splitMode!: string;
    @Column({
        name: 'original_amount_in_cents',
        type: 'bigint',
        nullable: true,
        transformer: safeBigInt,
    })
    originalAmountInCents!: number | null;
    @Column({ name: 'basis_points', type: 'integer', nullable: true })
    basisPoints!: number | null;
}
@Entity('financial_disbursements')
@Unique('UQ_disbursement_sequence', ['commitmentId', 'sequence'])
@Check('CHK_disbursement_sequence', 'sequence > 0')
@Unique('UQ_financial_disbursements_origin', ['spaceId', 'commitmentId', 'id'])
@Check(
    'CHK_financial_disbursements_values',
    `${money('amount_in_cents', true)} AND method IN ('PIX','DEBIT','CASH') AND version = 1 AND fact_date <= (registered_at AT TIME ZONE 'America/Sao_Paulo')::date AND ((payer_member_id IS NOT NULL AND payer_person_id IS NULL) OR (payer_member_id IS NULL AND payer_person_id IS NOT NULL))`,
)
@ForeignKey(
    () => FinancialCommitmentVersionOrmEntity,
    ['spaceId', 'commitmentId', 'version'],
    ['spaceId', 'commitmentId', 'version'],
    { name: 'FK_financial_disbursements_version', onDelete: 'RESTRICT' },
)
@ForeignKey('space_members', ['spaceId', 'payerMemberId'], ['spaceId', 'id'], {
    name: 'FK_financial_disbursements_payer',
    onDelete: 'RESTRICT',
})
export class FinancialDisbursementOrmEntity {
    @PrimaryColumn('uuid') id!: string;
    @Column({ name: 'space_id', type: 'uuid' }) spaceId!: string;
    @Column({ name: 'commitment_id', type: 'uuid' }) commitmentId!: string;
    @Column('integer') sequence!: number;
    @Column({ name: 'recorded_by_person_id', type: 'uuid' })
    @ForeignKey('persons', 'id', {
        name: 'FK_financial_disbursements_recorder',
        onDelete: 'RESTRICT',
    })
    recordedByPersonId!: string;
    @Column('integer') version!: number;
    @Column({ name: 'payer_member_id', type: 'uuid', nullable: true })
    payerMemberId!: string | null;
    @Column({ name: 'payer_person_id', type: 'uuid', nullable: true })
    @ForeignKey('persons', 'id', {
        name: 'FK_financial_disbursements_personal_payer',
        onDelete: 'RESTRICT',
    })
    payerPersonId!: string | null;
    @Column({
        name: 'amount_in_cents',
        type: 'bigint',
        transformer: safeBigInt,
    })
    amountInCents!: number;
    @Column({ type: 'varchar', length: 8 }) method!: string;
    @Column({ name: 'fact_date', type: 'date' }) factDate!: string;
    @Column({ name: 'registered_at', type: 'timestamptz' }) registeredAt!: Date;
}
@Entity('financial_external_liabilities')
@Unique('UQ_external_liabilities_origin', ['spaceId', 'commitmentId', 'id'])
@Unique('UQ_external_liabilities_sequence', ['commitmentId', 'sequence'])
@Check(
    'CHK_external_liabilities_values',
    `${money('amount_in_cents', true)} AND remaining_amount_in_cents BETWEEN 0 AND amount_in_cents AND sequence > 0 AND version = 1 AND fact_date <= (registered_at AT TIME ZONE 'America/Sao_Paulo')::date AND ((holder_member_id IS NOT NULL AND holder_person_id IS NULL) OR (holder_member_id IS NULL AND holder_person_id IS NOT NULL))`,
)
@ForeignKey(
    () => FinancialCommitmentVersionOrmEntity,
    ['spaceId', 'commitmentId', 'version'],
    ['spaceId', 'commitmentId', 'version'],
    { name: 'FK_external_liabilities_version', onDelete: 'RESTRICT' },
)
@ForeignKey('space_members', ['spaceId', 'holderMemberId'], ['spaceId', 'id'], {
    name: 'FK_external_liabilities_holder',
    onDelete: 'RESTRICT',
})
export class FinancialExternalLiabilityOrmEntity {
    @PrimaryColumn('uuid') id!: string;
    @Column({ name: 'space_id', type: 'uuid' }) spaceId!: string;
    @Column({ name: 'commitment_id', type: 'uuid' }) commitmentId!: string;
    @Column('integer') sequence!: number;
    @Column('integer') version!: number;
    @Column({ name: 'holder_member_id', type: 'uuid', nullable: true })
    holderMemberId!: string | null;
    @Column({ name: 'holder_person_id', type: 'uuid', nullable: true })
    @ForeignKey('persons', 'id', {
        name: 'FK_external_liabilities_personal_holder',
        onDelete: 'RESTRICT',
    })
    holderPersonId!: string | null;
    @Column({ name: 'recorded_by_person_id', type: 'uuid' })
    @ForeignKey('persons', 'id', {
        name: 'FK_external_liabilities_recorder',
        onDelete: 'RESTRICT',
    })
    recordedByPersonId!: string;
    @Column({
        name: 'amount_in_cents',
        type: 'bigint',
        transformer: safeBigInt,
    })
    amountInCents!: number;
    @Column({
        name: 'remaining_amount_in_cents',
        type: 'bigint',
        transformer: safeBigInt,
    })
    remainingAmountInCents!: number;
    @Column({ name: 'fact_date', type: 'date' }) factDate!: string;
    @Column({ name: 'registered_at', type: 'timestamptz' }) registeredAt!: Date;
}
@Entity('settlement_cycles')
@Unique('UQ_settlement_cycles_space_date', ['spaceId', 'targetDate'])
@Unique('UQ_settlement_cycles_space_id', ['spaceId', 'id'])
@Index('IDX_settlement_cycles_open', ['spaceId', 'status', 'targetDate', 'id'])
@Check(
    'CHK_settlement_cycles_state',
    `version > 0 AND ((status = 'OPEN' AND finalized_at IS NULL) OR (status = 'FINALIZED' AND finalized_at IS NOT NULL))`,
)
export class SettlementCycleOrmEntity {
    @PrimaryColumn('uuid') id!: string;
    @Column({ name: 'space_id', type: 'uuid' })
    @ForeignKey('spaces', 'id', {
        name: 'FK_settlement_cycles_space',
        onDelete: 'RESTRICT',
    })
    spaceId!: string;
    @Column({ name: 'target_date', type: 'date' }) targetDate!: string;
    @Column({ type: 'varchar', length: 16 }) status!: string;
    @Column('integer') version!: number;
    @Column({ name: 'finalized_at', type: 'timestamptz', nullable: true })
    finalizedAt!: Date | null;
}
@Entity('inter_member_obligations')
@Unique('UQ_obligations_space_id', ['spaceId', 'id'])
@Index('UQ_obligations_open_origin', ['spaceId', 'commitmentId'], {
    unique: true,
    where: 'remaining_amount_in_cents > 0',
})
@Index('IDX_obligations_space_origin', ['spaceId', 'commitmentId'])
@Index('IDX_obligations_space_cycle', ['spaceId', 'cycleId'])
@Check(
    'CHK_obligations_state',
    `${money('original_amount_in_cents', true)} AND ${money('recognized_amount_in_cents')} AND ${money('remaining_amount_in_cents')} AND remaining_amount_in_cents <= recognized_amount_in_cents AND debtor_member_id <> creditor_member_id AND version > 0 AND fact_date <= (registered_at AT TIME ZONE 'America/Sao_Paulo')::date AND ((status = 'OPEN' AND remaining_amount_in_cents > 0 AND remaining_amount_in_cents = recognized_amount_in_cents) OR (status = 'PARTIALLY_SETTLED' AND remaining_amount_in_cents > 0 AND remaining_amount_in_cents < recognized_amount_in_cents) OR (status IN ('SETTLED','RECONCILED','WAIVED') AND remaining_amount_in_cents = 0))`,
)
@Check(
    'CHK_obligations_origin_xor',
    `num_nonnulls(disbursement_id, receipt_id, external_liability_id) = 1`,
)
@ForeignKey(
    () => FinancialExternalLiabilityOrmEntity,
    ['spaceId', 'commitmentId', 'externalLiabilityId'],
    ['spaceId', 'commitmentId', 'id'],
    { name: 'FK_obligations_external_liability', onDelete: 'RESTRICT' },
)
@ForeignKey(
    'financial_receipts',
    ['spaceId', 'commitmentId', 'receiptId'],
    ['spaceId', 'commitmentId', 'id'],
    { name: 'FK_obligations_receipt', onDelete: 'RESTRICT' },
)
@ForeignKey(
    () => FinancialDisbursementOrmEntity,
    ['spaceId', 'commitmentId', 'disbursementId'],
    ['spaceId', 'commitmentId', 'id'],
    { name: 'FK_obligations_origin', onDelete: 'RESTRICT' },
)
@ForeignKey('space_members', ['spaceId', 'debtorMemberId'], ['spaceId', 'id'], {
    name: 'FK_obligations_debtor',
    onDelete: 'RESTRICT',
})
@ForeignKey(
    'space_members',
    ['spaceId', 'creditorMemberId'],
    ['spaceId', 'id'],
    { name: 'FK_obligations_creditor', onDelete: 'RESTRICT' },
)
@ForeignKey(
    () => SettlementCycleOrmEntity,
    ['spaceId', 'cycleId'],
    ['spaceId', 'id'],
    { name: 'FK_obligations_cycle', onDelete: 'RESTRICT' },
)
export class InterMemberObligationOrmEntity {
    @PrimaryColumn('uuid') id!: string;
    @Column({ name: 'space_id', type: 'uuid' }) spaceId!: string;
    @Column({ name: 'commitment_id', type: 'uuid' }) commitmentId!: string;
    @Column({ name: 'disbursement_id', type: 'uuid', nullable: true })
    disbursementId!: string | null;
    @Column({ name: 'receipt_id', type: 'uuid', nullable: true })
    receiptId!: string | null;
    @Column({ name: 'external_liability_id', type: 'uuid', nullable: true })
    externalLiabilityId!: string | null;
    @Column({ name: 'debtor_member_id', type: 'uuid' }) debtorMemberId!: string;
    @Column({ name: 'creditor_member_id', type: 'uuid' })
    creditorMemberId!: string;
    @Column({
        name: 'original_amount_in_cents',
        type: 'bigint',
        transformer: safeBigInt,
    })
    originalAmountInCents!: number;
    @Column({
        name: 'recognized_amount_in_cents',
        type: 'bigint',
        transformer: safeBigInt,
    })
    recognizedAmountInCents!: number;
    @Column({
        name: 'remaining_amount_in_cents',
        type: 'bigint',
        transformer: safeBigInt,
    })
    remainingAmountInCents!: number;
    @Column({ type: 'varchar', length: 24 }) status!: string;
    @Column({ name: 'cycle_id', type: 'uuid', nullable: true }) cycleId!:
        string | null;
    @Column('integer') version!: number;
    @Column({ name: 'fact_date', type: 'date' }) factDate!: string;
    @Column({ name: 'registered_at', type: 'timestamptz' }) registeredAt!: Date;
}
@Entity('inter_member_obligation_changes')
@Check(
    'CHK_obligation_changes_type',
    `(version = 1 AND type = 'CREATED' AND allocation_id IS NULL) OR (version > 1 AND type = 'SETTLEMENT_APPLIED' AND allocation_id IS NOT NULL) OR (version > 1 AND type IN ('RECONCILED','ASSIGNMENT_CHANGED','OFFSET_APPLIED','WAIVED') AND allocation_id IS NULL)`,
)
@ForeignKey(
    () => InterMemberObligationOrmEntity,
    ['spaceId', 'obligationId'],
    ['spaceId', 'id'],
    { name: 'FK_obligation_changes_obligation', onDelete: 'RESTRICT' },
)
export class InterMemberObligationChangeOrmEntity {
    @PrimaryColumn({ name: 'obligation_id', type: 'uuid' })
    obligationId!: string;
    @PrimaryColumn('integer') version!: number;
    @Column({ name: 'space_id', type: 'uuid' }) spaceId!: string;
    @Column({ name: 'actor_id', type: 'uuid' })
    @ForeignKey('persons', 'id', {
        name: 'FK_obligation_changes_actor',
        onDelete: 'RESTRICT',
    })
    actorId!: string;
    @Column({ type: 'varchar', length: 24 }) type!: string;
    @Column({ name: 'allocation_id', type: 'uuid', nullable: true })
    allocationId!: string | null;
    @Column({ type: 'jsonb' }) snapshot!: unknown;
    @Column({ name: 'registered_at', type: 'timestamptz' }) registeredAt!: Date;
}
@Entity('financial_expense_command_receipts')
@Check(
    'CHK_expense_receipt',
    `operation IN ('RECORD_SHARED_CASH_EXPENSE','RECORD_PERSONAL_EXPENSE','RECORD_EXPENSE_DISBURSEMENT','RECORD_CREDIT_CARD_PURCHASE','RECORD_EXTERNAL_LIABILITY','SETTLE_EXTERNAL_LIABILITY') AND status = 'COMPLETED' AND octet_length(request_hash) = 32`,
)
export class FinancialExpenseCommandReceiptOrmEntity {
    @PrimaryColumn({ name: 'actor_id', type: 'uuid' })
    @ForeignKey('persons', 'id', {
        name: 'FK_expense_receipts_actor',
        onDelete: 'RESTRICT',
    })
    actorId!: string;
    @PrimaryColumn({ type: 'varchar', length: 40 }) operation!: string;
    @PrimaryColumn({ name: 'idempotency_key', type: 'uuid' })
    idempotencyKey!: string;
    @Column({ name: 'request_hash', type: 'bytea' }) requestHash!: Buffer;
    @Column({ type: 'varchar', length: 16 }) status!: string;
    @Column({ name: 'commitment_id', type: 'uuid' })
    @ForeignKey(() => FinancialCommitmentOrmEntity, 'id', {
        name: 'FK_expense_receipts_commitment',
        onDelete: 'RESTRICT',
    })
    commitmentId!: string;
    @Column({ type: 'jsonb' }) result!: unknown;
    @Column({ name: 'created_at', type: 'timestamptz' }) createdAt!: Date;
}
export const sharedExpenseEntities = [
    FinancialCommitmentOrmEntity,
    FinancialCommitmentVersionOrmEntity,
    FinancialCommitmentShareOrmEntity,
    FinancialDisbursementOrmEntity,
    FinancialExternalLiabilityOrmEntity,
    SettlementCycleOrmEntity,
    InterMemberObligationOrmEntity,
    InterMemberObligationChangeOrmEntity,
    FinancialExpenseCommandReceiptOrmEntity,
];
