import { Injectable } from '@nestjs/common';
import { AiService } from '../../ai/ai.service';
import { WorkbookContext } from '../context-builder.service';
import { StreamEvent } from '../copilot.types';
import { searchWorkbook } from '../tools/tool-registry';
import { Workbook } from '../estimate.types';

const SEARCH_INTENT = /(tìm|tìm kiếm|ở đâu|nằm ở|xuất hiện|có bao nhiêu|đang ở)/i;

@Injectable()
export class ReadModeHandler {
  constructor(private readonly ai: AiService) {}

  async *handle(workbook: Workbook, context: WorkbookContext, message: string): AsyncGenerator<StreamEvent> {
    yield { event: 'step', data: { text: 'Đọc cấu trúc Workbook…' } };

    let searchContext = '';
    if (SEARCH_INTENT.test(message)) {
      const kw = this.extractSearchKeyword(message);
      if (kw) {
        yield { event: 'step', data: { text: `Tìm "${kw}" trong Workbook…` } };
        const sr = searchWorkbook(workbook, kw);
        if (sr.ok && sr.data.length > 0) {
          searchContext = `KẾT QUẢ TÌM KIẾM "${kw}" (${sr.data.length} kết quả):\n${JSON.stringify(sr.data.slice(0, 15))}`;
        } else {
          searchContext = `Không tìm thấy "${kw}" trong Workbook.`;
        }
      }
    }

    const prompt = this.buildPrompt(context, message, searchContext);
    let reply = '';
    try {
      for await (const chunk of this.ai.stream([{ text: prompt }])) {
        reply += chunk;
        yield { event: 'token', data: { text: chunk } };
      }
    } catch (err) {
      yield { event: 'error', data: { message: `Lỗi AI: ${(err as Error).message}` } };
      return;
    }

    yield {
      event: 'proposal',
      data: {
        thinking: ['Đọc và trả lời câu hỏi về Workbook'],
        message: reply,
        actions: [],
        sources: [],
        preview: { counts: [], costBefore: 0, costAfter: 0, costDelta: 0, diffs: [] },
        validation: { status: 'reasonable', score: 100, findings: [], consistency: [] },
        trace: [],
      },
    };
  }

  private extractSearchKeyword(message: string): string {
    const quoted = message.match(/["']([^"']+)["']/);
    if (quoted) return quoted[1];
    const afterFind = message.match(/(?:tìm kiếm|tìm)\s+(.+?)(?:\s+ở|\s+trong|\s+tại|$)/i);
    if (afterFind) return afterFind[1].trim();
    const words = message.trim().split(/\s+/);
    return words.slice(-2).join(' ');
  }

  private buildPrompt(context: WorkbookContext, message: string, searchContext: string): string {
    return [
      'Bạn là QS Workspace Agent — trợ lý chuyên nghiệp về dự toán xây dựng Việt Nam.',
      'Nhiệm vụ: Đọc, giải thích và tra cứu thông tin trong Workbook dự toán.',
      'Không sinh BOQ, không tạo dữ liệu mới. Chỉ đọc và trả lời.',
      '',
      'CẤU TRÚC WORKBOOK:',
      context.workbookSummary,
      context.activeSheetSummary ? `\nSHEET ĐANG XEM:\n${context.activeSheetSummary}` : '',
      context.focusedData ? `\nDỮ LIỆU ĐÃ CHỌN:\n${context.focusedData}` : '',
      searchContext ? `\n${searchContext}` : '',
      '',
      'CÂU HỎI:',
      message,
      '',
      'Trả lời trực tiếp bằng tiếng Việt. Nếu có kết quả tìm kiếm ở trên, hãy tổng hợp và giải thích rõ. Chỉ văn bản thường, không JSON.',
    ]
      .filter(Boolean)
      .join('\n');
  }
}
