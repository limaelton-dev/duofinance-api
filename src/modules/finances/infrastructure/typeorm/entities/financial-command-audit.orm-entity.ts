import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

/** Operational evidence, separate from domain history and replay responses. */
@Entity('financial_command_audit')
@Index('IDX_financial_command_audit_origin', [
    'spaceId',
    'commitmentId',
    'registeredAt',
])
export class FinancialCommandAuditOrmEntity {
    @PrimaryColumn({ name: 'actor_id', type: 'uuid' }) actorId!: string;
    @PrimaryColumn({ type: 'varchar', length: 40 }) action!: string;
    @PrimaryColumn({ name: 'idempotency_key', type: 'uuid' })
    idempotencyKey!: string;
    @Column({ name: 'space_id', type: 'uuid' }) spaceId!: string;
    @Column({ name: 'commitment_id', type: 'uuid' }) commitmentId!: string;
    @Column({ name: 'registered_at', type: 'timestamptz' }) registeredAt!: Date;
}
