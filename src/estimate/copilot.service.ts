import { Injectable, Logger } from '@nestjs/common';
import { AiService } from '../ai/ai.service';
import { EstimateService } from './estimate.service';
import { ContextBuilderService } from './context-builder.service';
import { ReadModeHandler } from './modes/read.handler';
import { ReviewModeHandler } from './modes/review.handler';
import { EditModeHandler } from './modes/edit.handler';
import { compute } from './boq.engine';

import { StreamEvent } from './copilot.types';
export type { StreamEvent } from './copilot.types';

export interface InsightItem {
  title: string;
  detail: string;
  type: 'cost' | 'risk' | 'saving' | 'data' | 'formula';
  impact?: string;
}

type CopilotMode = 'read' | 'review' | 'edit';

// Normalize Vietnamese diacritics so "kiem tra" matches "kiểm tra"
function normalizeVi(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[đĐ]/g, (c) => (c === 'đ' ? 'd' : 'D'));
}

// Regex run against BOTH original and normalized input
const EDIT_INTENT = /(cap nhat|cap_nhat|sua|thay doi|them|xoa|doi|tang|giam|set|update|delete|insert|cap nhat|cập nhật|sửa|thay đổi|thêm|xóa|đổi|tăng|giảm)/i;
const REVIEW_INTENT = /(kiem tra|soat loi|tim loi|quet loi|bat thuong|trung|audit|review|outlier|kiểm tra|soát lỗi|tìm lỗi|quét lỗi|bất thường|trùng)/i;
const PRICE_INTENT = /(gia|don gia|vat lieu|vat tu|dinh muc|du toan|lap|boc|khoi luong|bao gia|thi truong|giá|đơn giá|vật liệu|vật tư|định mức|dự toán|lập|bóc|khối lượng|báo giá|thị trường|cập nhật)/i;

@Injectable()
export class CopilotService {
  private readonly logger = new Logger(CopilotService.name);

  constructor(
    private readonly ai: AiService,
    private readonly estimates: EstimateService,
    private readonly contextBuilder: ContextBuilderService,
    private readonly readHandler: ReadModeHandler,
    private readonly reviewHandler: ReviewModeHandler,
    private readonly editHandler: EditModeHandler,
  ) {}

  async *streamChat(
    userId: string,
    id: string,
    message: string,
    files: Express.Multer.File[] = [],
    activeSheetId?: string,
    selectedRange?: { startRow: number; startCol: number; endRow: number; endCol: number },
    editPermission = false,
  ): AsyncGenerator<StreamEvent> {
    if (!message?.trim() && files.length === 0) {
      yield { event: 'error', data: { message: 'Cần nhập yêu cầu hoặc đính kèm tệp.' } };
      return;
    }
    if (!this.ai.available) {
      yield { event: 'error', data: { message: 'Hệ thống AI chưa được cấu hình.' } };
      return;
    }

    const doc = await this.estimates.getOwned(userId, id);
    const context = this.contextBuilder.buildContext(doc as any, activeSheetId, selectedRange);
    const rawMode = this.detectMode(message);
    // In safe mode (no editPermission) downgrade edit intent to read
    const mode: CopilotMode = !editPermission && rawMode === 'edit' ? 'read' : rawMode;
    this.logger.log(`Copilot mode: ${mode} (raw=${rawMode}, editPermission=${editPermission})`);

    if (!editPermission && rawMode === 'edit') {
      yield { event: 'step', data: { text: 'Chế độ đọc — bật quyền chỉnh sửa để AI đề xuất thay đổi' } };
    }

    if (mode === 'read') {
      yield* this.readHandler.handle(doc as any, context, message);
      return;
    }

    if (mode === 'review') {
      yield* this.reviewHandler.handle(doc as any, context, message);
      return;
    }

    // edit mode (requires editPermission)
    const state = this.estimates.stateForPrompt(doc);
    let research = { text: '', sources: [] as { title?: string; uri?: string }[] };
    const isEmpty = state.takeoff.length === 0 && state.materials.length === 0;
    const isNonPriceEdit = /(xóa|delete|loại bỏ|markup|chi phí chung|lợi nhuận|vat|dự phòng)/i.test(message);

    if (!isNonPriceEdit && (PRICE_INTENT.test(message) || isEmpty)) {
      yield { event: 'step', data: { text: 'Thu thập dữ liệu giá thị trường…' } };
      research = await this.ai.research(this.researchQuery(state, message));
      yield { event: 'step', data: { text: `Tham chiếu ${research.sources.length} nguồn giá` } };
    }

    yield* this.editHandler.handle(state, context, message, files, research);
  }

  async generateInsights(userId: string, id: string): Promise<InsightItem[]> {
    if (!this.ai.available) return [];
    const doc = await this.estimates.getOwned(userId, id);
    const state = this.estimates.stateForPrompt(doc);
    const { boq, costSummary, costs } = compute(state);

    const topItems = [...boq]
      .sort((a, b) => b.total - a.total)
      .slice(0, 5)
      .map((r) => ({ name: r.name, code: r.code, total: r.total, unit: r.unit }));

    const aiPriced = state.materials.filter((m) => m.source?.type === 'ai_estimate').length;
    const noSource = state.materials.filter((m) => !m.source).length;
    const totalCost = costSummary.total || costs.total || 0;
    const vlPct = totalCost ? Math.round((costs.material / totalCost) * 1000) / 10 : 0;
    const ncPct = totalCost ? Math.round((costs.labor / totalCost) * 1000) / 10 : 0;
    const mPct = totalCost ? Math.round((costs.machine / totalCost) * 1000) / 10 : 0;

    const payload = {
      project: state.projectInfo,
      totalCost,
      costBreakdown: { vlPct, ncPct, mPct, overheadPct: totalCost ? Math.round((costSummary.overhead / totalCost) * 1000) / 10 : 0 },
      rawCosts: { material: costs.material, labor: costs.labor, machine: costs.machine },
      markups: state.markups,
      materialCount: state.materials.length,
      aiPricedMaterials: aiPriced,
      noSourceMaterials: noSource,
      takeoffCount: state.takeoff.length,
      boqCount: boq.length,
      topExpensiveItems: topItems,
    };

    const prompt = `Bạn là QS (Quantity Surveyor) chuyên dự toán xây dựng Việt Nam.
Phân tích dự toán dưới đây và sinh ra đúng 6 insight quan trọng nhất.

DỮ LIỆU:
${JSON.stringify(payload, null, 2)}

Quy tắc:
- Mỗi insight phải có số liệu cụ thể từ dữ liệu trên
- Ưu tiên: rủi ro dữ liệu AI, cơ hội tiết kiệm, cơ cấu chi phí bất thường
- Viết bằng tiếng Việt, ngắn gọn

Trả về JSON array (chỉ JSON, không markdown, không text thêm):
[
  {
    "title": "Tiêu đề ngắn (≤55 ký tự)",
    "detail": "Mô tả chi tiết có số liệu (≤110 ký tự)",
    "type": "cost|risk|saving|data|formula",
    "impact": "Tác động định lượng (≤35 ký tự, optional)"
  }
]`;

    try {
      const raw = await this.ai.generate([{ text: prompt }]);
      const clean = raw.replace(/```(?:json)?\n?|\n?```/g, '').trim();
      const parsed = JSON.parse(clean);
      return Array.isArray(parsed) ? (parsed as InsightItem[]).slice(0, 8) : [];
    } catch (err) {
      this.logger.warn('generateInsights parse failed:', err);
      return [];
    }
  }

  private detectMode(message: string): CopilotMode {
    const norm = normalizeVi(message);
    if (REVIEW_INTENT.test(message) || REVIEW_INTENT.test(norm)) return 'review';
    if (EDIT_INTENT.test(message) || EDIT_INTENT.test(norm)) return 'edit';
    return 'read';
  }

  private researchQuery(state: any, message: string): string {
    const loc = state.projectInfo.location ? ` tại ${state.projectInfo.location}` : ' tại Việt Nam';
    return [
      `Bảng giá vật liệu xây dựng MỚI NHẤT${loc} (xi măng PCB40, cát, đá, thép, gạch, sơn).`,
      'Ưu tiên thông báo giá liên Sở / báo giá nhà cung cấp quý gần nhất. Nêu rõ NGÀY và tên nguồn.',
      'Đơn giá nhân công và ca máy hiện hành theo địa phương.',
      `Suất đầu tư "${state.projectInfo.buildingType ?? state.projectInfo.name ?? 'nhà ở dân dụng'}"${loc} (triệu đồng/m² sàn).`,
      message ? `Bối cảnh: ${message}` : '',
    ]
      .filter(Boolean)
      .join('\n');
  }
}
