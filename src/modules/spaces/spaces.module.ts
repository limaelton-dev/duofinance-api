import { Module } from '@nestjs/common';
import { SPACE_PARTICIPANTS_PORT } from './application/ports/public/space-participants.port.js';
import { TypeOrmSpaceParticipants } from './infrastructure/typeorm/queries/typeorm-space-participants.js';
import { DatabaseModule } from '../../shared/technical/database/database.module.js';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PersonOrmEntity } from './infrastructure/typeorm/entities/person.orm-entity.js';
import { SpaceOrmEntity } from './infrastructure/typeorm/entities/space.orm-entity.js';
import { TypeOrmPersonRepository } from './infrastructure/typeorm/repositories/typeorm-person.repository.js';
import { TypeOrmSpaceRepository } from './infrastructure/typeorm/repositories/typeorm-space.repository.js';
import { PERSON_REPOSITORY } from './application/ports/private/person.repository.js';
import { SPACE_REPOSITORY } from './application/ports/private/space.repository.js';
import { PROVISION_PERSONAL_CONTEXT } from './application/ports/public/provision-personal-context.js';
import { ProvisionPersonalContextService } from './application/services/provision-personal-context.service.js';
import { GetPersonalContextService } from './application/services/get-personal-context.service.js';
import { GET_PERSONAL_CONTEXT } from './application/ports/public/get-personal-context.js';
import { SpaceMemberOrmEntity } from './infrastructure/typeorm/entities/space-member.orm-entity.js';
import { SpaceInvitationOrmEntity } from './infrastructure/typeorm/entities/space-invitation.orm-entity.js';
import { SpaceCommandReceiptOrmEntity } from './infrastructure/typeorm/entities/space-command-receipt.orm-entity.js';
import { NodeInvitationTokenGenerator } from './infrastructure/security/node-invitation-token-generator.js';
import { TypeOrmSpaceCommandReceipts } from './infrastructure/typeorm/repositories/typeorm-space-command-receipts.js';
import { INVITATION_TOKEN_GENERATOR } from './application/ports/private/invitation-token-generator.js';
import { SPACE_COMMAND_RECEIPTS } from './application/ports/private/space-command-receipts.js';
import { CreateSharedSpaceHandler } from './application/handlers/create-shared-space.handler.js';
import { IssueSpaceInvitationHandler } from './application/handlers/issue-space-invitation.handler.js';
import { ReplaceSpaceInvitationHandler } from './application/handlers/replace-space-invitation.handler.js';
import { SPACE_READ_QUERIES } from './application/ports/private/space-read-queries.js';
import { GetSpaceDetailsQuery } from './application/queries/get-space-details.query.js';
import { ListAccessibleSpacesQuery } from './application/queries/list-accessible-spaces.query.js';
import { SpaceInvitationCommandService } from './application/services/space-invitation-command.service.js';
import { SpacesController } from './http/controllers/spaces.controller.js';
import { InvitationsController } from './http/controllers/invitations.controller.js';
import { GetInvitationPreviewQuery } from './application/queries/get-invitation-preview.query.js';
import { RespondToSharedSpaceInvitationHandler } from './application/handlers/respond-to-shared-space-invitation.handler.js';
import { TypeOrmSpaceReadQueries } from './infrastructure/typeorm/queries/typeorm-space-read-queries.js';
import { SPACE_ACCESS_PORT } from './application/ports/public/space-access.port.js';
import { SPACE_ACCESS_QUERIES } from './application/ports/private/space-access-queries.js';
import { SpaceAccessService } from './application/services/space-access.service.js';
import { TypeOrmSpaceAccessQueries } from './infrastructure/typeorm/queries/typeorm-space-access-queries.js';
import { TypeOrmSpaceFinancialContext } from './infrastructure/typeorm/queries/typeorm-space-financial-context.js';
import { SPACE_FINANCIAL_CONTEXT_PORT } from './application/ports/public/space-financial-context.port.js';
import { FinancialEntryContextController } from './http/controllers/financial-entry-context.controller.js';
import { SPACE_CLOSURE_PORT } from './application/ports/public/space-closure.port.js';
import { TypeOrmSpaceClosure } from './infrastructure/typeorm/repositories/typeorm-space-closure.js';
import { SpaceClosureProcessOrmEntity } from './infrastructure/typeorm/entities/space-closure-process.orm-entity.js';
import { SpaceClosureHistoryOrmEntity } from './infrastructure/typeorm/entities/space-closure-history.orm-entity.js';
import { SpaceClosureCommandReceiptOrmEntity } from './infrastructure/typeorm/entities/space-closure-command-receipt.orm-entity.js';
import { SpaceClosureAuditOrmEntity } from './infrastructure/typeorm/entities/space-closure-audit.orm-entity.js';
@Module({
    imports: [
        DatabaseModule,
        TypeOrmModule.forFeature([
            PersonOrmEntity,
            SpaceOrmEntity,
            SpaceMemberOrmEntity,
            SpaceInvitationOrmEntity,
            SpaceCommandReceiptOrmEntity,
            SpaceClosureProcessOrmEntity,
            SpaceClosureHistoryOrmEntity,
            SpaceClosureCommandReceiptOrmEntity,
            SpaceClosureAuditOrmEntity,
        ]),
    ],

    controllers: [
        SpacesController,
        InvitationsController,
        FinancialEntryContextController,
    ],

    providers: [
        {
            provide: SPACE_PARTICIPANTS_PORT,
            useClass: TypeOrmSpaceParticipants,
        },
        {
            provide: SPACE_FINANCIAL_CONTEXT_PORT,
            useClass: TypeOrmSpaceFinancialContext,
        },
        TypeOrmPersonRepository,
        TypeOrmSpaceRepository,
        TypeOrmSpaceClosure,
        { provide: SPACE_CLOSURE_PORT, useExisting: TypeOrmSpaceClosure },
        ProvisionPersonalContextService,
        GetPersonalContextService,
        NodeInvitationTokenGenerator,
        TypeOrmSpaceCommandReceipts,
        TypeOrmSpaceReadQueries,
        TypeOrmSpaceAccessQueries,
        SpaceAccessService,
        SpaceInvitationCommandService,
        CreateSharedSpaceHandler,
        IssueSpaceInvitationHandler,
        ReplaceSpaceInvitationHandler,
        ListAccessibleSpacesQuery,
        GetSpaceDetailsQuery,
        GetInvitationPreviewQuery,
        RespondToSharedSpaceInvitationHandler,

        {
            provide: SPACE_ACCESS_PORT,
            useExisting: SpaceAccessService,
        },
        {
            provide: SPACE_ACCESS_QUERIES,
            useExisting: TypeOrmSpaceAccessQueries,
        },
        {
            provide: SPACE_READ_QUERIES,
            useExisting: TypeOrmSpaceReadQueries,
        },
        {
            provide: INVITATION_TOKEN_GENERATOR,
            useExisting: NodeInvitationTokenGenerator,
        },
        {
            provide: SPACE_COMMAND_RECEIPTS,
            useExisting: TypeOrmSpaceCommandReceipts,
        },
        {
            provide: PERSON_REPOSITORY,
            useExisting: TypeOrmPersonRepository,
        },
        {
            provide: SPACE_REPOSITORY,
            useExisting: TypeOrmSpaceRepository,
        },
        {
            provide: PROVISION_PERSONAL_CONTEXT,
            useExisting: ProvisionPersonalContextService,
        },
        {
            provide: GET_PERSONAL_CONTEXT,
            useExisting: GetPersonalContextService,
        },
    ],

    exports: [
        SPACE_PARTICIPANTS_PORT,
        SPACE_FINANCIAL_CONTEXT_PORT,
        SPACE_CLOSURE_PORT,
        PROVISION_PERSONAL_CONTEXT,
        GET_PERSONAL_CONTEXT,
        SPACE_ACCESS_PORT,
    ],
})
export class SpacesModule {}
