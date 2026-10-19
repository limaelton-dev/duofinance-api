import {
    Check,
    Column,
    Entity,
    ForeignKey,
    PrimaryColumn,
    Unique,
} from 'typeorm';
import type {
    FinancialClosureApplication,
    FinancialClosureDestination,
} from '../../../application/ports/public/financial-closure-destinations.port.js';

@Entity('financial_closure_effects')
@Unique('UQ_financial_closure_effect_origin', ['spaceId', 'originId'])
@Unique('UQ_financial_closure_effect_scope', ['spaceId', 'originId', 'id'])
@Check('CHK_financial_closure_effect_revision', 'plan_revision>0')
@ForeignKey(
    'financial_commitments',
    ['spaceId', 'originId'],
    ['spaceId', 'id'],
    {
        name: 'FK_financial_closure_effect_origin',
        onDelete: 'RESTRICT',
    },
)
export class FinancialClosureEffectOrmEntity {
    @PrimaryColumn('uuid') id!: string;
    @Column({ name: 'space_id', type: 'uuid' }) spaceId!: string;
    @Column({ name: 'origin_id', type: 'uuid' }) originId!: string;
    @Column({ name: 'process_id', type: 'uuid' }) processId!: string;
    @Column({ name: 'plan_revision', type: 'integer' }) planRevision!: number;
    @Column({ name: 'actor_id', type: 'uuid' })
    @ForeignKey('persons', 'id', {
        name: 'FK_financial_closure_effect_actor',
        onDelete: 'RESTRICT',
    })
    actorId!: string;
    @Column({ name: 'cutoff_date', type: 'date' }) cutoffDate!: string;
    @Column({ type: 'jsonb' }) snapshot!: FinancialClosureDestination;
    @Column({ name: 'successor_commitment_id', type: 'uuid', nullable: true })
    @ForeignKey('financial_commitments', 'id', {
        name: 'FK_financial_closure_effect_successor',
        onDelete: 'RESTRICT',
    })
    successorCommitmentId!: string | null;
    @Column({ type: 'jsonb' }) result!: FinancialClosureApplication;
    @Column({ name: 'registered_at', type: 'timestamptz' }) registeredAt!: Date;
}
