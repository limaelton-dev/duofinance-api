export const SHOPPING_CLOCK = Symbol('SHOPPING_CLOCK');
export interface ShoppingClock {
    now(): Date;
}
const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
});
export function shoppingReference(instant: Date) {
    const parts = Object.fromEntries(
        formatter.formatToParts(instant).map((part) => [part.type, part.value]),
    );
    return {
        referenceDate: `${parts.year}-${parts.month}-${parts.day}`,
        referenceInstant: instant.toISOString(),
    };
}
