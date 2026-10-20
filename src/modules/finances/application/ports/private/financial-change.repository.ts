import type { CommitmentChangeProposal } from '../../../domain/commitment-change/commitment-change-proposal.js';

export const FINANCIAL_CHANGE_REPOSITORY = Symbol(
    'FINANCIAL_CHANGE_REPOSITORY',
);
export interface FinancialChangeOrigin {
    id: string;
    kind: 'EXPENSE' | 'INCOME';
    modality: 'ONE_TIME' | 'RECURRING' | 'INSTALLMENT';
    version: number;
    fingerprint: string;
}
export interface IntegrityReceiptKey {
    actorId: string;
    spaceId: string;
    commitmentId: string;
    operation: string;
    key: string;
    hash: Buffer;
}
export interface FinancialChangeRepository {
    snapshot<T>(work: () => Promise<T>): Promise<T>;
    origin(
        spaceId: string,
        id: string,
        lock?: boolean,
    ): Promise<FinancialChangeOrigin | null>;
    insert(proposal: CommitmentChangeProposal): Promise<void>;
    update(
        proposal: CommitmentChangeProposal,
        expectedVersion: number,
    ): Promise<void>;
    find(
        spaceId: string,
        commitmentId: string,
        id: string,
    ): Promise<CommitmentChangeProposal | null>;
    list(
        spaceId: string,
        recipientMemberId: string | null,
        status: string | null,
        after: string | null,
    ): Promise<{ items: CommitmentChangeProposal[]; totalCount: number }>;
    receipt(key: IntegrityReceiptKey): Promise<object | null>;
    saveReceipt(
        key: IntegrityReceiptKey,
        result: object,
        now: string,
    ): Promise<void>;
}
