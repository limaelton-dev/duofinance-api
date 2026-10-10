import { invalidExpense } from './validation.js';
export class Money {
    private constructor(readonly amountInCents: number) {
        Object.freeze(this);
    }
    static from(value: number): Money {
        if (!Number.isSafeInteger(value) || value < 0) invalidExpense();
        return new Money(value);
    }
    add(other: Money): Money {
        return Money.from(this.amountInCents + other.amountInCents);
    }
    subtract(other: Money): Money {
        return Money.from(this.amountInCents - other.amountInCents);
    }
}
