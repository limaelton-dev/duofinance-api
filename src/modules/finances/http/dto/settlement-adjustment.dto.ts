import { Injectable, type PipeTransform } from '@nestjs/common';
import { z } from 'zod';
import { parseZodInput } from '../../../../shared/technical/http/validation/parse-zod-input.js';
import { civilDate } from '../../domain/shared-expense/settlement-cycle.js';
const uuid = z.uuid().transform((v) => v.toLowerCase());
const version = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const date = z.string().refine((v) => {
    try {
        civilDate(v);
        return true;
    } catch {
        return false;
    }
}, 'Informe uma data civil válida.');
const configure = z
    .object({
        rule: z
            .object({
                kind: z.literal('MONTHLY_DAY'),
                dayOfMonth: z.number().int().min(1).max(31),
            })
            .strict(),
        expectedCommitmentVersion: version,
        expectedSpaceVersion: version,
    })
    .strict();
const move = z
    .object({
        settlement: z.discriminatedUnion('mode', [
            z.object({ mode: z.literal('NONE') }).strict(),
            z.object({ mode: z.literal('DATE'), targetDate: date }).strict(),
            z.object({ mode: z.literal('CYCLE'), cycleId: uuid }).strict(),
        ]),
        expectedObligationVersion: version,
        expectedSpaceVersion: version,
        expectedCycleVersions: z
            .array(z.object({ cycleId: uuid, version }).strict())
            .max(2)
            .refine(
                (items) =>
                    new Set(items.map((i) => i.cycleId)).size === items.length,
                'Informe cada ciclo uma única vez.',
            ),
    })
    .strict();
export type ConfigureCommitmentSettlementRuleDto = z.infer<typeof configure>;
export type MoveObligationDto = z.infer<typeof move>;
@Injectable()
export class ConfigureCommitmentSettlementRulePipe implements PipeTransform {
    transform(input: unknown) {
        return parseZodInput(configure, input);
    }
}
@Injectable()
export class MoveObligationPipe implements PipeTransform {
    transform(input: unknown) {
        return parseZodInput(move, input);
    }
}
