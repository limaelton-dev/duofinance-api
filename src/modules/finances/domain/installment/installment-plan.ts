import { FinancesError } from '../errors/finances.error.js';
import { civilDate } from '../shared-expense/settlement-cycle.js';

export type InstallmentCadence = 'MONTHLY' | 'ANNUAL';
export type InstallmentStatus = 'PENDING' | 'PARTIALLY_FULFILLED' | 'FULFILLED';

export interface InstallmentScheduleInput {
    count: number;
    firstDueDate?: string;
    cadence?: InstallmentCadence;
    explicitDueDates?: readonly string[];
    totalAmountInCents?: number;
    baseAmountInCents?: number;
    amountsInCents?: readonly number[];
}

export interface InstallmentScheduleEntry {
    position: number;
    dueDate: string;
    amountInCents: number;
}

function invalid(field: string): never {
    throw new FinancesError('VALIDATION_ERROR', [field]);
}

function positiveCents(value: number, field: string): number {
    if (!Number.isSafeInteger(value) || value < 1) invalid(field);
    return value;
}

function validDate(value: string, field: string): string {
    try {
        return civilDate(value);
    } catch {
        return invalid(field);
    }
}

function daysInMonth(year: number, month: number): number {
    if (month === 2)
        return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
            ? 29
            : 28;
    return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function periodicDate(
    firstDueDate: string,
    cadence: InstallmentCadence,
    offset: number,
): string {
    const year = Number(firstDueDate.slice(0, 4));
    const month = Number(firstDueDate.slice(5, 7));
    const day = Number(firstDueDate.slice(8, 10));
    const monthIndex =
        year * 12 + month - 1 + offset * (cadence === 'ANNUAL' ? 12 : 1);
    const targetYear = Math.floor(monthIndex / 12);
    const targetMonth = (monthIndex % 12) + 1;
    if (targetYear > 9999) invalid('count');
    const targetDay = Math.min(day, daysInMonth(targetYear, targetMonth));
    return `${String(targetYear).padStart(4, '0')}-${String(targetMonth).padStart(2, '0')}-${String(targetDay).padStart(2, '0')}`;
}

export function createInstallmentSchedule(
    input: InstallmentScheduleInput,
): readonly InstallmentScheduleEntry[] {
    if (!Number.isSafeInteger(input.count) || input.count < 1) invalid('count');
    const explicit = input.explicitDueDates !== undefined;
    if (
        explicit
            ? input.firstDueDate !== undefined ||
              input.cadence !== undefined ||
              input.explicitDueDates!.length !== input.count
            : input.firstDueDate === undefined ||
              (input.cadence !== 'MONTHLY' && input.cadence !== 'ANNUAL')
    )
        invalid('schedule');
    const amountModes = [
        input.totalAmountInCents !== undefined,
        input.baseAmountInCents !== undefined,
        input.amountsInCents !== undefined,
    ].filter(Boolean).length;
    if (amountModes !== 1) invalid('amountInCents');

    const dates = explicit
        ? input.explicitDueDates!.map((date) =>
              validDate(date, 'explicitDueDates'),
          )
        : Array.from({ length: input.count }, (_, index) =>
              periodicDate(
                  validDate(input.firstDueDate!, 'firstDueDate'),
                  input.cadence!,
                  index,
              ),
          );
    for (let index = 1; index < dates.length; index += 1)
        if (dates[index]! <= dates[index - 1]!) invalid('explicitDueDates');

    let amounts: number[];
    if (input.amountsInCents !== undefined) {
        if (input.amountsInCents.length !== input.count)
            invalid('amountsInCents');
        amounts = input.amountsInCents.map((amount) =>
            positiveCents(amount, 'amountsInCents'),
        );
    } else if (input.baseAmountInCents !== undefined) {
        const base = positiveCents(
            input.baseAmountInCents,
            'baseAmountInCents',
        );
        amounts = Array(input.count).fill(base) as number[];
    } else {
        const total = positiveCents(
            input.totalAmountInCents!,
            'totalAmountInCents',
        );
        const base = Math.floor(total / input.count);
        if (base < 1) invalid('totalAmountInCents');
        amounts = Array(input.count).fill(base) as number[];
        amounts[input.count - 1] = total - base * (input.count - 1);
    }
    const total = amounts.reduce((sum, amount) => sum + BigInt(amount), 0n);
    if (total > BigInt(Number.MAX_SAFE_INTEGER)) invalid('amountInCents');
    return Object.freeze(
        dates.map((dueDate, index) =>
            Object.freeze({
                position: index + 1,
                dueDate,
                amountInCents: amounts[index]!,
            }),
        ),
    );
}

export class Installment {
    readonly remainingAmountInCents: number;

    constructor(
        readonly id: string,
        readonly position: number,
        readonly dueDate: string,
        readonly amountInCents: number,
        readonly status: InstallmentStatus = 'PENDING',
        readonly fulfilledAmountInCents = 0,
        readonly stateVersion = 1,
    ) {
        if (!id || !Number.isSafeInteger(position) || position < 1)
            invalid('installments');
        validDate(dueDate, 'dueDate');
        positiveCents(amountInCents, 'amountInCents');
        if (
            !Number.isSafeInteger(fulfilledAmountInCents) ||
            fulfilledAmountInCents < 0 ||
            fulfilledAmountInCents > amountInCents
        )
            invalid('fulfilledAmountInCents');
        if (!Number.isSafeInteger(stateVersion) || stateVersion < 1)
            invalid('stateVersion');
        const actualStatus =
            fulfilledAmountInCents === 0
                ? 'PENDING'
                : fulfilledAmountInCents === amountInCents
                  ? 'FULFILLED'
                  : 'PARTIALLY_FULFILLED';
        if (status !== actualStatus) invalid('status');
        this.remainingAmountInCents = amountInCents - fulfilledAmountInCents;
        Object.freeze(this);
    }
}

export class InstallmentPlan {
    readonly installments: readonly Installment[];
    readonly count: number;
    readonly totalAmountInCents: number;
    readonly status: 'OPEN' | 'COMPLETED';

    constructor(
        readonly id: string,
        readonly commitmentId: string,
        readonly spaceId: string,
        installments: readonly Installment[],
    ) {
        if (!id || !commitmentId || !spaceId || installments.length < 1)
            invalid('installments');
        const ids = new Set<string>();
        let total = 0n;
        for (const [index, installment] of installments.entries()) {
            if (
                !(installment instanceof Installment) ||
                ids.has(installment.id) ||
                installment.position !== index + 1 ||
                (index > 0 &&
                    installment.dueDate <= installments[index - 1]!.dueDate)
            )
                invalid('installments');
            ids.add(installment.id);
            total += BigInt(installment.amountInCents);
        }
        if (total > BigInt(Number.MAX_SAFE_INTEGER)) invalid('installments');
        this.installments = Object.freeze([...installments]);
        this.count = installments.length;
        this.totalAmountInCents = Number(total);
        this.status = installments.every(
            (installment) => installment.status === 'FULFILLED',
        )
            ? 'COMPLETED'
            : 'OPEN';
        Object.freeze(this);
    }
}
