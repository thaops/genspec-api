import { Injectable, Logger } from '@nestjs/common';
import { AiService } from '../ai/ai.service';
import { EstimateService } from './estimate.service';
import { ContextBuilderService } from './context-builder.service';
import { ReadModeHandler } from './modes/read.handler';
import { ReviewModeHandler } from './modes/review.handler';
import { EditModeHandler } from './modes/edit.handler';

import { StreamEvent } from './copilot.types';
export type { StreamEvent } from './copilot.types';

type CopilotMode = 'read' | 'review' | 'edit';

const EDIT_INTENT = /(cập nhật|sửa|thay đổi|thêm|xóa|đổi|tăng|giảm|set|update|delete|insert)/i;
const REVIEW_INTENT = /(kiểm tra|soát lỗi|tìm lỗi|audit|review|quét lỗi|outlier|bất thường|trùng)/i;
const PRICE_INTENT = /(giá|đơn giá|vật liệu|vật tư|định mức|dự toán|lập|bóc|khối lượng|báo giá|thị trường|cập nhật)/i;

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
    const mode = this.detectMode(message);
    this.logger.log(`Copilot mode: ${mode}`);

    if (mode === 'read') {
      yield* this.readHandler.handle(doc as any, context, message);
      return;
    }

    if (mode === 'review') {
      yield* this.reviewHandler.handle(doc as any, context, message);
      return;
    }

    // edit mode
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

  private detectMode(message: string): CopilotMode {
    if (REVIEW_INTENT.test(message)) return 'review';
    if (EDIT_INTENT.test(message)) return 'edit';
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
