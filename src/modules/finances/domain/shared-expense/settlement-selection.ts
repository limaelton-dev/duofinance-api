export type SettlementSelection =
    | { mode: 'NONE' }
    | { mode: 'DATE'; targetDate: string }
    | { mode: 'CYCLE'; cycleId: string }
    | { mode: 'SUGGESTED'; referenceDate: string; expectedRuleVersion: number };
