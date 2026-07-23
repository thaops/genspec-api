import { Injectable } from '@nestjs/common';
import { AiService, AiUsageContext } from '../../ai/ai.service';
import { WorkbookContext } from '../context-builder.service';
import { StreamEvent } from '../copilot.types';
import { searchWorkbook } from '../tools/tool-registry';
import { Workbook } from '../estimate.types';
import { RECENCY_RULE, SENIOR_QS_PRINCIPLES } from './qs-principles';
import { QS_KNOWLEDGE, provinceRule } from '../knowledge/qs-knowledge';
import { guardUnsourcedPriceInProse } from '../price-prose-guard';

const SEARCH_INTENT = /(tìm|tìm kiếm|ở đâu|nằm ở|xuất hiện|có bao nhiêu|đang ở)/i;
const WEB_INTENT = /(thông tư|nghị định|quyết định|quy định|pháp lý|định mức|đơn giá|bảng giá|thị trường|mới nhất|hiện hành|tìm trên mạng|tra cứu|cập nhật|thép|xi măng|bê tông|cát|đá|gạch|sơn|nhôm|kính|giá vật liệu|giá nhân công|cao thế|đắt|rẻ|hợp lý|đúng không|đúng chưa|chính xác|so sánh|tiêu chuẩn|tcvn|nghiệm thu)/i;
const STANDARD_INTENT = /(tiêu chuẩn|tcvn|nghiệm thu|quy chuẩn|qcvn)/i;
const PRICE_ASK_INTENT = /(giá|đơn giá|vật liệu|nhân công|ca máy|thép|xi măng|cát|đá|gạch|sơn)/i;

@Injectable()
export class ReadModeHandler {
  constructor(private readonly ai: AiService) {}

  async *handle(workbook: Workbook, context: WorkbookContext, message: string, history = '', editPermission = false, usageCtx?: AiUsageContext): AsyncGenerator<StreamEvent> {
    yield { event: 'step', data: { text: 'Đọc cấu trúc Workbook…' } };
    const location = (workbook as any)?.projectInfo?.location as string | undefined;

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
    let webSearchFailed = false;
    // Nguồn grounded thật (nếu có) — để (a) chống bịa giá trong prose, (b) trả về proposal.
    let webSources: { title?: string; uri?: string }[] = [];
    if (WEB_INTENT.test(message)) {
      yield { event: 'step', data: { text: 'Tra cứu thông tin pháp lý / giá thị trường…' } };
      try {
        // Bias truy vấn theo LOẠI: tiêu chuẩn → vsqi.gov.vn; giá → ghim tỉnh dự án
        // (ưu tiên công bố giá Sở XD tỉnh đó). Không tra chung chung.
        const hints: string[] = [];
        if (STANDARD_INTENT.test(message)) {
          hints.push('Tra tiêu chuẩn tại tieuchuan.vsqi.gov.vn / tcvn.gov.vn: nêu SỐ HIỆU TCVN + tên + TÌNH TRẠNG hiệu lực; không bịa số hiệu/nội dung điều khoản.');
        }
        if (location?.trim() && PRICE_ASK_INTENT.test(message)) {
          hints.push(`Câu hỏi về giá → tra theo tỉnh ${location}, ưu tiên công bố giá Sở Xây dựng ${location}, số MỚI NHẤT.`);
        }
        const webQuery = hints.length ? `${message}\n(${hints.join(' ')})` : message;
        const result = await this.ai.research(webQuery, usageCtx);
        if (result.text) {
          const sourceList = result.sources.slice(0, 5).map((s) => `- ${s.title ?? s.uri}: ${s.uri}`).join('\n');
          webContext = [
            '=== KẾT QUẢ TRA CỨU THỰC TẾ TRÊN MẠNG (nguồn đáng tin cậy) ===',
            result.text,
            sourceList ? `\nNguồn đã tìm thấy:\n${sourceList}` : '',
            '=== HẾT KẾT QUẢ TRA CỨU ===',
            '',
            'QUY TẮC BẮT BUỘC KHI TRẢ LỜI:',
            '1. Chỉ được trích dẫn văn bản pháp lý (số thông tư, nghị định, quyết định) NẾU chúng xuất hiện trong kết quả tra cứu ở trên.',
            '2. TUYỆT ĐỐI KHÔNG tự bịa hoặc suy đoán số văn bản, ngày ban hành, hay nội dung không có trong kết quả tra cứu.',
            '3. Nếu thấy URL nguồn → trích dẫn cuối câu trả lời dưới dạng "Nguồn: [tên] (url)".',
            '4. Nếu kết quả tra cứu không đủ để trả lời → nói thẳng "Tôi không tìm thấy thông tin xác thực, cậu nên kiểm tra trực tiếp tại cổng thông tin Bộ Xây dựng."',
          ].filter(Boolean).join('\n');
          webSources = result.sources ?? [];
          if (result.sources.length > 0) {
            yield { event: 'step', data: { text: `Tìm thấy ${result.sources.length} nguồn tham khảo` } };
          }
        } else {
          webSearchFailed = true;
        }
      } catch {
        webSearchFailed = true;
      }
    }

    const prompt = this.buildPrompt(context, message, searchContext, webContext, webSearchFailed, history, editPermission, location);
    let reply = '';
    try {
      for await (const chunk of this.ai.stream([{ text: prompt }], { ctx: usageCtx })) {
        if (chunk.thought) {
          yield { event: 'thinking', data: { text: chunk.text } };
          continue;
        }
        reply += chunk.text;
        yield { event: 'token', data: { text: chunk.text } };
      }
    } catch (err) {
      yield { event: 'error', data: { message: `Lỗi AI: ${(err as Error).message}` } };
      return;
    }

    // Model can burn its whole output on thoughts and return no answer text —
    // retry once with thinking disabled so the user never gets an empty bubble.
    if (!reply.trim()) {
      yield { event: 'step', data: { text: 'Đang tổng hợp câu trả lời…' } };
      try {
        for await (const chunk of this.ai.stream([{ text: prompt }], { thinkingBudget: 0, ctx: usageCtx })) {
          if (chunk.thought) continue;
          reply += chunk.text;
          yield { event: 'token', data: { text: chunk.text } };
        }
      } catch (err) {
        yield { event: 'error', data: { message: `Lỗi AI: ${(err as Error).message}` } };
        return;
      }
    }
    if (!reply.trim()) {
      yield { event: 'error', data: { message: 'AI không trả về nội dung — vui lòng gửi lại câu hỏi.' } };
      return;
    }

    // Read mode can never write — stamp any claim of having edited the sheet.
    if (/(đã đẩy|đã cập nhật|đã ghi|đã thêm vào (sheet|bảng)|vừa quét xong và đẩy|xong rồi[\s\S]{0,80}sheet)/i.test(reply)) {
      reply +=
        (editPermission
          ? '\n\n⚠ Lưu ý: chưa có thay đổi nào được ghi vào bảng tính — ra lệnh cụ thể (vd "cập nhật giá thép dòng 5") để AI thực hiện.'
          : '\n\n⚠ Lưu ý: đang ở chế độ ĐỌC — chưa có thay đổi nào được ghi vào bảng tính. Bật công tắc "Edit" trên thanh Agent để AI tạo đề xuất chỉnh sửa.');
    }

    // Chống bịa giá trong VĂN XUÔI: câu trả lời nêu số tiền nhưng KHÔNG có nguồn grounded
    // → dán cảnh báo + hạ điểm. Không để proposal chấm 100 cho giá tự chế (bug thật đã đo).
    const proseGuard = guardUnsourcedPriceInProse(reply, webSources.length);
    if (proseGuard.flagged) {
      yield { event: 'step', data: { text: 'Chống bịa giá: câu trả lời có số tiền nhưng không có nguồn — đã dán cảnh báo, hạ độ tin cậy' } };
    }
    const validation = proseGuard.flagged
      ? {
          status: 'warning' as const,
          score: proseGuard.scoreCap ?? 40,
          findings: [
            {
              id: 'chat-unsourced-price',
              severity: 'warn' as const,
              area: 'unitPrice' as const,
              title: 'Câu trả lời có giá chưa kiểm chứng',
              detail:
                'Câu trả lời nêu số tiền nhưng không tra được nguồn công bố giá/định mức chính thức. ' +
                'Số chỉ mang tính tham khảo — đối chiếu công bố giá Sở Xây dựng tỉnh trước khi dùng.',
            },
          ],
          consistency: [],
        }
      : { status: 'reasonable' as const, score: 100, findings: [], consistency: [] };

    yield {
      event: 'proposal',
      data: {
        thinking: ['Đọc và trả lời câu hỏi về Workbook'],
        message: proseGuard.message,
        actions: [],
        sources: webSources,
        preview: { counts: [], costBefore: 0, costAfter: 0, costDelta: 0, diffs: [] },
        validation,
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

  private buildPrompt(context: WorkbookContext, message: string, searchContext: string, webContext: string, webSearchFailed: boolean, history: string, editPermission = false, location?: string): string {
    const searchFailedNote = webSearchFailed
      ? 'CẢNH BÁO: Tra cứu mạng thất bại. TUYỆT ĐỐI KHÔNG tự bịa thông tin pháp lý. Nếu câu hỏi liên quan đến thông tư/nghị định → nói thẳng không tra cứu được, hướng dẫn người dùng vào moc.gov.vn hoặc vbpl.vn để kiểm tra.'
      : '';

    return [
      SENIOR_QS_PRINCIPLES,
      RECENCY_RULE,
      QS_KNOWLEDGE, // read = đường hỏi-đáp: nạp đủ playbook + nguồn tin cậy + văn bản hiện hành
      provinceRule(location), // ghim tỉnh dự án — tra giá phải đúng tỉnh
      'Nói chuyện trực tiếp như đồng nghiệp, không dùng tiêu đề hay bullet point trừ khi liệt kê số liệu.',
      editPermission
        ? 'Đây là câu hỏi ĐỌC/tra cứu — trả lời trực tiếp. TUYỆT ĐỐI KHÔNG nói "đã đẩy/đã ghi vào sheet" và KHÔNG bảo người dùng bật Edit (quyền chỉnh sửa ĐANG BẬT — muốn sửa gì họ chỉ cần ra lệnh cụ thể).'
        : 'Bạn đang ở CHẾ ĐỘ ĐỌC — KHÔNG có khả năng chỉnh sửa bảng tính. TUYỆT ĐỐI KHÔNG nói "đã đẩy/đã ghi/đã cập nhật vào sheet". Nếu người dùng yêu cầu chỉnh sửa, hướng dẫn họ bật công tắc "Edit".',
      'Không bắt đầu bằng "Theo workbook..." hay "Dựa vào dữ liệu...". Đi thẳng vào câu trả lời.',
      'Nếu không chắc → nói thẳng. KHÔNG ĐƯỢC đoán số hiệu văn bản pháp lý.',
      '',
      searchFailedNote,
      '',
      history ? `LỊCH SỬ TRÒ CHUYỆN GẦN ĐÂY:\n${history}` : '',
      '',
      context.activeSheetSummary ? `SHEET ĐANG XEM (ưu tiên cao nhất):\n${context.activeSheetSummary}` : '',
      context.focusedData ? `VÙNG ĐANG CHỌN (${context.selectionLabel ?? ''}) — đây là ngữ cảnh trực tiếp, ưu tiên cao nhất:\n${context.focusedData}` : '',
      context.drawingSummary ? `BẢN VẼ ĐANG MỞ:\n${context.drawingSummary}` : '',
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
