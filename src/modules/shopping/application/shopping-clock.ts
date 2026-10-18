export const SHOPPING_CLOCK = Symbol('SHOPPING_CLOCK');
export interface ShoppingClock {
    now(): Date;
}
