export const TODAY_CLOCK = Symbol('TODAY_CLOCK');

export interface TodayClock {
    now(): Date;
}

const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
});

export function todayReferenceDate(instant: Date): string {
    return formatter.format(instant);
}
