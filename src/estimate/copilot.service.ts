import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import * as ExcelJS from 'exceljs';
import { AiService, GeminiPart } from '../ai/ai.service';
import { CatalogService } from '../catalog/catalog.service';
import { compute } from './boq.engine';
import { parseBenchmarkFromText, staticBenchmark } from './benchmark';
import { EstimateService } from './estimate.service';
import { Action, Benchmark, Confidence, EstimateState, PriceSource, TraceItem, ValidationReport } from './estimate.types';
import { applyActions } from './reducer';
import { inferSourceType } from './source';
import { buildTrace } from './trace';
import { previewActions } from './transparency';
import { validate } from './validation';
import { ContextBuilderService } from './context-builder.service';
import { getMaterialsFromWorkbook, findDuplicateRowsInSheet, detectOutlierPrices } from './workbook.tools';

interface CopilotReply {
  thinking: string[];
  message: string;
  confidence?: Confidence;
  actions: Action[];
}

export type StreamEvent =
  | { event: 'token'; data: { text: string } }
  | { event: 'step'; data: { text: string } }
  | {
      event: 'proposal';
      data: {
        thinking: string[];
        message: string;
        confidence?: Confidence;
        actions: Action[];
        sources: { title?: string; uri?: string }[];
        preview: ReturnType<typeof previewActions>;
        validation: ValidationReport;
        trace: TraceItem[];
        findings?: any[];
      };
    }
  | { event: 'error'; data: { message: string } };

type ReviewFocus = 'completeness' | 'pricing';

const PRICE_INTENT = /(giá|đơn giá|vật liệu|vật tư|định mức|dự toán|lập|bóc|khối lượng|báo giá|thị trường|cập nhật)/i;

const TRUST_TARGET = 75;
const TRUST_MAX_ROUNDS = 4;

@Injectable()
export class CopilotService {
  private readonly logger = new Logger(CopilotService.name);

  constructor(
    private readonly ai: AiService,
    private readonly catalog: CatalogService,
    private readonly estimates: EstimateService,
    private readonly contextBuilder: ContextBuilderService,
  ) {}

  /**
   * Stream the copilot: emits live `step` events while the model reasons, then a
   * single `proposal` event with actions + dry-run preview (NOT applied — the FE
   * applies via POST /actions on user confirm).
   */
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
    const state = this.estimates.stateForPrompt(doc);

    const compressed = this.contextBuilder.buildContext(doc as any, activeSheetId, selectedRange);

    const EDIT_INTENT = /(cập nhật|sửa|thay đổi|thêm|xóa|đổi|tăng|giảm|set|update|delete|insert)/i;
    const isEditMode = EDIT_INTENT.test(message);

    if (!isEditMode) {
      yield { event: 'step', data: { text: 'Phân tích tài liệu (Read Mode)...' } };
      const readPrompt = [
        'Bạn là trợ lý AI chuyên về dự toán xây dựng (QS AI Agent).',
        'Nhiệm vụ của bạn là đọc hiểu cấu trúc Workbook dự toán và trả lời các thắc mắc của người dùng một cách chính xác, ngắn gọn.',
        '',
        'CẤU TRÚC WORKBOOK HIỆN TẠI (Index):',
        compressed.workbookSummary,
        compressed.activeSheetSummary ? `\nSHEET HIỆN HÀNH:\n${compressed.activeSheetSummary}` : '',
        compressed.focusedData ? `\nDỮ LIỆU ĐANG ĐƯỢC CHỌN/LÂN CẬN (JSON):\n${compressed.focusedData}` : '',
        '',
        'Yêu cầu của người dùng:',
        message,
        '',
        'Hãy trả lời trực tiếp câu hỏi của người dùng bằng tiếng Việt, giải thích rõ ràng số liệu nếu có trong dữ liệu trên. Chỉ trả về văn bản thông thường, không trả về JSON hay code.',
      ].filter(Boolean).join('\n');

      let replyText = '';
      try {
        for await (const chunk of this.ai.stream([{ text: readPrompt }])) {
          replyText += chunk;
          yield { event: 'token', data: { text: chunk } };
        }
      } catch (err) {
        yield { event: 'error', data: { message: `Lỗi AI: ${(err as Error).message}` } };
        return;
      }

      yield {
        event: 'proposal',
        data: {
          thinking: ['Giải đáp câu hỏi của người dùng'],
          message: replyText,
          actions: [],
          sources: [],
          preview: previewActions(state, []),
          validation: validate(state, compute(state), undefined),
          trace: buildTrace(state, compute(state)),
        },
      };
      return;
    }

    const REVIEW_INTENT = /(kiểm tra|soát lỗi|tìm lỗi|audit|review|quét lỗi|outlier|bất thường|trùng)/i;
    const isReviewMode = REVIEW_INTENT.test(message);

    if (isReviewMode) {
      yield { event: 'step', data: { text: 'Chạy bộ quét lỗi tự động (Rule Audit)...' } };

      const findings: any[] = [];
      const sheetsList = doc.sheets ?? [];

      sheetsList.forEach((s) => {
        const dups = findDuplicateRowsInSheet(s);
        dups.forEach((d) => {
          findings.push({
            sheetId: s.id,
            row: Number(d.rowKey),
            severity: 'error',
            message: `Mã hiệu trùng lặp: ${d.code} (${d.name})`,
          });
        });
      });

      const materials = getMaterialsFromWorkbook(doc as any);
      const outliers = detectOutlierPrices(materials);
      outliers.forEach((o) => {
        const map = doc.entityMaps?.find((m) => m.entityId === o.materialId);
        if (map) {
          const sheet = sheetsList.find((s) => s.id === map.sheetId);
          if (sheet && sheet.data?.cellData) {
            const rows = Object.keys(sheet.data.cellData);
            for (const rKey of rows) {
              const row = sheet.data.cellData[rKey];
              const cellVal = String(row ? Object.values(row).map((c: any) => c?.v).join(' ') : '');
              if (cellVal.includes(o.code)) {
                findings.push({
                  sheetId: map.sheetId,
                  row: Number(rKey),
                  severity: 'warn',
                  message: `Giá bất thường: ${o.name} (${o.price.toLocaleString()} VND) - ${o.reason}`,
                });
                break;
              }
            }
          }
        }
      });

      yield { event: 'step', data: { text: `Phát hiện ${findings.length} điểm nghi vấn bằng Rule Engine` } };
      yield { event: 'step', data: { text: 'AI đang soát xét lỗi logic nghiệp vụ chuyên sâu...' } };

      const reviewPrompt = [
        'Bạn là chuyên gia kiểm soát chất lượng dự toán (QS Review Agent).',
        'Nhiệm vụ của bạn là kiểm tra, phát hiện lỗi định mức và đơn giá bất thường của bảng tính dự toán.',
        '',
        'CẤU TRÚC WORKBOOK (Index):',
        compressed.workbookSummary,
        compressed.activeSheetSummary ? `\nSHEET HIỆN HÀNH:\n${compressed.activeSheetSummary}` : '',
        compressed.focusedData ? `\nDỮ LIỆU ĐANG ĐƯỢC CHỌN (JSON):\n${compressed.focusedData}` : '',
        '',
        'KẾT QUẢ QUÉT LỖI TỰ ĐỘNG BẰNG RULE ENGINE (Các lỗi cứng đã phát hiện):',
        JSON.stringify(findings),
        '',
        'Yêu cầu của người dùng:',
        message,
        '',
        'Hãy viết một báo cáo soát lỗi dự toán ngắn gọn bằng tiếng Việt. Chỉ ra các lỗi cứng đã phát hiện được ở trên và giải thích vì sao đó là lỗi. Đồng thời phân tích thêm xem có vấn đề gì khác trong các định mức bê tông, thép hay vật liệu khác không (ví dụ: thiếu cát đá xi măng cho bê tông, hao phí thép bất thường...).',
        'Chỉ trả về văn bản báo cáo thông thường, không trả về mã JSON.',
      ].filter(Boolean).join('\n');

      let replyText = '';
      try {
        for await (const chunk of this.ai.stream([{ text: reviewPrompt }])) {
          replyText += chunk;
          yield { event: 'token', data: { text: chunk } };
        }
      } catch (err) {
        yield { event: 'error', data: { message: `Lỗi AI: ${(err as Error).message}` } };
        return;
      }

      yield {
        event: 'proposal',
        data: {
          thinking: ['Hoàn thành báo cáo soát lỗi dự toán'],
          message: replyText,
          actions: [],
          sources: [],
          preview: previewActions(state, []),
          validation: validate(state, compute(state), undefined),
          trace: buildTrace(state, compute(state)),
          findings,
        },
      };
      return;
    }

    const isEmpty = state.takeoff.length === 0 && state.materials.length === 0;

    yield { event: 'step', data: { text: 'Phân tích yêu cầu dự án' } };

    let research = { text: '', sources: [] as { title?: string; uri?: string }[] };
    if (PRICE_INTENT.test(message) || isEmpty) {
      yield { event: 'step', data: { text: 'Thu thập dữ liệu vật liệu & định mức (web)…' } };
      research = await this.ai.research(this.researchQuery(state, message));
      yield { event: 'step', data: { text: `Đã tham chiếu ${research.sources.length} nguồn giá` } };
      const ranked = research.sources.map((s) => inferSourceType({ url: s.uri, name: s.title }));
      const official = ranked.filter((t) => t === 'government' || t === 'supplier').length;
      if (research.sources.length > 0) {
        yield { event: 'step', data: { text: `Thẩm định nguồn: ${official}/${research.sources.length} nguồn chính thống (Sở XD / nhà cung cấp)` } };
      }
    }
    const benchmark = parseBenchmarkFromText(research.text, state.projectInfo) ?? staticBenchmark(state.projectInfo);

    const visualFiles = files.filter((f) => !this.isExcel(f.originalname));
    const excelFiles = files.filter((f) => this.isExcel(f.originalname));
    if (visualFiles.length) yield { event: 'step', data: { text: `Đọc ${visualFiles.length} bản vẽ/ảnh đính kèm…` } };
    const excelText = await this.excelToText(excelFiles);

    const visualParts: GeminiPart[] = visualFiles.map((f) => ({
      inlineData: { data: f.buffer.toString('base64'), mimeType: this.mime(f.originalname) },
    }));
    const streamParts: GeminiPart[] = [
      ...visualParts,
      { text: this.buildPrompt(state, message, visualFiles.length, excelText, research.text, true) },
    ];

    yield { event: 'step', data: { text: 'Phân tích công trình & lập dự toán…' } };

    // Read the STEP+JSON stream; emit STEP lines live, accumulate the JSON tail.
    let buf = '';
    let fullText = ''; // full accumulated stream text for fallback extraction
    let jsonStarted = false;
    let jsonBuf = '';
    let streamErr = false;
    try {
      for await (const chunk of this.ai.stream(streamParts)) {
        if (!jsonStarted) {
          const ji = chunk.search(/JSON:/i);
          const cutIdx = ji >= 0 ? ji : -1;
          const visible = (cutIdx >= 0 ? chunk.slice(0, cutIdx) : chunk).replace(/\bSTEP:\s*/gi, '');
          if (visible.trim()) yield { event: 'token', data: { text: visible } };
        }
        buf += chunk;
        fullText += chunk;
        let idx: number;
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx);
          buf = buf.slice(idx + 1);
          if (jsonStarted) {
            jsonBuf += line + '\n';
            continue;
          }
          const m = line.match(/^\s*STEP:\s*(.+)/i);
          if (m) {
            yield { event: 'step', data: { text: m[1].trim() } };
          } else if (/^\s*(\*|#)*JSON\s*:/i.test(line)) {
            // Only trigger on explicit "JSON:" marker, never on bare "{".
            // Bare "{" in STEP text or Gemini thinking would cause premature JSON collection.
            jsonStarted = true;
            jsonBuf += line.replace(/^\s*(\*|#)*JSON\s*:\s*/i, '') + '\n';
          }
        }
      }
      jsonBuf += buf;
      // Fallback: model skipped "JSON:" and emitted bare JSON — scan the full text with
      // bracket counting to find the outermost JSON object reliably.
      if (!jsonBuf.trim()) {
        jsonBuf = this.extractOutermostJson(fullText);
      }
    } catch (err) {
      this.logger.warn(`stream failed, falling back: ${(err as Error).message}`);
      streamErr = true;
    }

    let reply = this.parse(jsonBuf);
    this.logger.log(`Stream parse: ${reply.actions.length} actions, jsonBuf len=${jsonBuf.length}`);
    if (streamErr || reply.actions.length === 0) {
      // Fallback: non-streaming JSON generate (with retry) so we still produce a proposal.
      yield { event: 'step', data: { text: 'Tổng hợp kết quả…' } };
      try {
        const fbParts: GeminiPart[] = [
          ...visualParts,
          { text: this.buildPrompt(state, message, visualFiles.length, excelText, research.text, false) },
        ];
        const raw = await this.ai.generate(fbParts);
        reply = this.parse(raw);
        this.logger.log(`Fallback parse: ${reply.actions.length} actions`);
      } catch (err) {
        yield { event: 'error', data: { message: `Lỗi AI: ${(err as Error).message}` } };
        return;
      }
    }

    // LAYER 2 — Validate BOQ: dry-run the estimator's actions and score the state.
    let nextState = applyActions(state, reply.actions).state;
    let validation = validate(nextState, compute(nextState), benchmark);
    let stalls = 0;
    yield { event: 'step', data: { text: `Kiểm tra BOQ & khối lượng — trust ${validation.score}` } };

    // ITERATIVE TRUST LOOP: keep running focused reviewer passes (Validation Engine
    // re-scores between each) until trust reaches TRUST_TARGET, or we hit the round cap,
    // or two consecutive passes fail to improve (stall). Each round targets whatever the
    // engine is failing on most (completeness vs pricing). A pass is adopted only if
    // trust strictly rises — so the score is monotonic and never regresses.
    for (let round = 1; round <= TRUST_MAX_ROUNDS; round++) {
      const done =
        validation.score >= TRUST_TARGET &&
        !validation.consistency.some((c) => c.severity === 'error') &&
        !validation.findings.some((f) => f.severity === 'error');
      if (done || reply.actions.length === 0) break;

      const focus = this.pickFocus(validation);
      const layer = focus === 'completeness' ? 'thiếu sót & khối lượng' : 'đơn giá & benchmark';
      yield { event: 'step', data: { text: `Gemini soi (tra web) ${layer} — vòng ${round}…` } };

      const res = await this.reviewPass(state, reply, validation, benchmark, focus);
      if (res) {
        yield { event: 'step', data: { text: `Qwen sửa theo review — trust ${validation.score} → ${res.validation.score}` } };
        reply = res.reply;
        nextState = res.state;
        validation = res.validation;
        stalls = 0;
      } else if (++stalls >= 2) {
        yield { event: 'step', data: { text: 'Không thể cải thiện thêm với dữ liệu hiện có' } };
        break;
      } else {
        yield { event: 'step', data: { text: 'Chưa cải thiện, thử hướng khác…' } };
      }
    }

    if (validation.score < TRUST_TARGET) {
      yield {
        event: 'step',
        data: { text: `Độ tin cậy ${validation.score}/${TRUST_TARGET} — bản nháp, cần bổ sung dữ liệu để chốt` },
      };
    }

    // Attach grounded source links to priced actions (so the per-price popover and the
    // saved DB record carry a real reference, not "chưa có link").
    if (research.sources.length > 0) {
      reply = { ...reply, actions: this.attachSourceLinks(reply.actions, research.sources) };
    }

    // LAYER 3 — Validate Cost + build the audit trail.
    yield { event: 'step', data: { text: 'Đối chiếu tổng mức với benchmark & kiểm tra đồng bộ' } };
    const preview = previewActions(state, reply.actions);
    const trace = buildTrace(nextState, compute(nextState));

    const verdict =
      validation.status === 'reasonable'
        ? 'Kết quả hợp lý'
        : validation.status === 'warning'
          ? `Có ${validation.findings.length + validation.consistency.length} điểm cần lưu ý`
          : 'Phát hiện số liệu có thể không thực tế';
    yield { event: 'step', data: { text: `Hoàn thành báo cáo — ${verdict}` } };

    // Below the trust gate → flag the proposal as a draft so the user doesn't treat
    // a 0–60% estimate as final. The engine already lists exactly what's weak.
    const belowGate = validation.score < TRUST_TARGET;
    const draftNote =
      belowGate && reply.actions.length > 0
        ? `⚠ Bản nháp (độ tin cậy ${validation.score}/100). Đã tối ưu tối đa với dữ liệu hiện có — xem các điểm cần xử lý ở bảng kiểm tra để nâng độ tin cậy.\n\n`
        : '';

    yield {
      event: 'proposal',
      data: {
        thinking: reply.thinking,
        message: draftNote + (reply.message || 'Đã chuẩn bị đề xuất.'),
        confidence: reply.confidence,
        actions: reply.actions,
        sources: research.sources,
        preview,
        validation,
        trace,
      },
    };
  }

  /**
   * One focused reviewer stage — TWO models, distinct roles:
   *  1) GEMINI reviews (web-grounded): reads Qwen's proposal + the engine's findings,
   *     reaches the web to verify prices/định mức, and reports what's wrong or made-up.
   *  2) QWEN fixes: regenerates a corrected, complete action set using Gemini's critique.
   * Re-validated after; the fix is adopted only when the trust score strictly increases.
   */
  private async reviewPass(
    base: EstimateState,
    reply: CopilotReply,
    validation: ValidationReport,
    benchmark: Benchmark | undefined,
    focus: ReviewFocus,
  ): Promise<{ reply: CopilotReply; state: EstimateState; validation: ValidationReport } | null> {
    try {
      // 1) Gemini reviewer — web-grounded critique (may be '' if Gemini unavailable).
      const critique = await this.ai.reviewGemini(this.buildReviewPrompt(base, reply, validation, benchmark, focus));

      // 2) Qwen fixes per Gemini's critique + the engine findings.
      const fixed = this.parse(
        await this.ai.generate([{ text: this.buildCritiquePrompt(base, reply, validation, benchmark, focus, critique) }]),
      );
      if (fixed.actions.length === 0) return null;
      const fixedState = applyActions(base, fixed.actions).state;
      const fixedValidation = validate(fixedState, compute(fixedState), benchmark);
      if (fixedValidation.score <= validation.score) return null;
      return {
        reply: { ...fixed, thinking: [...reply.thinking, ...fixed.thinking].slice(0, 8) },
        state: fixedState,
        validation: fixedValidation,
      };
    } catch (err) {
      this.logger.warn(`review pass (${focus}) skipped: ${(err as Error).message}`);
      return null;
    }
  }

  /**
   * Prompt for the GEMINI reviewer. Gemini reaches the web to fact-check Qwen's figures
   * and reports problems as plain findings — it does NOT rewrite the estimate. Kept text
   * (not JSON) so its web grounding works; Qwen consumes this critique to fix.
   */
  private buildReviewPrompt(
    state: EstimateState,
    reply: CopilotReply,
    validation: ValidationReport,
    benchmark: Benchmark | undefined,
    focus: ReviewFocus,
  ): string {
    const loc = state.projectInfo.location ? ` tại ${state.projectInfo.location}` : ' tại Việt Nam';
    const engineIssues = [
      ...validation.consistency.map((c) => `- [${c.severity}] ${c.message}`),
      ...validation.findings.map((f) => `- [${f.severity}] ${f.title}: ${f.detail}`),
    ].join('\n');
    const lens =
      focus === 'completeness'
        ? 'TẬP TRUNG: hạng mục THIẾU, sai KHỐI LƯỢNG/định mức, mã hiệu công tác sai.'
        : 'TẬP TRUNG: ĐƠN GIÁ vật liệu/nhân công/ca máy có thực tế không, tổng mức so benchmark, nguồn giá.';
    return [
      `Bạn là QS REVIEWER độc lập. Một AI khác (Qwen) vừa lập dự toán${loc}. Nhiệm vụ của bạn: TRA WEB để kiểm chứng và CHỈ RA chỗ SAI / BỊA / THIẾU — KHÔNG viết lại dự toán.`,
      lens,
      'Hãy DÙNG Google Search kiểm chứng giá vật liệu (xi măng, thép, cát, đá, gạch…) & đơn giá nhân công hiện hành. Với mỗi số liệu Qwen đưa ra mà SAI hoặc bịa, nêu: hạng mục, giá Qwen ghi, GIÁ ĐÚNG theo nguồn (kèm tên nguồn), và mức lệch.',
      '',
      'Bộ phát hiện tự động của hệ thống (engine) đã cảnh báo:',
      engineIssues || '- (engine chưa thấy lỗi cứng — vẫn hãy soi giá & độ đầy đủ)',
      '',
      'DỰ TOÁN QWEN ĐỀ XUẤT (actions JSON):',
      JSON.stringify(reply.actions).slice(0, 7000),
      benchmark ? `\nBenchmark tổng mức hợp lý: ${Math.round(benchmark.low).toLocaleString('vi-VN')}–${Math.round(benchmark.high).toLocaleString('vi-VN')} đ.` : '',
      '',
      'Trả về DANH SÁCH NGẮN GỌN (gạch đầu dòng) các vấn đề + đề xuất sửa cụ thể (giá đúng, hạng mục cần thêm). Không markdown thừa, không JSON.',
    ]
      .filter(Boolean)
      .join('\n');
  }

  /**
   * Backfill `source.url` on priced actions from the grounded research sources, so the
   * per-price popover links to a real reference instead of "chưa có link". The price
   * model only receives research TEXT (not the URLs), so it can't cite links itself —
   * we attach them here: prefer a source whose host appears in the price's source name,
   * else the top grounded source of the SAME type. `ai_estimate` prices are left
   * link-less on purpose (they are the model's own guess, not a cited figure).
   */
  private attachSourceLinks(actions: Action[], researchSources: { title?: string; uri?: string }[]): Action[] {
    const refs = researchSources
      .filter((s) => !!s.uri)
      .map((s) => {
        // Gemini grounding URIs are vertexaisearch redirects; the real host is in `title`.
        const titleHost = /([a-z0-9-]+\.)+[a-z]{2,}/i.exec(s.title ?? '')?.[0]?.toLowerCase();
        return {
          host: titleHost ?? this.hostOf(s.uri!),
          uri: s.uri!,
          type: inferSourceType({ url: s.uri, name: s.title }),
        };
      });
    if (refs.length === 0) return actions;

    const linkFor = (src: PriceSource): string | undefined => {
      if (src.type === 'ai_estimate') return undefined;
      const hay = `${src.name ?? ''} ${src.url ?? ''}`.toLowerCase();
      const byHost = refs.find((r) => r.host && hay.includes(r.host));
      if (byHost) return byHost.uri;
      const sameType = refs.filter((r) => r.type && r.type === src.type);
      return (sameType[0] ?? refs[0]).uri;
    };

    return actions.map((a) => {
      if ('source' in a && a.source && !a.source.url) {
        const url = linkFor(a.source);
        if (url) return { ...a, source: { ...a.source, url } } as Action;
      }
      return a;
    });
  }

  private hostOf(url: string): string {
    try {
      return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
    } catch {
      return '';
    }
  }

  /**
   * Pick the reviewer focus that targets whatever the engine is failing on most.
   * Completeness owns structural/quantity gaps (orphan analyses, missing groups);
   * pricing owns unit-price/benchmark/source problems. Ties → completeness first
   * (a missing item distorts pricing review anyway).
   */
  private pickFocus(validation: ValidationReport): ReviewFocus {
    const w = (sev: 'error' | 'warn' | 'info') => (sev === 'error' ? 3 : sev === 'warn' ? 1 : 0);
    let completeness = 0;
    let pricing = 0;
    for (const c of validation.consistency) completeness += w(c.severity); // orphan/empty/ref/sum
    for (const f of validation.findings) {
      if (f.area === 'missing' || f.area === 'quantity') completeness += w(f.severity);
      else if (f.area === 'unitPrice' || f.area === 'benchmark' || f.area === 'source' || f.area === 'total')
        pricing += w(f.severity);
    }
    return pricing > completeness ? 'pricing' : 'completeness';
  }

  private researchQuery(state: EstimateState, message: string): string {
    const loc = state.projectInfo.location ? ` tại ${state.projectInfo.location}` : ' tại Việt Nam';
    return [
      `Bảng giá / thông báo giá vật liệu xây dựng MỚI NHẤT${loc} (xi măng PCB40, cát vàng, đá 1x2, thép xây dựng/thép hình, gạch, sơn).`,
      'Ưu tiên thông báo giá liên Sở / báo giá nhà cung cấp của QUÝ GẦN NHẤT. Với MỖI mức giá hãy nêu rõ NGÀY hoặc QUÝ phát hành và tên nguồn (URL nếu có).',
      'Đơn giá nhân công và ca máy hiện hành theo địa phương. Tham chiếu định mức xây dựng mới nhất (1776/BXD, 1777/BXD/2021, hoặc bản cập nhật hơn nếu có).',
      `SUẤT ĐẦU TƯ xây dựng tham khảo (triệu đồng/m² sàn) cho loại công trình "${state.projectInfo.buildingType ?? state.projectInfo.name ?? 'nhà ở dân dụng'}"${loc} — nêu rõ KHOẢNG thấp–cao theo dạng "X–Y triệu/m²".`,
      message ? `Bối cảnh yêu cầu: ${message}` : '',
    ]
      .filter(Boolean)
      .join('\n');
  }

  private buildPrompt(state: EstimateState, message: string, fileCount: number, excelText: string, research: string, streaming = false): string {
    // Feed the catalog WITH its reference unit prices (VL/NC/Máy) so the model anchors
    // to real figures instead of inventing them. đg = đơn giá tham khảo / đơn vị.
    const k = (n: number) => (n > 0 ? Math.round(n).toLocaleString('vi-VN') : '—');
    const catalogCodes = this.catalog
      .all()
      .map((c) => `${c.code} | ${c.name} | ${c.unit} | đg VL ${k(c.material)} · NC ${k(c.labor)} · Máy ${k(c.machine)}`)
      .join('\n');

    const stateSummary = {
      projectInfo: state.projectInfo,
      markups: state.markups,
      materials: state.materials.map((m) => ({ id: m.id, code: m.code, name: m.name, unit: m.unit, price: m.price })),
      labor: state.labor.map((l) => ({ id: l.id, grade: l.grade, name: l.name, dayRate: l.dayRate })),
      equipment: state.equipment.map((e) => ({ id: e.id, code: e.code, name: e.name, shiftRate: e.shiftRate })),
      analyses: state.analyses.map((a) => ({ id: a.id, code: a.code, name: a.name, unit: a.unit, components: a.components })),
      takeoff: state.takeoff.map((t) => ({ id: t.id, group: t.group, code: t.code, name: t.name, unit: t.unit, quantity: t.quantity })),
      entityMaps: state.entityMaps,
    };

    return [
      'Bạn là kỹ sư QS lập dự toán xây dựng chuyên nghiệp (theo phong cách phần mềm F1/G8 Việt Nam).',
      'Dự toán theo MÔ HÌNH TÀI NGUYÊN, gồm các lớp dữ liệu liên kết:',
      '- materials (giá vật liệu), labor (giá nhân công theo bậc thợ), equipment (giá ca máy)',
      '- analyses (PHÂN TÍCH ĐƠN GIÁ): mỗi mã hiệu công tác = danh sách components định mức, mỗi component trỏ tới 1 tài nguyên (ref = code vật liệu / bậc thợ / code máy) + hệ số định mức (norm).',
      '- takeoff (BÓC TÁCH KHỐI LƯỢNG): từng dòng có dài/rộng/cao/số lượng + công thức + quantity.',
      '- markups: % chi phí chung, thu nhập chịu thuế tính trước, VAT, dự phòng.',
      'Hệ thống TỰ TÍNH: đơn giá = Σ(norm × giá tài nguyên); BOQ, tổng hợp vật tư, tổng hợp kinh phí (A trực tiếp→B→C→VAT→dự phòng→F) đều tự sinh. ĐỪNG tự tính tổng — chỉ cung cấp dữ liệu nền qua actions.',
      '',
      'Bộ ACTION hợp lệ (áp dụng theo thứ tự; "ref" trong component PHẢI khớp code/grade của tài nguyên đã upsert trước đó trong cùng batch):',
      '- {"type":"set_project_info","patch":{name,location,investor,dateCreated,preparedBy,normVersion,priceVersion,buildingType,floors,area,note}}',
      '- {"type":"set_markups","patch":{overheadPct,profitPct,vatPct,contingencyPct}}',
      '- {"type":"upsert_material","code","name","unit","price","source":{"name","date","region","type","url"}}',
      '- {"type":"upsert_labor","grade","name","dayRate","source":{...}}',
      '- {"type":"upsert_equipment","code","name","unit","shiftRate","source":{...}}',
      '- {"type":"upsert_analysis","code","name","unit","components":[{"kind":"material|labor|equipment","ref","norm","unit"?}]}',
      '- {"type":"upsert_takeoff","group","code","name","unit","length"?,"width"?,"height"?,"count"?,"formula"?,"note"?,"quantity"?}',
      '- {"type":"update_cells","sheetId","cell","oldValue","newValue","entityId"?} (DÙNG ĐỂ cập nhật giá trị ô cụ thể trên bảng tính. cell là địa chỉ ô dạng Excel như D12, E15)',
      '- {"type":"delete_material|delete_labor|delete_equipment|delete_analysis|delete_takeoff","id"}',
      '- {"type":"clear"}',
      '',
      'ĐẶC BIỆT KHI CẬP NHẬT Ô: Khi người dùng yêu cầu thay đổi giá trị (ví dụ: cập nhật giá thép, sửa đơn giá vật tư), bạn PHẢI tìm thực thể đó trong entityMaps để xác định sheetId và index dòng vật lý rowKey (ví dụ: entityId = "mat_sheet1_12" nghĩa là vật liệu đó nằm ở sheet "sheet1", dòng index 12 - tương ứng với dòng 13 của Excel vì Excel 1-indexed. Cột đơn giá là cột D -> ô D13). Chuyển cột cần sửa thành chữ cái (A=Cột 1, B=Cột 2, C=Cột 3, D=Cột 4...) ghép với số dòng Excel để tạo địa chỉ cell và trả về action update_cells.',
      'QUY TRÌNH tạo dự toán đầy đủ: (1) set_project_info (kèm normVersion, priceVersion), (2) upsert đủ materials/labor/equipment với GIÁ THỰC TẾ, (3) upsert_analysis cho từng mã công tác (components định mức trỏ ref tới tài nguyên), (4) upsert_takeoff các công tác, (5) set_markups.',
      'ĐẦY ĐỦ (BẮT BUỘC, đừng bỏ sót): một công trình dân dụng phải phủ các phần — ĐÀO/ĐẮP đất, BÊ TÔNG LÓT, MÓNG (bê tông + cốt thép + ván khuôn), GIẰNG/ĐÀI nếu có, KHUNG THÂN (cột, dầm, sàn — mỗi cái đủ bê tông + cốt thép + ván khuôn), XÂY tường, TRÁT trong/ngoài, MÁI, HOÀN THIỆN (láng/lát/ốp, sơn, trần), CỬA, ĐIỆN, NƯỚC (MEP cơ bản). Mỗi cấu kiện bê tông cốt thép PHẢI có ĐỦ 3 công tác: đổ bê tông + gia công lắp dựng cốt thép + ván khuôn. Thiếu phần nào ghi rõ trong "missing" của confidence.',
      'Mỗi analysis bê tông phải có components đủ: xi măng + cát + đá + nước (vật liệu) + nhân công + máy trộn/đầm. Cốt thép: thép + dây buộc + nhân công + máy cắt/uốn. Đừng để analysis rỗng → đơn giá 0.',
      'BÓC TÁCH DỄ ĐỌC (rất quan trọng): ƯU TIÊN tách mỗi cấu kiện thành MỘT dòng takeoff đơn giản, có "note" diễn giải rõ (vd "Sàn tầng 2", "Dầm biên trục A", "Cột C1 ×4"). Điền dài/rộng/cao/count để truy vết. KHÔNG gộp thành một công thức khổng lồ khó hiểu; công thức nên ngắn (vd "5×20×0.12"). Mỗi dòng phải TỰ HIỂU ĐƯỢC sau vài tháng.',
      'Mã hiệu công tác nên theo chuẩn (tham khảo danh mục dưới). Định mức (norm) lấy theo định mức hiện hành; giá lấy theo dữ liệu web bên dưới nếu có. MỌI giá VL/NC/Máy PHẢI có "source" truy vết — không để giá "magic number".',
      'source.date = NGÀY/QUÝ phát hành THỰC của nguồn (vd "Q2/2025", "15/03/2025"); source.url = link dẫn chứng thật nếu có.',
      'source.type BẮT BUỘC là MỘT trong: "government" (thông báo giá Sở/Bộ XD, định mức nhà nước), "supplier" (báo giá nhà cung cấp/đại lý), "market" (khảo sát thị trường/sàn TMĐT), "forum" (diễn đàn), "ai_estimate" (bạn tự suy luận, không nguồn). ĐỪNG tự cho điểm confidence — hệ thống tự chấm độ tin cậy theo type. Hãy KHAI BÁO TRUNG THỰC type: nếu bạn đoán giá thì để "ai_estimate".',
      'Khi người dùng sửa (vd "đổi sang móng cọc"): chỉ phát các action thay đổi phần liên quan (delete_takeoff/ upsert_analysis/ upsert_takeoff mới), giữ nguyên phần còn lại.',
      '',
      research ? 'DỮ LIỆU WEB (giá/định mức mới — hãy dùng để điền giá vật liệu & ghi source, đặt priceVersion phù hợp):' : '',
      research ? research.slice(0, 4000) : '',
      '',
      'Danh mục mã hiệu công tác + ĐƠN GIÁ THAM KHẢO (code | tên | đv | đg VL · NC · Máy). DÙNG các đơn giá này làm MỐC khi lập analyses/giá tài nguyên — chỉ lệch khi có dữ liệu web mới hơn, đừng chế giá lệch xa mốc:',
      catalogCodes,
      '',
      'STATE hiện tại (JSON):',
      JSON.stringify(stateSummary).slice(0, 8000),
      '',
      fileCount > 0 ? `Người dùng đính kèm ${fileCount} tệp bản vẽ/ảnh — đọc để bóc tách công tác & khối lượng.` : '',
      excelText ? 'Dữ liệu Excel đính kèm:' : '',
      excelText ? excelText.slice(0, 4000) : '',
      'Yêu cầu của người dùng:',
      message || '(chỉ có tệp đính kèm — hãy tự bóc tách)',
      '',
      'Đánh giá "confidence" cho boq, materials, labor, equipment, overall (0-100), KHÁC NHAU giữa các mục (đừng đặt cùng 50). Nếu giá phải suy luận/cũ thì để confidence thấp một cách trung thực.',
      'BẮT BUỘC confidence kèm CĂN CỨ: "reasons" (string[]) = dữ liệu đã đủ làm tăng độ tin (vd "Diện tích sàn đầy đủ", "Số tầng & vị trí rõ"); "missing" (string[]) = dữ liệu còn thiếu khiến giảm độ tin (vd "Bản vẽ kết cấu", "Bản vẽ MEP"); "uncertaintyPct" (number) = sai số ước lượng ± theo % (vd 8). KHÔNG đưa confidence trần không lý do.',
      streaming
        ? [
            'ĐỊNH DẠNG ĐẦU RA (QUAN TRỌNG):',
            'Trước hết, xuất QUÁ TRÌNH LÀM VIỆC realtime: MỖI bước trên MỘT dòng, bắt đầu bằng "STEP: " (tiếng Việt, ngắn). Hãy phản ánh các giai đoạn tính: vd "STEP: Tính khối lượng bê tông", "STEP: Tính khối lượng thép", "STEP: Tính chi phí nhân công", "STEP: Đã tạo 11 công tác", "STEP: Tra giá thép Q2/2025".',
            'Sau khi xong tất cả STEP, xuống dòng mới ghi đúng "JSON:" rồi object JSON trên cùng dòng/khối tiếp theo:',
            '{"thinking": string[], "message": string, "confidence": {boq,materials,labor,equipment,overall,reasons,missing,uncertaintyPct}, "actions": Action[]}',
            'KHÔNG markdown. Phần sau "JSON:" phải là JSON hợp lệ duy nhất.',
          ].join('\n')
        : 'Nêu "thinking" 3–6 bước. CHỈ trả về JSON: {"thinking": string[], "message": string, "confidence": {boq,materials,labor,equipment,overall,reasons,missing,uncertaintyPct}, "actions": Action[]}. Không markdown.',
    ]
      .filter(Boolean)
      .join('\n');
  }

  /**
   * Self-critique prompt: hand the model its OWN proposed actions plus the issues the
   * validation engine flagged, and ask it to REFUTE/FIX them, returning corrected actions
   * in the same JSON schema. Used only when the first pass looks unrealistic/inconsistent.
   */
  private buildCritiquePrompt(
    state: EstimateState,
    reply: CopilotReply,
    validation: ValidationReport,
    benchmark?: { low: number; high: number; basis?: string },
    focus: ReviewFocus = 'completeness',
    geminiReview = '',
  ): string {
    // Each stage emphasises a different class of findings — a genuinely different reviewer.
    const relevant =
      focus === 'completeness'
        ? validation.findings.filter((f) => f.area === 'missing' || f.area === 'quantity')
        : validation.findings.filter((f) => f.area === 'unitPrice' || f.area === 'benchmark' || f.area === 'source' || f.area === 'total');
    const issues = [
      ...validation.consistency.map((c) => `- [${c.severity}] ${c.message}`),
      ...(relevant.length ? relevant : validation.findings).map((f) => `- [${f.severity}] ${f.title}: ${f.detail}`),
    ].join('\n');
    const persona =
      focus === 'completeness'
        ? 'Bạn là QS REVIEWER độc lập (KHÔNG phải người đã lập). Nhiệm vụ: soát THIẾU SÓT hạng mục, sai KHỐI LƯỢNG, sai mã hiệu công tác, định mức bất thường. Bổ sung công tác còn thiếu, sửa khối lượng cho đúng cấu kiện.'
        : 'Bạn là COST MANAGER độc lập (KHÔNG phải người đã lập). Nhiệm vụ: soát ĐƠN GIÁ vật liệu/nhân công/ca máy và TỔNG MỨC so với benchmark thị trường; thay giá từ nguồn cấp thấp bằng nguồn chính thống; đảm bảo mọi giá có source.type hợp lệ.';
    return [
      `${persona} Hãy PHẢN BIỆN gay gắt đề xuất dưới đây rồi SỬA LẠI cho đúng trước khi trả người dùng.`,
      geminiReview
        ? `REVIEWER (Gemini — đã TRA WEB kiểm chứng) chỉ ra các vấn đề sau. BẮT BUỘC sửa theo, dùng đúng GIÁ ĐÚNG mà reviewer nêu (ghi source.type "government"/"supplier" + giá đó):\n${geminiReview.slice(0, 3500)}\n`
        : '',
      'Validation Engine đã phát hiện các vấn đề sau (BẮT BUỘC xử lý từng mục liên quan vai của bạn):',
      issues || '- (không có — chỉ tinh chỉnh nếu cần)',
      benchmark ? `Khoảng benchmark tổng mức hợp lý: ${Math.round(benchmark.low).toLocaleString('vi-VN')} – ${Math.round(benchmark.high).toLocaleString('vi-VN')} đ${benchmark.basis ? ` (${benchmark.basis})` : ''}. Nếu tổng lệch lớn, rà lại khối lượng & đơn giá cho hợp lý, đừng bịa.` : '',
      '',
      'ĐỀ XUẤT HIỆN TẠI (actions JSON):',
      JSON.stringify(reply.actions).slice(0, 9000),
      '',
      'STATE nền (để khớp ref/giá):',
      JSON.stringify({
        materials: state.materials.map((m) => ({ code: m.code, price: m.price })),
        labor: state.labor.map((l) => ({ grade: l.grade, dayRate: l.dayRate })),
        equipment: state.equipment.map((e) => ({ code: e.code, shiftRate: e.shiftRate })),
      }).slice(0, 3000),
      '',
      'Trả về JSON ĐÃ SỬA theo đúng schema (KHÔNG markdown): {"thinking": string[] (ghi rõ đã sửa gì & vì sao), "message": string, "confidence": {boq,materials,labor,equipment,overall,reasons,missing,uncertaintyPct}, "actions": Action[] (BỘ HOÀN CHỈNH đã sửa — không chỉ phần thay đổi)}.',
    ]
      .filter(Boolean)
      .join('\n');
  }

  /** Find the outermost complete JSON object in a string using bracket counting. */
  private extractOutermostJson(text: string): string {
    const start = text.indexOf('{');
    if (start < 0) return '';
    let depth = 0;
    let inStr = false;
    let escape = false;
    for (let i = start; i < text.length; i++) {
      const c = text[i];
      if (escape) { escape = false; continue; }
      if (c === '\\' && inStr) { escape = true; continue; }
      if (c === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (c === '{') depth++;
      else if (c === '}') { depth--; if (depth === 0) return text.slice(start, i + 1); }
    }
    return text.slice(start); // truncated — return what we have
  }

  private parse(raw: string): CopilotReply {
    try {
      const cleaned = raw.replace(/```json/gi, '').replace(/```/g, '').trim();
      // Use bracket-counting to find the outermost JSON object instead of indexOf/lastIndexOf,
      // which can produce invalid JSON when the text contains multiple objects.
      const extracted = this.extractOutermostJson(cleaned);
      const obj = JSON.parse(extracted) as Partial<CopilotReply>;
      return {
        thinking: Array.isArray(obj.thinking) ? obj.thinking.filter((t) => typeof t === 'string') : [],
        message: typeof obj.message === 'string' ? obj.message : '',
        confidence: obj.confidence && typeof obj.confidence === 'object' ? (obj.confidence as Confidence) : undefined,
        actions: Array.isArray(obj.actions) ? (obj.actions as Action[]) : [],
      };
    } catch (err) {
      this.logger.error(`Failed to parse copilot reply: ${(err as Error).message}`);
      return { thinking: [], message: 'Xin lỗi, tôi chưa xử lý được yêu cầu này. Bạn thử mô tả rõ hơn nhé.', actions: [] };
    }
  }

  private isExcel(fileName: string): boolean {
    return /\.(xlsx|xls)$/i.test(fileName);
  }

  private async excelToText(files: Express.Multer.File[]): Promise<string> {
    if (files.length === 0) return '';
    const blocks: string[] = [];
    for (const file of files) {
      try {
        const wb = new ExcelJS.Workbook();
        await wb.xlsx.load(file.buffer as unknown as ArrayBuffer);
        const sb: string[] = [`### File: ${file.originalname}`];
        wb.eachSheet((ws) => {
          const rows: string[] = [];
          ws.eachRow({ includeEmpty: false }, (row, n) => {
            if (n > 41) return;
            const cells: string[] = [];
            row.eachCell({ includeEmpty: true }, (cell) => cells.push(this.cellText(cell.value)));
            rows.push(cells.join(' | '));
          });
          if (rows.length) sb.push(`Sheet "${ws.name}":\n${rows.join('\n')}`);
        });
        blocks.push(sb.join('\n'));
      } catch (err) {
        this.logger.warn(`Failed to parse excel ${file.originalname}: ${(err as Error).message}`);
      }
    }
    return blocks.join('\n\n');
  }

  private cellText(value: ExcelJS.CellValue): string {
    if (value == null) return '';
    if (typeof value === 'object') {
      const v = value as { richText?: { text: string }[]; text?: string; result?: unknown };
      if (Array.isArray(v.richText)) return v.richText.map((r) => r.text).join('');
      if (typeof v.text === 'string') return v.text;
      if (v.result != null) return String(v.result);
      return '';
    }
    return String(value);
  }

  private mime(fileName: string): string {
    const ext = fileName.toLowerCase().split('.').pop();
    switch (ext) {
      case 'pdf':
        return 'application/pdf';
      case 'png':
        return 'image/png';
      case 'webp':
        return 'image/webp';
      case 'jpg':
      case 'jpeg':
        return 'image/jpeg';
      default:
        return 'application/octet-stream';
    }
  }
}
