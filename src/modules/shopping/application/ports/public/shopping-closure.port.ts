export const SHOPPING_CLOSURE_PORT = Symbol('SHOPPING_CLOSURE_PORT');
export interface ShoppingClosurePort {
    summary(
        actorId: string,
        spaceId: string,
    ): Promise<{ activeListCount: number }>;
}
