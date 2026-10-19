import { SpacesDomainError } from '../errors/spaces-domain.error.js';
import { InvitationId } from '../invitation/invitation-id.js';
import { Invitation, InvitationStatus } from '../invitation/invitation.js';
import { MemberId } from '../member/member-id.js';
import { Member, MemberStatus } from '../member/member.js';
import { PersonId } from '../person/person-id.js';
import { SpaceId } from './space-id.js';
import {
    ClosurePlan,
    type ClosureParticipant,
    type ClosureFutureDestination,
    type ClosurePlanAction,
    type ClosureProposalSnapshot,
    type ClosureConfirmation,
} from './closure-plan.js';

export enum SpaceType {
    PERSONAL = 'PERSONAL',
    SHARED = 'SHARED',
}

export enum SpaceStatus {
    ACTIVE = 'ACTIVE',
    CLOSING = 'CLOSING',
    CLOSED = 'CLOSED',
}

type BaseSpaceProps = {
    id: SpaceId;
    version: number;
    createdAt: Date;
    updatedAt: Date;
};

export type PersonalSpaceProps = BaseSpaceProps & {
    type: SpaceType.PERSONAL;
    status: SpaceStatus.ACTIVE;
    personalOwnerPersonId: PersonId;
};

export type SharedSpaceProps = BaseSpaceProps & {
    type: SpaceType.SHARED;
    status: SpaceStatus;
    personalOwnerPersonId: null;
    name: string;
    createdByPersonId: PersonId;
    members: readonly Member[];
    invitations: readonly Invitation[];
};

export type SpaceProps = PersonalSpaceProps | SharedSpaceProps;

type CreateSharedSpaceInput = {
    id: SpaceId;
    name: string;
    createdByPersonId: PersonId;
    creatorMemberId: MemberId;
    invitationId: InvitationId;
    now: Date;
};

function normalizeName(name: string): string {
    if (typeof name !== 'string') {
        throw new SpacesDomainError('VALIDATION_ERROR');
    }

    const normalized = name.trim();
    const containsControl = Array.from(normalized).some((character) => {
        const code = character.charCodeAt(0);

        return code <= 31 || (code >= 127 && code <= 159);
    });

    if (normalized.length < 1 || normalized.length > 80 || containsControl) {
        throw new SpacesDomainError('VALIDATION_ERROR');
    }

    return normalized;
}

export class Space {
    private props: SpaceProps;

    private constructor(props: SpaceProps) {
        this.props =
            props.type === SpaceType.SHARED
                ? {
                      ...props,
                      members: [...props.members],
                      invitations: [...props.invitations],
                      createdAt: new Date(props.createdAt),
                      updatedAt: new Date(props.updatedAt),
                  }
                : {
                      ...props,
                      createdAt: new Date(props.createdAt),
                      updatedAt: new Date(props.updatedAt),
                  };

        this.assertInvariants();
    }

    static createPersonal(
        id: SpaceId,
        ownerPersonId: PersonId,
        now = new Date(),
    ): Space {
        if (!ownerPersonId) {
            throw new Error('Personal space requires an owner');
        }

        return new Space({
            id,
            type: SpaceType.PERSONAL,
            status: SpaceStatus.ACTIVE,
            personalOwnerPersonId: ownerPersonId,
            version: 1,
            createdAt: now,
            updatedAt: now,
        });
    }

    static createShared(input: CreateSharedSpaceInput): Space {
        return new Space({
            id: input.id,
            type: SpaceType.SHARED,
            status: SpaceStatus.ACTIVE,
            personalOwnerPersonId: null,
            name: normalizeName(input.name),
            createdByPersonId: input.createdByPersonId,
            members: [
                Member.create(
                    input.creatorMemberId,
                    input.createdByPersonId,
                    input.now,
                ),
            ],
            invitations: [
                Invitation.issue(
                    input.invitationId,
                    input.createdByPersonId,
                    input.now,
                ),
            ],
            version: 1,
            createdAt: input.now,
            updatedAt: input.now,
        });
    }

    static restore(props: SpaceProps): Space {
        return new Space(props);
    }

    startClosure(input: {
        actorPersonId: PersonId;
        processId: string;
        participants: ClosureParticipant[];
        cutoffDate: string;
        now: Date;
    }): ClosurePlan {
        const props = this.requireClosureMember(input.actorPersonId);
        if (props.status !== SpaceStatus.ACTIVE) {
            throw new SpacesDomainError('SPACE_NOT_ACTIVE');
        }
        const actor = input.participants.find(
            (member) => member.personId === input.actorPersonId.value,
        );
        if (
            !actor ||
            props.members.some(
                (member) =>
                    !input.participants.some(
                        (participant) =>
                            participant.memberId === member.id.value &&
                            participant.personId === member.personId.value,
                    ),
            )
        ) {
            throw new Error('Incomplete historical closure participants');
        }
        if (
            input.participants.length === 1 &&
            !props.createdByPersonId.equals(input.actorPersonId)
        ) {
            throw new SpacesDomainError('SPACE_NOT_FOUND');
        }
        const plan = ClosurePlan.start({
            processId: input.processId,
            requestedByMemberId: actor.memberId,
            participants: input.participants,
            startedAt: input.now.toISOString(),
            cutoffDate: input.cutoffDate,
        });
        this.props = new Space({
            ...props,
            status: SpaceStatus.CLOSING,
            version: props.version + 1,
            updatedAt: input.now,
            invitations: props.invitations.map((invitation) =>
                invitation.cancelForClosure(input.processId, input.now),
            ),
        }).props;
        return plan;
    }

    proposeClosureCutoff(
        actorPersonId: PersonId,
        plan: ClosurePlan,
        cutoffDate: string,
        now: Date,
    ): ClosurePlan {
        const props = this.requireClosureMember(actorPersonId);
        if (props.status !== SpaceStatus.CLOSING) {
            throw new SpacesDomainError('CLOSURE_PROCESS_NOT_OPEN');
        }
        const next = plan.proposeCutoff(cutoffDate);
        this.props = new Space({
            ...props,
            version: props.version + 1,
            updatedAt: now,
        }).props;
        return next;
    }

    private requireClosureMember(actorPersonId: PersonId): SharedSpaceProps {
        const props = this.props;
        if (props.type !== SpaceType.SHARED) {
            throw new SpacesDomainError('SHARED_SPACE_REQUIRED');
        }
        if (
            !props.members.some(
                (member) =>
                    member.status === MemberStatus.ACTIVE &&
                    member.personId.equals(actorPersonId),
            )
        ) {
            throw new SpacesDomainError('SPACE_NOT_FOUND');
        }
        return props;
    }

    decideClosurePlan(
        actorPersonId: PersonId,
        plan: ClosurePlan,
        action: ClosurePlanAction,
        proposalSnapshot: ClosureProposalSnapshot | undefined,
        now: Date,
    ): ClosurePlan {
        const props = this.requireClosureMember(actorPersonId);
        if (props.status !== SpaceStatus.CLOSING) {
            throw new SpacesDomainError('CLOSURE_PROCESS_NOT_OPEN');
        }
        const member = plan
            .snapshot()
            .participants.find(
                (participant) => participant.personId === actorPersonId.value,
            );
        if (!member)
            throw new SpacesDomainError('CLOSURE_PLAN_DECISION_NOT_ALLOWED');
        const next = plan.decide({
            action,
            actorMemberId: member.memberId,
            proposalSnapshot,
            now,
        });
        this.props = new Space({
            ...props,
            version: props.version + 1,
            updatedAt: now,
        }).props;
        return next;
    }

    upsertClosureDestination(
        actorPersonId: PersonId,
        plan: ClosurePlan,
        destination: ClosureFutureDestination,
        now: Date,
    ): ClosurePlan {
        const props = this.requireClosureMember(actorPersonId);
        if (props.status !== SpaceStatus.CLOSING) {
            throw new SpacesDomainError('CLOSURE_PROCESS_NOT_OPEN');
        }
        const next = plan.upsertDestination(destination);
        this.props = new Space({
            ...props,
            version: props.version + 1,
            updatedAt: now,
        }).props;
        return next;
    }

    confirmClosure(
        actorPersonId: PersonId,
        plan: ClosurePlan,
        input: Omit<ClosureConfirmation, 'actorMemberId'>,
    ): { plan: ClosurePlan; completed: boolean } {
        const { props, actorMemberId } = this.requireClosureConclusion(
            actorPersonId,
            plan,
        );
        const result = plan.confirm({ ...input, actorMemberId });
        this.props = new Space({
            ...props,
            status: result.completed ? SpaceStatus.CLOSED : SpaceStatus.CLOSING,
            version: props.version + 1,
            updatedAt: input.now,
        }).props;
        return result;
    }

    cancelClosure(
        actorPersonId: PersonId,
        plan: ClosurePlan,
        now: Date,
    ): { plan: ClosurePlan; completed: boolean } {
        const { props, actorMemberId } = this.requireClosureConclusion(
            actorPersonId,
            plan,
        );
        const result = plan.cancel({
            actorMemberId,
            now,
            spaceVersion: props.version,
        });
        this.props = new Space({
            ...props,
            status: result.completed ? SpaceStatus.ACTIVE : SpaceStatus.CLOSING,
            version: props.version + 1,
            updatedAt: now,
        }).props;
        return result;
    }

    private requireClosureConclusion(
        actorPersonId: PersonId,
        plan: ClosurePlan,
    ): { props: SharedSpaceProps; actorMemberId: string } {
        const props = this.requireClosureMember(actorPersonId);
        if (props.status !== SpaceStatus.CLOSING)
            throw new SpacesDomainError('CLOSURE_PROCESS_NOT_OPEN');
        const participants = plan.snapshot().participants;
        if (
            props.members.some(
                (member) =>
                    !participants.some(
                        (participant) =>
                            participant.memberId === member.id.value &&
                            participant.personId === member.personId.value,
                    ),
            ) ||
            (participants.length === 1 &&
                !props.createdByPersonId.equals(actorPersonId))
        ) {
            throw new SpacesDomainError('CLOSURE_PARTICIPANTS_CHANGED');
        }
        const actor = participants.find(
            (participant) => participant.personId === actorPersonId.value,
        );
        if (!actor) throw new SpacesDomainError('SPACE_NOT_FOUND');
        return { props, actorMemberId: actor.memberId };
    }

    issueInvitation(
        actorPersonId: PersonId,
        invitationId: InvitationId,
        now: Date,
    ): Invitation {
        const props = this.requireInvitationIssuer(actorPersonId);

        if (
            props.invitations.some(
                (invitation) =>
                    invitation.statusAt(now) === InvitationStatus.PENDING,
            )
        ) {
            throw new SpacesDomainError('INVITATION_ALREADY_PENDING');
        }

        this.assertNewInvitationId(props, invitationId);

        const invitation = Invitation.issue(invitationId, actorPersonId, now);
        const invitations = props.invitations.map((existing) =>
            existing.expireIfDue(now),
        );

        this.commitInvitations(props, [...invitations, invitation], now);

        return invitation;
    }

    replaceInvitation(
        actorPersonId: PersonId,
        invitationId: InvitationId,
        newInvitationId: InvitationId,
        now: Date,
    ): Invitation {
        const props = this.requireInvitationIssuer(actorPersonId);
        const previous = props.invitations.find((invitation) =>
            invitation.id.equals(invitationId),
        );

        if (!previous || previous.statusAt(now) !== InvitationStatus.PENDING) {
            throw new SpacesDomainError('INVITATION_NOT_REPLACEABLE');
        }

        this.assertNewInvitationId(props, newInvitationId);

        const invitation = Invitation.issue(
            newInvitationId,
            actorPersonId,
            now,
        );
        const cancelled = previous.replaceWith(newInvitationId, now);
        const invitations = props.invitations.map((existing) =>
            existing.id.equals(invitationId) ? cancelled : existing,
        );

        this.commitInvitations(props, [...invitations, invitation], now);

        return invitation;
    }

    acceptInvitation(
        actorPersonId: PersonId,
        invitationId: InvitationId,
        memberId: MemberId,
        now: Date,
    ): Member {
        const { props, invitation } = this.requireInvitationResponse(
            actorPersonId,
            invitationId,
            now,
        );
        const accepted = invitation.accept(now);
        const member = Member.create(memberId, actorPersonId, now);

        this.commitInvitationResponse(
            props,
            accepted,
            [...props.members, member],
            now,
        );

        return member;
    }

    rejectInvitation(
        actorPersonId: PersonId,
        invitationId: InvitationId,
        now: Date,
    ): Invitation {
        const { props, invitation } = this.requireInvitationResponse(
            actorPersonId,
            invitationId,
            now,
        );
        const rejected = invitation.reject(now);

        this.commitInvitationResponse(props, rejected, props.members, now);

        return rejected;
    }

    snapshot(): SpaceProps {
        if (this.props.type === SpaceType.SHARED) {
            return {
                ...this.props,
                members: [...this.props.members],
                invitations: [...this.props.invitations],
                createdAt: this.createdAt,
                updatedAt: this.updatedAt,
            };
        }

        return {
            ...this.props,
            createdAt: this.createdAt,
            updatedAt: this.updatedAt,
        };
    }

    private assertInvariants(): void {
        const props = this.props;

        if (
            !props.id ||
            !Number.isSafeInteger(props.version) ||
            props.version < 1 ||
            !Number.isFinite(props.createdAt.getTime()) ||
            !Number.isFinite(props.updatedAt.getTime()) ||
            !Object.values(SpaceStatus).includes(props.status)
        ) {
            throw new Error('Invalid space state');
        }

        if (props.type === SpaceType.PERSONAL) {
            if (
                !props.personalOwnerPersonId ||
                props.status !== SpaceStatus.ACTIVE
            ) {
                throw new Error('Invalid personal space state');
            }

            return;
        }

        if (
            props.type !== SpaceType.SHARED ||
            props.personalOwnerPersonId !== null ||
            !props.createdByPersonId ||
            normalizeName(props.name) !== props.name
        ) {
            throw new Error('Invalid shared space state');
        }

        const activeMembers = props.members.filter(
            (member) => member.status === MemberStatus.ACTIVE,
        );

        if (activeMembers.length > 2) {
            throw new SpacesDomainError('SPACE_MEMBER_LIMIT_REACHED');
        }

        const memberIds = new Set(
            props.members.map((member) => member.id.value),
        );
        const personIds = new Set(
            activeMembers.map((member) => member.personId.value),
        );
        const invitationIds = new Set(
            props.invitations.map((invitation) => invitation.id.value),
        );
        const pendingCount = props.invitations.filter(
            (invitation) => invitation.status === InvitationStatus.PENDING,
        ).length;

        if (
            memberIds.size !== props.members.length ||
            personIds.size !== activeMembers.length ||
            invitationIds.size !== props.invitations.length ||
            pendingCount > 1
        ) {
            throw new Error('Inconsistent shared space children');
        }
    }

    private requireInvitationIssuer(actorPersonId: PersonId): SharedSpaceProps {
        const props = this.props;

        if (
            props.type !== SpaceType.SHARED ||
            !props.members.some(
                (member) =>
                    member.status === MemberStatus.ACTIVE &&
                    member.personId.equals(actorPersonId),
            )
        ) {
            throw new SpacesDomainError('SPACE_NOT_FOUND');
        }

        if (!props.createdByPersonId.equals(actorPersonId)) {
            throw new SpacesDomainError('INVITATION_ISSUER_REQUIRED');
        }

        if (props.status !== SpaceStatus.ACTIVE) {
            throw new SpacesDomainError('SPACE_NOT_ACTIVE');
        }

        if (this.activeMemberCount >= 2) {
            throw new SpacesDomainError('SPACE_MEMBER_LIMIT_REACHED');
        }

        return props;
    }

    private requireInvitationResponse(
        actorPersonId: PersonId,
        invitationId: InvitationId,
        now: Date,
    ): { props: SharedSpaceProps; invitation: Invitation } {
        const props = this.props;

        if (props.type !== SpaceType.SHARED) {
            throw new SpacesDomainError('INVITATION_UNAVAILABLE');
        }

        const invitation = props.invitations.find((candidate) =>
            candidate.id.equals(invitationId),
        );

        if (
            !invitation ||
            invitation.statusAt(now) !== InvitationStatus.PENDING
        ) {
            throw new SpacesDomainError('INVITATION_UNAVAILABLE');
        }

        if (props.status !== SpaceStatus.ACTIVE) {
            throw new SpacesDomainError('SPACE_NOT_ACTIVE');
        }

        if (
            props.createdByPersonId.equals(actorPersonId) ||
            props.members.some(
                (member) =>
                    member.status === MemberStatus.ACTIVE &&
                    member.personId.equals(actorPersonId),
            )
        ) {
            throw new SpacesDomainError('INVITATION_RESPONSE_NOT_ALLOWED');
        }

        if (this.activeMemberCount >= 2) {
            throw new SpacesDomainError('SPACE_MEMBER_LIMIT_REACHED');
        }

        return { props, invitation };
    }

    private commitInvitationResponse(
        props: SharedSpaceProps,
        invitation: Invitation,
        members: readonly Member[],
        now: Date,
    ): void {
        const next = new Space({
            ...props,
            members,
            invitations: props.invitations.map((existing) =>
                existing.id.equals(invitation.id) ? invitation : existing,
            ),
            version: props.version + 1,
            updatedAt: now,
        });

        this.props = next.props;
    }

    private assertNewInvitationId(
        props: SharedSpaceProps,
        id: InvitationId,
    ): void {
        if (props.invitations.some((invitation) => invitation.id.equals(id))) {
            throw new Error('Invitation identity must be new');
        }
    }

    private commitInvitations(
        props: SharedSpaceProps,
        invitations: readonly Invitation[],
        now: Date,
    ): void {
        const next = new Space({
            ...props,
            invitations,
            version: props.version + 1,
            updatedAt: now,
        });

        this.props = next.props;
    }

    get id(): SpaceId {
        return this.props.id;
    }

    get type(): SpaceType {
        return this.props.type;
    }

    get status(): SpaceStatus {
        return this.props.status;
    }

    get personalOwnerPersonId(): PersonId | null {
        return this.props.personalOwnerPersonId;
    }

    get name(): string | null {
        return this.props.type === SpaceType.SHARED ? this.props.name : null;
    }

    get createdByPersonId(): PersonId | null {
        return this.props.type === SpaceType.SHARED
            ? this.props.createdByPersonId
            : null;
    }

    get members(): readonly Member[] {
        return this.props.type === SpaceType.SHARED
            ? [...this.props.members]
            : [];
    }

    get invitations(): readonly Invitation[] {
        return this.props.type === SpaceType.SHARED
            ? [...this.props.invitations]
            : [];
    }

    get activeMemberCount(): number {
        return this.members.filter(
            (member) => member.status === MemberStatus.ACTIVE,
        ).length;
    }

    get version(): number {
        return this.props.version;
    }

    get createdAt(): Date {
        return new Date(this.props.createdAt);
    }

    get updatedAt(): Date {
        return new Date(this.props.updatedAt);
    }
}
