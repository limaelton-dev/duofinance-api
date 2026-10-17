import { FinancesError } from '../errors/finances.error.js';
import { civilDate } from '../shared-expense/settlement-cycle.js';

export type RecurrencePattern =
    | { frequency: 'MONTHLY'; dayOfMonth: number }
    | { frequency: 'ANNUAL'; monthOfYear: number; dayOfMonth: number };

function scheduledDate(year: number, month: number, day: number): string {
    const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
    return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(Math.min(day, last)).padStart(2, '0')}`;
}

export class RecurrenceRule {
    readonly pattern: RecurrencePattern;
    readonly startsOn: string;
    readonly endsOn: string | null;

    constructor(
        pattern: RecurrencePattern,
        startsOn: string,
        endsOn: string | null = null,
    ) {
        civilDate(startsOn);
        if (endsOn !== null) civilDate(endsOn);
        if (
            !Number.isInteger(pattern.dayOfMonth) ||
            pattern.dayOfMonth < 1 ||
            pattern.dayOfMonth > 31 ||
            (pattern.frequency === 'ANNUAL' &&
                (!Number.isInteger(pattern.monthOfYear) ||
                    pattern.monthOfYear < 1 ||
                    pattern.monthOfYear > 12)) ||
            (endsOn !== null && endsOn < startsOn)
        )
            throw new FinancesError('VALIDATION_ERROR', ['recurrence']);
        this.pattern = Object.freeze({ ...pattern });
        this.startsOn = startsOn;
        this.endsOn = endsOn;
        Object.freeze(this);
    }

    dateInMonth(month: string): string | null {
        if (!/^(?!0000)\d{4}-(0[1-9]|1[0-2])$/.test(month))
            throw new FinancesError('VALIDATION_ERROR', ['month']);
        const year = Number(month.slice(0, 4));
        const monthOfYear = Number(month.slice(5));
        if (
            this.pattern.frequency === 'ANNUAL' &&
            this.pattern.monthOfYear !== monthOfYear
        )
            return null;
        const date = scheduledDate(year, monthOfYear, this.pattern.dayOfMonth);
        return date >= this.startsOn &&
            (this.endsOn === null || date <= this.endsOn)
            ? date
            : null;
    }

    contains(referenceDate: string): boolean {
        civilDate(referenceDate);
        return this.dateInMonth(referenceDate.slice(0, 7)) === referenceDate;
    }

    firstOnOrAfter(date: string): string | null {
        civilDate(date);
        const from = date > this.startsOn ? date : this.startsOn;
        let year = Number(from.slice(0, 4));
        let month = Number(from.slice(5, 7));
        for (let n = 0; n < 24; n += 1) {
            const candidate = this.dateInMonth(
                `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}`,
            );
            if (candidate && candidate >= from) return candidate;
            if (
                this.endsOn &&
                `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}` >
                    this.endsOn.slice(0, 7)
            )
                return null;
            month += 1;
            if (month > 12) {
                year += 1;
                month = 1;
            }
        }
        return null;
    }
}
