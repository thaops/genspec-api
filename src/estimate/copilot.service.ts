import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import * as ExcelJS from 'exceljs';
import { AiService, GeminiPart } from '../ai/ai.service';
import { CatalogService } from '../catalog/catalog.service';
import { compute } from './boq.engine';
import { parseBenchmarkFromText, staticBenchmark } from './benchmark';
import { EstimateService } from './estimate.service';
import { Action, Benchmark, Confidence, EstimateState, TraceItem, ValidationReport } from './estimate.types';
import { applyActions } from './reducer';
import { inferSourceType } from './source';
import { buildTrace } from './trace';
import { previewActions } from './transparency';
import { validate } from './validation';

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
      };
    }
  | { event: 'error'; data: { message: string } };

type ReviewFocus = 'completeness' | 'pricing';

const PRICE_INTENT = /(giá|đơn giá|vật liệu|vật tư|định mức|dự toán|lập|bóc|khối lượng|báo giá|thị trường|cập nhật)/i;

@Injectable()
export class CopilotService {
  private readonly logger = new Logger(CopilotService.name);

  constructor(
    private readonly ai: AiService,
    private readonly catalog: CatalogService,
    private readonly estimates: EstimateService,
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
  ): AsyncGenerator<StreamEvent> {
    if (!message?.trim() && files.length === 0) {
      yield { event: 'error', data: { message: 'Cần nhập yêu cầu hoặc đính kèm tệp.' } };
      return;
    }
    if (!this.ai.available) {
      yield { event: 'error', data: { message: 'GEMINI_API_KEY chưa cấu hình — copilot không khả dụng.' } };
      return;
    }

    const doc = await this.estimates.getOwned(userId, id);
    const state = this.estimates.stateForPrompt(doc);
    const isEmpty = state.takeoff.length === 0 && state.materials.length === 0;

    yield { event: 'step', data: { text: 'Phân tích yêu cầu dự án' } };

    let research = { text: '', sources: [] as { title?: string; uri?: string }[] };
    if (PRICE_INTENT.test(message) || isEmpty) {
      yield { event: 'step', data: { text: 'Thu thập dữ liệu vật liệu & định mức (web)…' } };
      research = await this.ai.research(this.researchQuery(state, message));
      yield { event: 'step', data: { text: `Đã tham chiếu ${research.sources.length} nguồn giá` } };
      // LAYER 1 — Validate Sources: rank the grounded sources by type before trusting them.
      const ranked = research.sources.map((s) => inferSourceType({ url: s.uri, name: s.title }));
      const official = ranked.filter((t) => t === 'government' || t === 'supplier').length;
      if (research.sources.length > 0) {
        yield { event: 'step', data: { text: `Thẩm định nguồn: ${official}/${research.sources.length} nguồn chính thống (Sở XD / nhà cung cấp)` } };
      }
    }
    // Benchmark suất đầu tư (AI-provided range with static fallback).
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
    let jsonStarted = false;
    let jsonBuf = '';
    let streamErr = false;
    try {
      for await (const chunk of this.ai.stream(streamParts)) {
        // Emit raw reasoning text live (continuous typing), excluding the JSON tail.
        if (!jsonStarted) {
          const ji = chunk.search(/JSON:/i);
          const visible = (ji >= 0 ? chunk.slice(0, ji) : chunk).replace(/\bSTEP:\s*/gi, '');
          if (visible.trim()) yield { event: 'token', data: { text: visible } };
        }
        buf += chunk;
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
          } else if (/^\s*JSON:/i.test(line)) {
            jsonStarted = true;
            jsonBuf += line.replace(/^\s*JSON:\s*/i, '');
          }
        }
      }
      jsonBuf += buf;
    } catch (err) {
      this.logger.warn(`stream failed, falling back: ${(err as Error).message}`);
      streamErr = true;
    }

    let reply = this.parse(jsonBuf);
    if (streamErr || reply.actions.length === 0) {
      // Fallback: non-streaming JSON generate (with retry) so we still produce a proposal.
      yield { event: 'step', data: { text: 'Tổng hợp kết quả…' } };
      try {
        const fbParts: GeminiPart[] = [
          ...visualParts,
          { text: this.buildPrompt(state, message, visualFiles.length, excelText, research.text, false) },
        ];
        reply = this.parse(await this.ai.generate(fbParts));
      } catch (err) {
        yield { event: 'error', data: { message: `Lỗi AI: ${(err as Error).message}` } };
        return;
      }
    }

    // LAYER 2 — Validate BOQ: dry-run the estimator's actions and score the state.
    let nextState = applyActions(state, reply.actions).state;
    let validation = validate(nextState, compute(nextState), benchmark);
    yield { event: 'step', data: { text: `Kiểm tra BOQ & khối lượng — trust ${validation.score}` } };

    // STAGED MULTI-AGENT PIPELINE: each stage is a focused reviewer pass, and the
    // Validation Engine re-scores BETWEEN stages (Estimator → Validate → Reviewer →
    // Validate → Cost Manager → Validate). A stage's fix is adopted only if trust rises.
    const stages: { focus: ReviewFocus; label: string; layer: string }[] = [
      { focus: 'completeness', label: 'Reviewer Agent', layer: 'thiếu sót & khối lượng' },
      { focus: 'pricing', label: 'Cost Manager Agent', layer: 'đơn giá & benchmark' },
    ];
    for (const stage of stages) {
      const optimal =
        validation.score >= 90 && validation.findings.length === 0 && validation.consistency.length === 0;
      if (optimal || reply.actions.length === 0) break;
      yield { event: 'step', data: { text: `${stage.label}: rà soát ${stage.layer}` } };
      const res = await this.reviewPass(state, reply, validation, benchmark, stage.focus);
      if (res) {
        yield { event: 'step', data: { text: `${stage.label}: đã hiệu chỉnh (trust ${validation.score} → ${res.validation.score})` } };
        reply = res.reply;
        nextState = res.state;
        validation = res.validation;
      } else {
        yield { event: 'step', data: { text: `${stage.label}: không cần sửa thêm` } };
      }
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

    yield {
      event: 'proposal',
      data: {
        thinking: reply.thinking,
        message: reply.message || 'Đã chuẩn bị đề xuất.',
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
   * One focused reviewer stage: a distinct persona re-audits the current proposal
   * (using the engine's findings), and the result is re-validated. Returns the
   * improved triple only when trust score strictly increases, else null.
   */
  private async reviewPass(
    base: EstimateState,
    reply: CopilotReply,
    validation: ValidationReport,
    benchmark: Benchmark | undefined,
    focus: ReviewFocus,
  ): Promise<{ reply: CopilotReply; state: EstimateState; validation: ValidationReport } | null> {
    try {
      const critiqued = this.parse(
        await this.ai.generate([{ text: this.buildCritiquePrompt(base, reply, validation, benchmark, focus) }]),
      );
      if (critiqued.actions.length === 0) return null;
      const fixedState = applyActions(base, critiqued.actions).state;
      const fixedValidation = validate(fixedState, compute(fixedState), benchmark);
      if (fixedValidation.score <= validation.score) return null;
      return {
        reply: { ...critiqued, thinking: [...reply.thinking, ...critiqued.thinking].slice(0, 8) },
        state: fixedState,
        validation: fixedValidation,
      };
    } catch (err) {
      this.logger.warn(`review pass (${focus}) skipped: ${(err as Error).message}`);
      return null;
    }
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
    const catalogCodes = this.catalog
      .all()
      .map((c) => `${c.code} | ${c.name} | ${c.unit}`)
      .join('\n');

    const stateSummary = {
      projectInfo: state.projectInfo,
      markups: state.markups,
      materials: state.materials.map((m) => ({ id: m.id, code: m.code, name: m.name, unit: m.unit, price: m.price })),
      labor: state.labor.map((l) => ({ id: l.id, grade: l.grade, name: l.name, dayRate: l.dayRate })),
      equipment: state.equipment.map((e) => ({ id: e.id, code: e.code, name: e.name, shiftRate: e.shiftRate })),
      analyses: state.analyses.map((a) => ({ id: a.id, code: a.code, name: a.name, unit: a.unit, components: a.components })),
      takeoff: state.takeoff.map((t) => ({ id: t.id, group: t.group, code: t.code, name: t.name, unit: t.unit, quantity: t.quantity })),
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
      '- {"type":"delete_material|delete_labor|delete_equipment|delete_analysis|delete_takeoff","id"}',
      '- {"type":"clear"}',
      '',
      'QUY TRÌNH tạo dự toán đầy đủ: (1) set_project_info (kèm normVersion, priceVersion), (2) upsert đủ materials/labor/equipment với GIÁ THỰC TẾ, (3) upsert_analysis cho từng mã công tác (components định mức trỏ ref tới tài nguyên), (4) upsert_takeoff các công tác, (5) set_markups.',
      'BÓC TÁCH DỄ ĐỌC (rất quan trọng): ƯU TIÊN tách mỗi cấu kiện thành MỘT dòng takeoff đơn giản, có "note" diễn giải rõ (vd "Sàn tầng 2", "Dầm biên trục A", "Cột C1 ×4"). Điền dài/rộng/cao/count để truy vết. KHÔNG gộp thành một công thức khổng lồ khó hiểu; công thức nên ngắn (vd "5×20×0.12"). Mỗi dòng phải TỰ HIỂU ĐƯỢC sau vài tháng.',
      'Mã hiệu công tác nên theo chuẩn (tham khảo danh mục dưới). Định mức (norm) lấy theo định mức hiện hành; giá lấy theo dữ liệu web bên dưới nếu có. MỌI giá VL/NC/Máy PHẢI có "source" truy vết — không để giá "magic number".',
      'source.date = NGÀY/QUÝ phát hành THỰC của nguồn (vd "Q2/2025", "15/03/2025"); source.url = link dẫn chứng thật nếu có.',
      'source.type BẮT BUỘC là MỘT trong: "government" (thông báo giá Sở/Bộ XD, định mức nhà nước), "supplier" (báo giá nhà cung cấp/đại lý), "market" (khảo sát thị trường/sàn TMĐT), "forum" (diễn đàn), "ai_estimate" (bạn tự suy luận, không nguồn). ĐỪNG tự cho điểm confidence — hệ thống tự chấm độ tin cậy theo type. Hãy KHAI BÁO TRUNG THỰC type: nếu bạn đoán giá thì để "ai_estimate".',
      'Khi người dùng sửa (vd "đổi sang móng cọc"): chỉ phát các action thay đổi phần liên quan (delete_takeoff/ upsert_analysis/ upsert_takeoff mới), giữ nguyên phần còn lại.',
      '',
      research ? 'DỮ LIỆU WEB (giá/định mức mới — hãy dùng để điền giá vật liệu & ghi source, đặt priceVersion phù hợp):' : '',
      research ? research.slice(0, 4000) : '',
      '',
      'Danh mục mã hiệu công tác tham khảo (code | tên | đơn vị):',
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

  private parse(raw: string): CopilotReply {
    try {
      const cleaned = raw.replace(/```json/gi, '').replace(/```/g, '').trim();
      const start = cleaned.indexOf('{');
      const end = cleaned.lastIndexOf('}');
      const obj = JSON.parse(cleaned.slice(start, end + 1)) as Partial<CopilotReply>;
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
