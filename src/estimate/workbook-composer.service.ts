/**
 * WorkbookComposerService — Semantic Layer của GenSpec.
 *
 * Biến EstimateState (dữ liệu kỹ thuật của engine) thành các "derived sheet" mà QS dùng được
 * (Dashboard, BOQ Summary, Validation, AI Findings, Drawing Index, Door Schedule, Cost Summary).
 *
 * Bất biến:
 *  - Derived sheet = pure view: sinh mỗi lần đọc, KHÔNG lưu DB, KHÔNG đụng sheet của user.
 *  - Thêm sheet mới (Steel/Window/MEP…) = thêm composer thuần ở composers.ts, không sửa engine.
 */
import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { CostSummary, Markups, ProjectInfo, Sheet, TakeoffItem, ValidationReport } from './estimate.types';
import { Drawing, DrawingDocument } from '../drawing/schemas/drawing.schema';
import { DrawingObject, DrawingObjectDocument } from '../drawing/schemas/drawing-object.schema';
import { composeAll, ComposeInput, DrawingLite, EntityLite, EntityTypeCount } from './workbook-composer/composers';

/** Cap số cửa/lỗ mở nạp vào Door Schedule (tránh GET nặng khi bản vẽ rất lớn). */
const DOOR_CAP = 500;

export interface ComposeSource {
  name: string;
  projectInfo: ProjectInfo;
  takeoff: TakeoffItem[];
  costSummary: CostSummary;
  markups: Markups;
  validation: ValidationReport;
}

@Injectable()
export class WorkbookComposerService {
  private readonly logger = new Logger(WorkbookComposerService.name);
  constructor(
    @InjectModel(Drawing.name) private readonly drawingModel: Model<DrawingDocument>,
    @InjectModel(DrawingObject.name) private readonly objectModel: Model<DrawingObjectDocument>,
  ) {}

  /**
   * Sinh derived sheets cho một estimate. Lỗi truy vấn drawing KHÔNG được làm hỏng GET —
   * degrade về composer chỉ dùng state (drawings/doors rỗng), vẫn ra Dashboard/BOQ/Cost.
   */
  async deriveSheets(estimateId: string, src: ComposeSource): Promise<Sheet[]> {
    let drawings: DrawingLite[] = [];
    let typeCounts: EntityTypeCount[] = [];
    let doors: EntityLite[] = [];
    try {
      const drws = await this.drawingModel
        .find({ estimateId }, { _id: 1, name: 1, discipline: 1 })
        .lean()
        .exec();
      drawings = drws.map((d) => ({
        id: String(d._id),
        name: d.name ?? '',
        discipline: (d as any).discipline ?? 'KHAC',
      }));

      if (drawings.length) {
        const ids = drawings.map((d) => d.id);
        // Phân bố loại đối tượng theo bản vẽ (1 aggregate nhẹ, không nạp full doc).
        const agg = await this.objectModel.aggregate<{ _id: { d: string; t: string }; n: number }>([
          { $match: { drawingId: { $in: ids } } },
          { $group: { _id: { d: '$drawingId', t: '$type' }, n: { $sum: 1 } } },
        ]);
        typeCounts = agg.map((a) => ({ drawingId: a._id.d, type: a._id.t, n: a.n }));

        // Door/window entity thật cho schedule (cap để GET không phình).
        const doorDocs = await this.objectModel
          .find(
            { drawingId: { $in: ids }, type: { $in: ['door', 'window'] } },
            { drawingId: 1, type: 1, layer: 1, boundingBox: 1 },
          )
          .limit(DOOR_CAP)
          .lean()
          .exec();
        doors = doorDocs.map((o) => ({
          drawingId: o.drawingId,
          type: o.type,
          layer: o.layer ?? '',
          w: o.boundingBox?.w ?? 0,
          h: o.boundingBox?.h ?? 0,
        }));
      }
    } catch (e) {
      this.logger.warn(`deriveSheets: bỏ qua dữ liệu bản vẽ (${(e as Error).message})`);
    }

    const input: ComposeInput = { ...src, drawings, typeCounts, doors };
    return composeAll(input);
  }
}
