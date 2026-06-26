import { Injectable } from '@nestjs/common';
import { AiService } from '../../ai/ai.service';
import { WorkbookContext } from '../context-builder.service';
import { StreamEvent } from '../copilot.types';
import { runReviewTools } from '../tools/tool-registry';
import { Workbook } from '../estimate.types';
import { detectSheetType } from '../rule-detector';
import { auditAgainstChecklist } from '../knowledge/work-checklist';

interface Finding {
  severity: 'error' | 'warn' | 'info';
  area: 'duplicate' | 'price' | 'formula' | 'missing' | 'logic';
  sheetId?: string;
  rowKey?: string;
  code?: string;
  message: string;
  suggestion?: string;
}

@Injectable()
export class ReviewModeHandler {
  constructor(private readonly ai: AiService) {}

  async *handle(workbook: Workbook, context: WorkbookContext, message: string, history = ''): AsyncGenerator<StreamEvent> {
    // If user has selected a specific range, skip full rule engine — just answer about that area
    const hasFocus = !!context.focusedData;

    let findings: Finding[] = [];

    if (!hasFocus) {
      yield { event: 'step', data: { text: 'Kiểm tra lỗi tự động…' } };

      const toolResult = runReviewTools(workbook);
      const { duplicates, outliers, missingPrices, formulaErrors } = toolResult.data;
      const flatDups = duplicates.flat();

      findings = [
        ...flatDups.map((d) => ({
          severity: 'error' as const,
          area: 'duplicate' as const,
          code: d.code,
          message: `Trùng mã hiệu: ${d.code} — ${d.name}`,
          suggestion: 'Xóa dòng trùng hoặc đổi mã hiệu thành duy nhất',
        })),
        ...outliers.map((o) => ({
          severity: 'warn' as const,
          area: 'price' as const,
          code: o.code,
          message: `Giá bất thường: ${o.name} (${o.price.toLocaleString('vi-VN')} đ) — ${o.reason}`,
          suggestion: 'Kiểm tra lại đơn giá so với thông báo giá địa phương',
        })),
        ...missingPrices.map((m) => ({
          severity: 'warn' as const,
          area: 'missing' as const,
          sheetId: m.sheetId,
          code: m.code,
          message: `Thiếu giá: ${m.name} — ${m.reason}`,
          suggestion: 'Cập nhật đơn giá từ thông báo giá hoặc báo giá nhà cung cấp',
        })),
        ...formulaErrors.map((f) => ({
          severity: 'error' as const,
          area: 'formula' as const,
          sheetId: f.sheetId,
          message: `Lỗi công thức tại ${f.cellAddress}: ${f.errorValue}`,
          suggestion: 'Kiểm tra tham chiếu ô hoặc công thức tính toán',
        })),
      ];

      // Checklist audit — extract tên từ BOQ/takeoff sheet
      const takeoffSheet = (workbook.sheets ?? []).find((s) => {
        const { sheetType } = detectSheetType(s);
        return sheetType === 'takeoff' || sheetType === 'boq';
      });
      if (takeoffSheet?.data?.cellData) {
        const names: string[] = [];
        for (const row of Object.values(takeoffSheet.data.cellData) as Record<string, { v?: unknown }>[]) {
          if (!row) continue;
          for (const cell of Object.values(row) as { v?: unknown }[]) {
            const v = String(cell?.v ?? '').trim();
            if (v.length > 5) names.push(v);
          }
        }
        const { missing } = auditAgainstChecklist(names);
        for (const m of missing.slice(0, 10)) {
          findings.push({
            severity: 'warn',
            area: 'logic',
            message: `Có thể thiếu hạng mục: ${m.name} (${m.group})`,
            suggestion: `Bổ sung: ${m.components.join(', ')}`,
          });
        }
      }

      if (findings.length > 0) {
        const errCount = findings.filter((f) => f.severity === 'error').length;
        const warnCount = findings.filter((f) => f.severity === 'warn').length;
        yield { event: 'step', data: { text: `Phát hiện ${errCount} lỗi, ${warnCount} cảnh báo` } };
      } else {
        yield { event: 'step', data: { text: 'Không phát hiện lỗi cứng' } };
      }
    } else {
      yield { event: 'step', data: { text: `Tập trung vào ${context.selectionLabel ?? 'vùng đã chọn'}…` } };
    }

    // Tra cứu giá thị trường nếu có outlier hoặc missing prices
    let webSources: { title?: string; uri?: string }[] = [];
    let webContext = '';
    const needsWebCheck = findings.some((f) => f.area === 'price' || f.area === 'missing');
    if (needsWebCheck) {
      yield { event: 'step', data: { text: 'Tra cứu giá thị trường để dẫn chứng…' } };
      try {
        const q = message || 'Bảng giá vật liệu xây dựng và định mức nhân công mới nhất Việt Nam';
        const result = await this.ai.research(q);
        if (result.text) {
          webContext = result.text.slice(0, 2000);
          webSources = result.sources.slice(0, 5);
        }
      } catch { /* skip if research fails */ }
    }

    yield { event: 'step', data: { text: 'AI soát xét logic nghiệp vụ…' } };

    const prompt = this.buildPrompt(context, message, findings, history, webContext, hasFocus);
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

    const hasErrors = findings.some((f) => f.severity === 'error');
    yield {
      event: 'proposal',
      data: {
        thinking: [`Rule Engine: ${findings.length} phát hiện`, 'AI phân tích logic nghiệp vụ và định mức'],
        message: reply,
        actions: [],
        sources: webSources,
        preview: { counts: [], costBefore: 0, costAfter: 0, costDelta: 0, diffs: [] },
        validation: {
          status: hasErrors ? 'warning' : findings.length > 0 ? 'warning' : 'reasonable',
          score: Math.max(0, 100 - findings.filter((f) => f.severity === 'error').length * 10 - findings.filter((f) => f.severity === 'warn').length * 3),
          findings: [],
          consistency: [],
        },
        trace: [],
        findings: findings.map((f) => ({ severity: f.severity, message: f.message, suggestion: f.suggestion, area: f.area })),
      },
    };
  }

  private buildPrompt(context: WorkbookContext, message: string, findings: Finding[], history: string, webContext: string, hasFocus: boolean): string {
    if (hasFocus) {
      // Focused mode: user selected a cell/range — answer only about that
      return [
        'Bạn là Minh — QS senior. User đang chọn vùng cụ thể trong sheet, hãy trả lời thẳng về vùng đó.',
        'Không nhắc đến workbook hay các sheet khác trừ khi cần thiết để giải thích.',
        webContext ? 'Dẫn nguồn cụ thể (tên văn bản, ngày, link) nếu trích dẫn giá hoặc định mức.' : '',
        'Nói như đồng nghiệp — không dùng header, không viết báo cáo.',
        '',
        history ? `LỊCH SỬ:\n${history}` : '',
        '',
        context.activeSheetSummary ? `SHEET ĐANG XEM:\n${context.activeSheetSummary}` : '',
        `VÙNG ĐANG CHỌN (${context.selectionLabel ?? ''}):\n${context.focusedData}`,
        webContext ? `\nTHÔNG TIN TRA CỨU:\n${webContext}` : '',
        '',
        `"${message}"`,
      ]
        .filter(Boolean)
        .join('\n');
    }

    const byArea = (area: string) => findings.filter((f) => f.area === area);
    const fmt = (list: Finding[]) => list.length === 0 ? 'không có' : list.map((f) => `• ${f.message}${f.suggestion ? ` → ${f.suggestion}` : ''}`).join('\n');
    return [
      'Bạn là Minh — QS senior đang review dự toán. Kết quả kiểm tra tự động bên dưới.',
      'Nói thẳng vấn đề quan trọng nhất. Không liệt kê lại từng lỗi — tổng hợp thành nhận xét thực chất.',
      webContext ? 'Dẫn nguồn cụ thể (tên văn bản, ngày, link) nếu trích dẫn giá hoặc định mức.' : '',
      'Nói như đồng nghiệp — không dùng header, không viết báo cáo hành chính.',
      '',
      history ? `LỊCH SỬ:\n${history}` : '',
      '',
      context.activeSheetSummary ? `SHEET ĐANG XEM (review tập trung vào đây trước):\n${context.activeSheetSummary}` : '',
      `TỔNG QUAN WORKBOOK:\n${context.workbookSummary}`,
      '',
      findings.length > 0 ? 'KẾT QUẢ KIỂM TRA:' : '',
      byArea('duplicate').length ? `Trùng mã:\n${fmt(byArea('duplicate'))}` : '',
      byArea('price').length ? `Giá bất thường:\n${fmt(byArea('price'))}` : '',
      byArea('missing').length ? `Thiếu giá:\n${fmt(byArea('missing'))}` : '',
      byArea('formula').length ? `Lỗi công thức:\n${fmt(byArea('formula'))}` : '',
      byArea('logic').length ? `Thiếu hạng mục:\n${fmt(byArea('logic'))}` : '',
      webContext ? `\nGIÁ THỊ TRƯỜNG / ĐỊNH MỨC:\n${webContext}` : '',
      '',
      message ? `"${message}"` : 'Tóm tắt vấn đề đáng lo nhất.',
    ]
      .filter(Boolean)
      .join('\n');
  }
}
