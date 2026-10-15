import {
    IsIn,
    IsString,
    IsUUID,
    Matches,
    MaxLength,
    MinLength,
    ValidateIf,
} from 'class-validator';
import type { FinancialReviewView } from '../../application/models/financial-review.js';
export class FinancialOverviewQueryDto {
    @IsString()
    @Matches(/^(?!0000)\d{4}-(0[1-9]|1[0-2])$/)
    month!: string;
    @ValidateIf((_, value) => value !== undefined)
    @IsUUID('all')
    memberId?: string;
}
export class FinancialForecastQueryDto extends FinancialOverviewQueryDto {
    @ValidateIf((_, value) => value !== undefined)
    @IsString()
    @MinLength(1)
    @MaxLength(1024)
    cursor?: string;
}
export class FinancialTimelineQueryDto extends FinancialForecastQueryDto {
    @IsIn(['CALENDAR', 'HISTORY'])
    view!: FinancialReviewView;
}
