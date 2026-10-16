import { BadRequestException } from '@nestjs/common';
import { z } from 'zod';

type FieldError = { field: string; messages: string[] };

function fields(issues: readonly z.core.$ZodIssue[]): FieldError[] {
    return issues.flatMap((issue) => {
        // Union errors keep the paths from each branch; never return an empty
        // field merely because personal/shared commands share a union schema.
        if (issue.code === 'invalid_union' && issue.errors.length) {
            const alternatives = issue.errors.map(fields);
            const closest = alternatives.reduce((best, candidate) =>
                candidate.length < best.length ? candidate : best,
            );
            return closest;
        }
        if (issue.code === 'unrecognized_keys')
            return issue.keys.map((key) => ({
                field: [...issue.path, key].join('.'),
                messages: ['Este campo não é permitido.'],
            }));
        return [
            {
                field: issue.path.join('.') || 'body',
                messages: [
                    issue.code === 'custom' && issue.message !== 'Invalid input'
                        ? issue.message
                        : 'Informe um valor válido para este campo.',
                ],
            },
        ];
    });
}

export function parseZodInput<T>(schema: z.ZodType<T>, input: unknown): T {
    const parsed = schema.safeParse(input);
    if (parsed.success) return parsed.data;
    const unique = new Map<string, FieldError>();
    for (const error of fields(parsed.error.issues)) {
        const current = unique.get(error.field);
        if (current)
            current.messages = [
                ...new Set([...current.messages, ...error.messages]),
            ];
        else unique.set(error.field, error);
    }
    throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: 'Verifique os dados informados.',
        details: { fields: [...unique.values()] },
    });
}
