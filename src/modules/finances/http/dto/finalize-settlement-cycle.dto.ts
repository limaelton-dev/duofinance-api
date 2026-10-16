import { Injectable, type PipeTransform } from '@nestjs/common';
import { z } from 'zod';
import { parseZodInput } from '../../../../shared/technical/http/validation/parse-zod-input.js';
const version = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const input = z
    .object({ expectedSpaceVersion: version, expectedCycleVersion: version })
    .strict();
export type FinalizeSettlementCycleDto = z.infer<typeof input>;
@Injectable()
export class FinalizeSettlementCyclePipe implements PipeTransform {
    transform(value: unknown) {
        return parseZodInput(input, value);
    }
}
