import {
    IsIn,
    IsString,
    MaxLength,
    MinLength,
    ValidateIf,
} from 'class-validator';
import type { PositionDirection } from '../../application/models/inter-member-position.js';
export class InterMemberPositionQueryDto {
    @ValidateIf((_, value) => value !== undefined)
    @IsIn(['ALL', 'PAYABLE', 'RECEIVABLE'], {
        message: 'Informe uma direção válida.',
    })
    direction?: PositionDirection;
    @ValidateIf((_, value) => value !== undefined)
    @IsString({ message: 'Informe um cursor válido.' })
    @MinLength(1, { message: 'Informe um cursor válido.' })
    @MaxLength(512, { message: 'Informe um cursor válido.' })
    cursor?: string;
}
