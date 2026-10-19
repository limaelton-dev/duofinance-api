export const ROUTINE_CLOSURE_PORT = Symbol('ROUTINE_CLOSURE_PORT');
export interface RoutineClosurePort {
    complete(
        actorId: string,
        spaceId: string,
        processId: string,
        now: Date,
    ): Promise<void>;
    summary(
        actorId: string,
        spaceId: string,
    ): Promise<{
        pendingTaskCount: number;
        activeRecurrenceCount: number;
    }>;
}
