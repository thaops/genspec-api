import { Injectable } from '@nestjs/common';
import { AiService } from '../../ai/ai.service';
import { WorkbookContext } from '../context-builder.service';
import { StreamEvent } from '../copilot.types';
import { searchWorkbook } from '../tools/tool-registry';
import { Workbook } from '../estimate.types';

const SEARCH_INTENT = /(tìm|tìm kiếm|ở đâu|nằm ở|xuất hiện|có bao nhiêu|đang ở)/i;
const WEB_INTENT = /(thông tư|nghị định|quyết định|quy định|pháp lý|định mức|đơn giá|bảng giá|thị trường|mới nhất|hiện hành|tìm trên mạng|tra cứu|cập nhật|thép|xi măng|bê tông|cát|đá|gạch|sơn|nhôm|kính|giá vật liệu|giá nhân công|cao thế|đắt|rẻ|hợp lý|đúng không|đúng chưa|chính xác|so sánh)/i;

@Injectable()
export class ReadModeHandler {
  constructor(private readonly ai: AiService) {}

  async *handle(workbook: Workbook, context: WorkbookContext, message: string, history = ''): AsyncGenerator<StreamEvent> {
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

    let webContext = '';
    if (WEB_INTENT.test(message)) {
      yield { event: 'step', data: { text: 'Tra cứu thông tin pháp lý / giá thị trường…' } };
      try {
        const result = await this.ai.research(message);
        if (result.text) {
          const sourceList = result.sources.slice(0, 5).map((s) => `- ${s.title ?? s.uri}: ${s.uri}`).join('\n');
          webContext = `THÔNG TIN TRA CỨU TRÊN MẠNG:\n${result.text}${sourceList ? `\n\nNguồn:\n${sourceList}` : ''}`;
        }
      } catch {
        // research failed, continue without web context
      }
    }

    const prompt = this.buildPrompt(context, message, searchContext, webContext, history);
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

  private buildPrompt(context: WorkbookContext, message: string, searchContext: string, webContext: string, history: string): string {
    return [
      'Bạn là Minh — QS senior 10 năm kinh nghiệm, thực chiến dự án dân dụng và công nghiệp tại Việt Nam.',
      'Nói chuyện trực tiếp như đồng nghiệp, không dùng tiêu đề hay bullet point trừ khi liệt kê số liệu.',
      'Không bắt đầu bằng "Theo workbook..." hay "Dựa vào dữ liệu...". Đi thẳng vào câu trả lời.',
      'Nếu không chắc → nói thẳng, hỏi thêm ngắn gọn. Không đoán mò.',
      '',
      history ? `LỊCH SỬ TRÒ CHUYỆN GẦN ĐÂY:\n${history}` : '',
      '',
      context.activeSheetSummary ? `SHEET ĐANG XEM (ưu tiên cao nhất):\n${context.activeSheetSummary}` : '',
      context.focusedData ? `VÙNG ĐANG CHỌN (${context.selectionLabel ?? ''}) — đây là ngữ cảnh trực tiếp, ưu tiên cao nhất:\n${context.focusedData}` : '',
      `TỔNG QUAN WORKBOOK:\n${context.workbookSummary}`,
      searchContext ? `\n${searchContext}` : '',
      webContext ? `\n${webContext}` : '',
      '',
      `"${message}"`,
    ]
      .filter(Boolean)
      .join('\n');
  }
}
