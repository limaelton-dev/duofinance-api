import {
    Check,
    Column,
    Entity,
    ForeignKey,
    Index,
    PrimaryColumn,
    Unique,
} from 'typeorm';

@Entity({ name: 'space_invitations' })
@Unique('UQ_space_invitations_id_space', ['id', 'spaceId'])
@ForeignKey(
    'space_closure_processes',
    ['closureProcessId', 'spaceId'],
    ['id', 'spaceId'],
    {
        name: 'FK_space_invitations_closure_process',
        onDelete: 'RESTRICT',
    },
)
@ForeignKey(
    'space_invitations',
    ['replacedByInvitationId', 'spaceId'],
    ['id', 'spaceId'],
    {
        name: 'FK_space_invitations_replacement',
        onDelete: 'NO ACTION',
        deferrable: 'INITIALLY DEFERRED',
    },
)
@Check(
    'CHK_space_invitations_status',
    `"status" IN ('PENDING', 'ACCEPTED', 'REJECTED', 'CANCELLED', 'EXPIRED')`,
)
@Check('CHK_space_invitations_hash', `octet_length("token_hash") = 32`)
@Check(
    'CHK_space_invitations_dates',
    `"expires_at" > "issued_at"
    AND ("resolved_at" IS NULL OR "resolved_at" >= "issued_at")`,
)
@Check(
    'CHK_space_invitations_resolution',
    `("status" = 'PENDING' AND "resolved_at" IS NULL)
    OR ("status" <> 'PENDING' AND "resolved_at" IS NOT NULL)`,
)
@Check(
    'CHK_space_invitations_replacement',
    `(
        "status" = 'CANCELLED'
        AND "cancellation_reason" IS NOT NULL
        AND "cancellation_reason" = 'REPLACED'
        AND "replaced_by_invitation_id" IS NOT NULL
        AND "replaced_by_invitation_id" <> "id"
        AND "closure_process_id" IS NULL
    ) OR (
        "status" = 'CANCELLED'
        AND "cancellation_reason" IS NOT NULL
        AND "cancellation_reason" = 'SPACE_CLOSURE'
        AND "replaced_by_invitation_id" IS NULL
        AND "closure_process_id" IS NOT NULL
    ) OR (
        "status" <> 'CANCELLED'
        AND "cancellation_reason" IS NULL
        AND "replaced_by_invitation_id" IS NULL
        AND "closure_process_id" IS NULL
    )`,
)
@Index('UQ_space_invitations_pending', ['spaceId'], {
    unique: true,
    where: `"status" = 'PENDING'`,
})
@Index('UQ_space_invitations_token_hash', ['tokenHash'], { unique: true })
@Index('IDX_space_invitations_history', ['spaceId', 'issuedAt', 'id'])
export class SpaceInvitationOrmEntity {
    @PrimaryColumn({ type: 'uuid' })
    id!: string;

    @Column({ name: 'space_id', type: 'uuid' })
    @ForeignKey('spaces', 'id', {
        name: 'FK_space_invitations_space',
        onDelete: 'RESTRICT',
    })
    spaceId!: string;

    @Column({ name: 'invited_by_person_id', type: 'uuid' })
    @ForeignKey('persons', 'id', {
        name: 'FK_space_invitations_issuer',
        onDelete: 'RESTRICT',
    })
    invitedByPersonId!: string;

    @Column({ name: 'token_hash', type: 'bytea', select: false })
    tokenHash!: Buffer;

    @Column({ type: 'varchar', length: 16 })
    status!: string;

    @Column({ name: 'issued_at', type: 'timestamptz' })
    issuedAt!: Date;

    @Column({ name: 'expires_at', type: 'timestamptz' })
    expiresAt!: Date;

    @Column({ name: 'resolved_at', type: 'timestamptz', nullable: true })
    resolvedAt!: Date | null;

    @Column({
        name: 'cancellation_reason',
        type: 'varchar',
        length: 16,
        nullable: true,
    })
    cancellationReason!: 'REPLACED' | 'SPACE_CLOSURE' | null;

    @Column({
        name: 'replaced_by_invitation_id',
        type: 'uuid',
        nullable: true,
    })
    replacedByInvitationId!: string | null;

    @Column({ name: 'closure_process_id', type: 'uuid', nullable: true })
    closureProcessId!: string | null;
}
