export const CLOSURE_CLOCK = Symbol('CLOSURE_CLOCK');
export interface ClosureClock {
    now(): Date;
}
