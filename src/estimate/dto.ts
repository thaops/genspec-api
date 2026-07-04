import { Transform, Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { Action } from './estimate.types';

/** Safely JSON.parse multipart string fields; invalid JSON → undefined. */
function parseJsonField({ value }: { value: unknown }): unknown {
  if (typeof value !== 'string') return value ?? undefined;
  try {
    const parsed = JSON.parse(value);
    return typeof parsed === 'object' && parsed !== null ? parsed : undefined;
  } catch {
    return undefined;
  }
}

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

export class TakeoffAssumptionsDto {
  @IsNumber()
  @IsPositive()
  floorHeight: number;

  @IsNumber()
  @IsPositive()
  wallThickness: number;

  @IsNumber()
  @IsPositive()
  beamDepth: number;
}

export class TakeoffEngineDto {
  @IsString()
  @MinLength(1)
  drawingId: string;

  @IsNumber()
  @IsPositive()
  unitsPerDrawingUnit: number;

  @ValidateNested()
  @Type(() => TakeoffAssumptionsDto)
  assumptions: TakeoffAssumptionsDto;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  rejectedObjectIds?: string[];
}

export class CopilotDto {
  @IsOptional()
  @IsString()
  message?: string;

  @IsOptional()
  @IsString()
  activeSheetId?: string;

  @IsOptional()
  @Transform(parseJsonField)
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
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  editPermission?: boolean;

  @IsOptional()
  @IsString()
  drawingId?: string;

  @IsOptional()
  @IsString()
  objectId?: string;

  /** Hệ số hiệu chỉnh m/đơn vị vẽ từ FE (localStorage calibration) — multipart gửi string. */
  @IsOptional()
  @Transform(({ value }) => {
    if (value == null || value === '') return undefined;
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  })
  @IsNumber()
  @IsPositive()
  calibrationFactor?: number;

  @IsOptional()
  @Transform(parseJsonField)
  drawingContext?: {
    page?: number;
    scale?: number;
    activeTool?: string;
    layer?: string;
    objectType?: string;
  };
}
