import { z } from 'zod';
import { uuid, civilDate, urgency, pageQuery, version } from './routine.dto.js';
const day = z.number().int().min(1).max(31),
    weekday = z.number().int().min(1).max(7);
export const taskRecurrenceRule = z.discriminatedUnion('frequency', [
    z.object({ frequency: z.literal('DAILY') }).strict(),
    z.object({ frequency: z.literal('WEEKLY'), weekday }).strict(),
    z
        .object({
            frequency: z.literal('WEEKDAYS'),
            weekdays: z
                .array(weekday)
                .min(1)
                .max(7)
                .refine(
                    (days) => new Set(days).size === days.length,
                    'Não repita dias da semana.',
                )
                .transform((days) => days.sort((a, b) => a - b)),
        })
        .strict(),
    z.object({ frequency: z.literal('MONTHLY'), day }).strict(),
    z
        .object({
            frequency: z.literal('ANNUAL'),
            month: z.number().int().min(1).max(12),
            day,
        })
        .strict()
        .refine(
            (rule) =>
                rule.day <=
                new Date(Date.UTC(2024, rule.month, 0)).getUTCDate(),
            { path: ['day'], message: 'Informe um dia válido para este mês.' },
        ),
]);
export const createTaskRecurrence = z
    .object({
        description: z.string().trim().min(1).max(500),
        assigneeMemberId: uuid.nullable().optional(),
        urgency: urgency.default('NORMAL'),
        deadline: z
            .object({
                time: z
                    .string()
                    .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
                    .nullable()
                    .default(null),
            })
            .strict()
            .nullable()
            .default(null),
        rule: taskRecurrenceRule,
        startsOn: civilDate,
        endsOn: civilDate.nullable().default(null),
    })
    .strict()
    .refine((r) => r.endsOn === null || r.endsOn >= r.startsOn, {
        path: ['endsOn'],
        message: 'O fim deve ser igual ou posterior ao início.',
    });
export const recurrenceParams = z
    .object({
        spaceId: uuid,
        recurrenceId: uuid.optional(),
        scheduledDate: civilDate.optional(),
    })
    .strict();
export const occurrenceInput = z
    .object({
        expectedRecurrenceVersion: version,
        expectedOccurrenceVersion: version.nullable(),
    })
    .strict();
export const occurrencePage = pageQuery.extend({
    from: civilDate.optional(),
    to: civilDate.optional(),
});
export const cancelRecurrence = z.object({ expectedVersion: version }).strict();
