import { Check, Entity, Column, ForeignKey, PrimaryColumn } from 'typeorm';
@Entity('finances_command_receipts')
@Check(
    'finances_command_receipts_operation_check',
    "operation = 'CONFIGURE_DEFAULT_SETTLEMENT_RULE'",
)
@Check(
    'finances_command_receipts_request_hash_check',
    'octet_length(request_hash) = 32',
)
@Check('finances_command_receipts_status_check', "status = 'COMPLETED'")
@Check('finances_command_receipts_result_version_check', 'result_version > 0')
@ForeignKey('persons', ['actorId'], ['id'], {
    name: 'finances_command_receipts_actor_id_fkey',
    onDelete: 'RESTRICT',
})
@ForeignKey(
    'default_settlement_rule_changes',
    ['resultSpaceId', 'resultVersion'],
    ['spaceId', 'version'],
    {
        name: 'finances_command_receipts_result_space_id_result_version_fkey',
        onDelete: 'RESTRICT',
    },
)
export class FinancesCommandReceiptOrmEntity {
    @PrimaryColumn('uuid', {
        name: 'actor_id',
        primaryKeyConstraintName: 'PK_finances_command_receipts',
    })
    actorId!: string;
    @PrimaryColumn('varchar', {
        primaryKeyConstraintName: 'PK_finances_command_receipts',
    })
    operation!: string;
    @PrimaryColumn('uuid', {
        primaryKeyConstraintName: 'PK_finances_command_receipts',
    })
    key!: string;
    @Column('bytea', { name: 'request_hash' }) requestHash!: Buffer;
    @Column('varchar') status!: string;
    @Column('uuid', { name: 'result_space_id' }) resultSpaceId!: string;
    @Column('integer', { name: 'result_version' }) resultVersion!: number;
    @Column('boolean') changed!: boolean;
    @Column('timestamptz', { name: 'created_at' }) createdAt!: Date;
}
