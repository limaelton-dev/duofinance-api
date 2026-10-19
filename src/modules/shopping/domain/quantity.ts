import { ShoppingError } from './shopping-error.js';

export class Quantity {
    static readonly MAX_SCALED_UNITS = 999999999999999;
    private constructor(public readonly scaledUnits: number) {}
    static from(
        value: unknown,
        field = 'quantity',
        allowZero = false,
    ): Quantity {
        if (typeof value !== 'string')
            throw new ShoppingError('VALIDATION_ERROR', field);
        const match = /^(0|[1-9]\d{0,11})(?:\.(\d{1,3}))?$/.exec(value);
        if (!match) throw new ShoppingError('VALIDATION_ERROR', field);
        const scaled =
            Number(match[1]) * 1000 + Number((match[2] ?? '').padEnd(3, '0'));
        if (
            !Number.isSafeInteger(scaled) ||
            scaled > Quantity.MAX_SCALED_UNITS ||
            scaled < (allowZero ? 0 : 1)
        )
            throw new ShoppingError('VALIDATION_ERROR', field);
        return new Quantity(scaled);
    }
    add(other: Quantity, field = 'quantity'): Quantity {
        const sum = this.scaledUnits + other.scaledUnits;
        if (!Number.isSafeInteger(sum) || sum > Quantity.MAX_SCALED_UNITS)
            throw new ShoppingError('VALIDATION_ERROR', field);
        return new Quantity(sum);
    }
    subtractFloor(other: Quantity): Quantity {
        return new Quantity(Math.max(this.scaledUnits - other.scaledUnits, 0));
    }
    toString(): string {
        const whole = Math.floor(this.scaledUnits / 1000);
        const fraction = String(this.scaledUnits % 1000)
            .padStart(3, '0')
            .replace(/0+$/, '');
        return `${whole}${fraction ? '.' + fraction : ''}`;
    }
}
