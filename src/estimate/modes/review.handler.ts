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

  async *handle(workbook: Workbook, context: WorkbookContext, message: string): AsyncGenerator<StreamEvent> {
    yield { event: 'step', data: { text: 'Chạy Rule Engine kiểm tra lỗi tự động…' } };

    const toolResult = runReviewTools(workbook);
    const { duplicates, outliers, missingPrices, formulaErrors } = toolResult.data;
    const flatDups = duplicates.flat();

    const findings: Finding[] = [
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
      yield { event: 'step', data: { text: 'Rule Engine không phát hiện lỗi cứng' } };
    }

    yield { event: 'step', data: { text: 'AI soát xét logic nghiệp vụ chuyên sâu…' } };

    const prompt = this.buildPrompt(context, message, findings);
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
        sources: [],
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

  private buildPrompt(context: WorkbookContext, message: string, findings: Finding[]): string {
    const byArea = (area: string) => findings.filter((f) => f.area === area);
    return [
      'Bạn là QS Workspace Agent — chuyên gia kiểm soát chất lượng dự toán xây dựng Việt Nam.',
      'Nhiệm vụ: Soát lỗi định mức, đơn giá, công thức. Không sửa dữ liệu — chỉ báo cáo.',
      '',
      'CẤU TRÚC WORKBOOK:',
      context.workbookSummary,
      context.activeSheetSummary ? `\nSHEET HIỆN HÀNH:\n${context.activeSheetSummary}` : '',
      context.focusedData ? `\nDỮ LIỆU ĐÃ CHỌN:\n${context.focusedData}` : '',
      '',
      'KẾT QUẢ RULE ENGINE:',
      `Lỗi trùng mã (${byArea('duplicate').length}): ${JSON.stringify(byArea('duplicate'))}`,
      `Giá bất thường (${byArea('price').length}): ${JSON.stringify(byArea('price'))}`,
      `Thiếu giá (${byArea('missing').length}): ${JSON.stringify(byArea('missing'))}`,
      `Lỗi công thức (${byArea('formula').length}): ${JSON.stringify(byArea('formula'))}`,
      `Thiếu hạng mục (${byArea('logic').length}): ${JSON.stringify(byArea('logic'))}`,
      '',
      'YÊU CẦU:',
      message || 'Kiểm tra toàn bộ workbook',
      '',
      'Viết báo cáo soát lỗi bằng tiếng Việt. Phân tích thêm:',
      '1. Các định mức bê tông có đủ VL (xi măng+cát+đá) + NC + Máy không?',
      '2. Cốt thép có đủ thép + dây buộc + NC + máy cắt/uốn không?',
      '3. Các hạng mục nào bị thiếu phân tích đơn giá?',
      '4. Đơn giá nhân công có hợp lý theo định mức địa phương không?',
      'Chỉ văn bản thường, không JSON.',
    ]
      .filter(Boolean)
      .join('\n');
  }
}
