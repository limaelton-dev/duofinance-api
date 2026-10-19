export const SHOPPING_CLOSURE_PORT = Symbol('SHOPPING_CLOSURE_PORT');
export interface ShoppingClosurePort {
    complete(
        actorId: string,
        spaceId: string,
        processId: string,
        now: Date,
    ): Promise<void>;
    summary(
        actorId: string,
        spaceId: string,
    ): Promise<{ activeListCount: number }>;
}
