import { Check, Column, Entity, ForeignKey, PrimaryColumn } from 'typeorm';
import type { SpaceClosureView } from '../../../application/ports/public/space-closure.port.js';

@Entity({ name: 'space_closure_command_receipts' })
@ForeignKey(
    'space_closure_processes',
    ['processId', 'spaceId'],
    ['id', 'spaceId'],
    { name: 'FK_space_closure_receipts_process', onDelete: 'RESTRICT' },
)
@Check('CHK_space_closure_receipts_hash', `octet_length("request_hash") = 32`)
@Check('CHK_space_closure_receipts_http_status', `"http_status" IN (200, 201)`)
@Check('CHK_space_closure_receipts_result', `jsonb_typeof("result") = 'object'`)
export class SpaceClosureCommandReceiptOrmEntity {
    @PrimaryColumn({
        name: 'actor_id',
        type: 'uuid',
        primaryKeyConstraintName: 'PK_space_closure_command_receipts',
    })
    @ForeignKey('persons', 'id', {
        name: 'FK_space_closure_receipts_actor',
        onDelete: 'RESTRICT',
    })
    actorId!: string;

    @PrimaryColumn({
        type: 'varchar',
        length: 48,
        primaryKeyConstraintName: 'PK_space_closure_command_receipts',
    })
    operation!: string;

    @PrimaryColumn({
        type: 'uuid',
        primaryKeyConstraintName: 'PK_space_closure_command_receipts',
    })
    key!: string;

    @Column({ name: 'space_id', type: 'uuid' })
    spaceId!: string;

    @Column({ name: 'process_id', type: 'uuid' })
    processId!: string;

    @Column({ name: 'request_hash', type: 'bytea' })
    requestHash!: Buffer;

    @Column({ name: 'http_status', type: 'integer' })
    httpStatus!: 200 | 201;

    @Column({ type: 'jsonb' })
    result!: SpaceClosureView;

    @Column({ name: 'recorded_at', type: 'timestamptz' })
    recordedAt!: Date;
}
