export const ROUTINE_CLOCK = Symbol('ROUTINE_CLOCK');
export interface RoutineClock {
    now(): Date;
}
const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
});
export function routineReference(now: Date) {
    const parts = Object.fromEntries(
        formatter.formatToParts(now).map((p) => [p.type, p.value]),
    );
    return {
        referenceDate: `${parts.year}-${parts.month}-${parts.day}`,
        referenceTime: `${parts.hour}:${parts.minute}`,
        referenceInstant: now.toISOString(),
    };
}
