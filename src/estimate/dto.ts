import { Transform, Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsDefined,
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

export class RepriceDto {
  /** Tỉnh cần áp giá — bỏ trống thì lấy theo projectInfo.location. */
  @IsOptional()
  @IsString()
  province?: string;
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

/** Vùng bóc (world coords bản vẽ): chỉ đối tượng có tâm bbox trong vùng được tính. */
export class TakeoffRegionDto {
  @IsNumber()
  x: number;

  @IsNumber()
  y: number;

  @IsNumber()
  @IsPositive()
  w: number;

  @IsNumber()
  @IsPositive()
  h: number;
}

export class TakeoffEngineDto {
  @IsString()
  @MinLength(1)
  drawingId: string;

  @IsNumber()
  @IsPositive()
  unitsPerDrawingUnit: number;

  /**
   * `@ValidateNested()` KHÔNG tự bắt thiếu field: class-validator bỏ qua giá trị
   * `undefined` nên request thiếu `assumptions` LỌT qua validation → engine destructure
   * `{ floorHeight, wallThickness, beamDepth } = assumptions` → TypeError → **500**
   * (đã dựng lại được trên production). `@IsDefined()` để trả 400 đúng nghĩa.
   */
  @IsDefined()
  @ValidateNested()
  @Type(() => TakeoffAssumptionsDto)
  assumptions: TakeoffAssumptionsDto;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  rejectedObjectIds?: string[];

  @IsOptional()
  @ValidateNested()
  @Type(() => TakeoffRegionDto)
  region?: TakeoffRegionDto;

  /** ⚡ là hành động chỉnh sửa → dòng thiếu mã được gán mã phổ thông mặc định. */
  @IsOptional()
  @IsBoolean()
  editPermission?: boolean;

  /** Bộ môn bản vẽ (KT/KC/DIEN/NUOC/KHAC) — FE tuỳ chọn gửi kèm; BE tự đọc từ drawing doc là chuẩn. */
  @IsOptional()
  @IsString()
  discipline?: string;
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

  /** Phiên chat để lấy history — không có → session mới nhất (hành vi cũ). */
  @IsOptional()
  @IsString()
  chatSessionId?: string;

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
