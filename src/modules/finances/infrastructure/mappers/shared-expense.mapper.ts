import type {
    FinancialCommitment,
    ExpenseVersion,
    InterMemberObligation,
    EconomicShare,
} from '../../domain/shared-expense/shared-expense.js';
export function commitmentRow(c: FinancialCommitment<ExpenseVersion>) {
    return {
        id: c.id,
        spaceId: c.spaceId,
        kind: c.kind,
        modality: c.modality,
        description: c.description,
        createdBy: c.createdByPersonId,
        personalOwnerPersonId:
            'ownerPersonId' in c.initialVersion
                ? c.initialVersion.ownerPersonId
                : null,
        version: 1,
        registeredAt: new Date(c.registeredAt),
    };
}
export function versionRow(c: FinancialCommitment<ExpenseVersion>) {
    const v = c.initialVersion;
    if ('ownerPersonId' in v)
        return {
            commitmentId: c.id,
            spaceId: c.spaceId,
            version: 1,
            amountInCents: v.amount.amountInCents,
            factDate: v.factDate,
            expectedPayerMemberId: null,
            splitMode: null,
            splitInput: null,
            ruleSnapshot: null,
            ruleSourceVersion: 0,
            suggestedTargetDate: null,
        };
    return {
        commitmentId: c.id,
        spaceId: c.spaceId,
        version: 1,
        amountInCents: v.split.total.amountInCents,
        expectedPayerMemberId: v.expectedPayerMemberId,
        factDate: v.factDate,
        splitMode: v.split.original.mode,
        splitInput: v.split.original,
        ruleSnapshot: v.settlementRuleSnapshot,
        ruleSourceVersion: v.settlementRuleSourceVersion,
        suggestedTargetDate: v.suggestedTargetDate,
    };
}
export function shareRow(c: FinancialCommitment, share: EconomicShare) {
    const v = c.initialVersion;
    const original = v.split.original.shares.find(
        (s) => s.memberId === share.memberId,
    )!;
    return {
        commitmentId: c.id,
        spaceId: c.spaceId,
        version: 1,
        memberId: share.memberId,
        amountInCents: share.amountInCents,
        splitMode: v.split.original.mode,
        originalAmountInCents:
            'amountInCents' in original ? original.amountInCents : null,
        basisPoints: 'basisPoints' in original ? original.basisPoints : null,
    };
}
export function disbursementRow(c: FinancialCommitment<ExpenseVersion>) {
    const d = c.disbursement;
    return {
        id: d.id,
        spaceId: c.spaceId,
        commitmentId: c.id,
        version: 1,
        payerMemberId: 'payerMemberId' in d ? d.payerMemberId : null,
        payerPersonId: 'payerPersonId' in d ? d.payerPersonId : null,
        amountInCents: d.amountInCents,
        method: d.method,
        factDate: d.factDate,
        registeredAt: new Date(d.registeredAt),
    };
}
export function obligationRow(o: InterMemberObligation) {
    return {
        id: o.id,
        spaceId: o.spaceId,
        commitmentId: o.originCommitmentId,
        disbursementId:
            o.originKind === 'EXPENSE' ? o.originDisbursementId : null,
        receiptId: o.originKind === 'INCOME' ? o.originDisbursementId : null,
        debtorMemberId: o.debtorMemberId,
        creditorMemberId: o.creditorMemberId,
        originalAmountInCents: o.originalAmountInCents,
        remainingAmountInCents: o.remainingAmountInCents,
        status: o.status,
        cycleId: o.cycleId,
        version: 1,
        factDate: o.factDate,
        registeredAt: new Date(o.registeredAt),
    };
}
export function obligationChangeRow(o: InterMemberObligation) {
    return {
        obligationId: o.id,
        spaceId: o.spaceId,
        version: 1,
        actorId: o.history.actorId,
        type: 'CREATED',
        snapshot: {
            originCommitmentId: o.originCommitmentId,
            ...(o.originKind === 'EXPENSE'
                ? { originDisbursementId: o.originDisbursementId }
                : { originReceiptId: o.originDisbursementId }),
            debtorMemberId: o.debtorMemberId,
            creditorMemberId: o.creditorMemberId,
            originalAmountInCents: o.originalAmountInCents,
            remainingAmountInCents: o.remainingAmountInCents,
            cycleId: o.cycleId,
        },
        registeredAt: new Date(o.registeredAt),
    };
}
