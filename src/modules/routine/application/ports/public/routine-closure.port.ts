export const ROUTINE_CLOSURE_PORT = Symbol('ROUTINE_CLOSURE_PORT');
export interface RoutineClosurePort {
    summary(
        actorId: string,
        spaceId: string,
    ): Promise<{
        pendingTaskCount: number;
        activeRecurrenceCount: number;
    }>;
}
