import {
    IsIn,
    IsString,
    IsUUID,
    MaxLength,
    MinLength,
    ValidateIf,
} from 'class-validator';
import type { SettlementCycleView } from '../../application/models/settlement-cycle.js';
import { InterMemberPositionQueryDto } from './inter-member-position-query.dto.js';
import { SettlementRuleParamsDto } from './configure-default-settlement-rule.dto.js';
export class SettlementCyclesQueryDto {
    @ValidateIf((_, value) => value !== undefined)
    @IsIn(['OPEN', 'UPCOMING'], { message: 'Informe uma consulta válida.' })
    view?: SettlementCycleView;
    @ValidateIf((_, value) => value !== undefined)
    @IsString({ message: 'Informe um cursor válido.' })
    @MinLength(1, { message: 'Informe um cursor válido.' })
    @MaxLength(512, { message: 'Informe um cursor válido.' })
    cursor?: string;
}
export class SettlementCycleQueryDto extends InterMemberPositionQueryDto {}
export class SettlementCycleParamsDto extends SettlementRuleParamsDto {
    @IsUUID('all', { message: 'Informe um acerto válido.' })
    cycleId!: string;
}
