import {
    Check,
    Column,
    Entity,
    ForeignKey,
    Index,
    PrimaryColumn,
    Unique,
} from 'typeorm';
import { FinancialCommitmentOrmEntity } from './shared-expense.orm-entity.js';

@Entity('financial_commitment_change_proposals')
@Unique('UQ_commitment_change_proposal_origin', [
    'spaceId',
    'commitmentId',
    'id',
])
@Index('IDX_commitment_change_proposals_recipient', [
    'spaceId',
    'recipientMemberId',
    'status',
    'id',
])
@Check(
    'CHK_commitment_change_proposal_state',
    "version > 0 AND base_version > 0 AND proposed_by_member_id <> recipient_member_id AND status IN ('PROPOSED','ACCEPTED','REJECTED','CANCELLED') AND (status='PROPOSED')=(decided_at IS NULL) AND (decided_at IS NULL)=(decided_by_person_id IS NULL)",
)
@ForeignKey(
    () => FinancialCommitmentOrmEntity,
    ['spaceId', 'commitmentId'],
    ['spaceId', 'id'],
    { name: 'FK_commitment_change_proposal_origin', onDelete: 'RESTRICT' },
)
@ForeignKey(
    'space_members',
    ['spaceId', 'proposedByMemberId'],
    ['spaceId', 'id'],
    { name: 'FK_commitment_change_proposal_author', onDelete: 'RESTRICT' },
)
@ForeignKey(
    'space_members',
    ['spaceId', 'recipientMemberId'],
    ['spaceId', 'id'],
    { name: 'FK_commitment_change_proposal_recipient', onDelete: 'RESTRICT' },
)
@ForeignKey('persons', ['actorId'], ['id'], {
    name: 'FK_commitment_change_proposal_actor',
    onDelete: 'RESTRICT',
})
@ForeignKey('persons', ['decidedByPersonId'], ['id'], {
    name: 'FK_commitment_change_proposal_decider',
    onDelete: 'RESTRICT',
})
export class FinancialChangeProposalOrmEntity {
    @PrimaryColumn('uuid') id!: string;
    @Column({ name: 'space_id', type: 'uuid' }) spaceId!: string;
    @Column({ name: 'commitment_id', type: 'uuid' }) commitmentId!: string;
    @Column('integer') version!: number;
    @Column({ name: 'base_version', type: 'integer' }) baseVersion!: number;
    @Column({ name: 'origin_fingerprint', type: 'varchar', length: 32 })
    originFingerprint!: string;
    @Column({ name: 'proposed_by_member_id', type: 'uuid' })
    proposedByMemberId!: string;
    @Column({ name: 'recipient_member_id', type: 'uuid' })
    recipientMemberId!: string;
    @Column({ name: 'actor_id', type: 'uuid' }) actorId!: string;
    @Column({ name: 'effective_from', type: 'date' }) effectiveFrom!: string;
    @Column('jsonb') configuration!: object;
    @Column('jsonb') impact!: object;
    @Column({ type: 'varchar', length: 16 }) status!:
        'PROPOSED' | 'ACCEPTED' | 'REJECTED' | 'CANCELLED';
    @Column({ name: 'registered_at', type: 'timestamptz' }) registeredAt!: Date;
    @Column({ name: 'decided_at', type: 'timestamptz', nullable: true })
    decidedAt!: Date | null;
    @Column({ name: 'decided_by_person_id', type: 'uuid', nullable: true })
    decidedByPersonId!: string | null;
}

@Entity('financial_integrity_command_receipts')
@Check('CHK_integrity_command_receipt_hash', 'octet_length(request_hash)=32')
@ForeignKey(
    () => FinancialCommitmentOrmEntity,
    ['spaceId', 'commitmentId'],
    ['spaceId', 'id'],
    { name: 'FK_integrity_receipt_origin', onDelete: 'RESTRICT' },
)
@ForeignKey('persons', ['actorId'], ['id'], {
    name: 'FK_integrity_receipt_actor',
    onDelete: 'RESTRICT',
})
export class FinancialIntegrityReceiptOrmEntity {
    @PrimaryColumn({ name: 'actor_id', type: 'uuid' }) actorId!: string;
    @PrimaryColumn({ type: 'varchar', length: 40 }) operation!: string;
    @PrimaryColumn({ name: 'idempotency_key', type: 'uuid' }) key!: string;
    @Column({ name: 'space_id', type: 'uuid' }) spaceId!: string;
    @Column({ name: 'commitment_id', type: 'uuid' }) commitmentId!: string;
    @Column({ name: 'request_hash', type: 'bytea' }) requestHash!: Buffer;
    @Column('jsonb') result!: object;
    @Column({ name: 'registered_at', type: 'timestamptz' }) registeredAt!: Date;
}

export const financialChangeEntities = [
    FinancialChangeProposalOrmEntity,
    FinancialIntegrityReceiptOrmEntity,
];
