import { IsArray, IsIn, IsOptional, IsString, MinLength } from 'class-validator';
import { Action } from './estimate.types';

export class CreateEstimateDto {
  @IsString()
  @MinLength(1)
  name: string;
}

export class ActionsDto {
  @IsArray()
  actions: Action[];

  @IsOptional()
  @IsIn(['ai', 'manual'])
  source?: 'ai' | 'manual';
}

export class CopilotDto {
  @IsOptional()
  @IsString()
  message?: string;

  @IsOptional()
  @IsString()
  activeSheetId?: string;

  @IsOptional()
  selectedRange?: {
    startRow: number;
    startCol: number;
    endRow: number;
    endCol: number;
  };

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  visibleSheets?: string[];

  @IsOptional()
  editPermission?: boolean;
}
