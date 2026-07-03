import { Injectable, Logger } from '@nestjs/common';
import { AiService, GeminiPart } from '../../ai/ai.service';
import { CatalogService } from '../../catalog/catalog.service';
import { WorkbookContext } from '../context-builder.service';
import { StreamEvent } from '../copilot.types';
import { compute } from '../boq.engine';
import { parseBenchmarkFromText, staticBenchmark } from '../benchmark';
import { Action, Benchmark, Confidence, EstimateState, PriceSource, ValidationReport } from '../estimate.types';
import { applyActions } from '../reducer';
import { inferSourceType } from '../source';
import { buildTrace } from '../trace';
import { previewActions } from '../transparency';
import { validate } from '../validation';
import { CitationEngineService } from '../sources/citation-engine';
import { CONCRETE_NORMS, STEEL_NORMS } from '../knowledge/qs-standards';
import { getChecklistForBuilding } from '../knowledge/work-checklist';

interface EditReply {
  thinking: string[];
  message: string;
  confidence?: Confidence;
  actions: Action[];
}

type ReviewFocus = 'completeness' | 'pricing';
type EditScope = 'price_update' | 'item_add' | 'item_delete' | 'markup' | 'general';

const TRUST_TARGET = 75;
const TRUST_MAX_ROUNDS = 4;

@Injectable()
export class EditModeHandler {
  private readonly logger = new Logger(EditModeHandler.name);

  constructor(
    private readonly ai: AiService,
    private readonly catalog: CatalogService,
    private readonly citation: CitationEngineService,
  ) {}

  async *handle(
    state: EstimateState,
    context: WorkbookContext,
    message: string,
    files: Express.Multer.File[],
    research: { text: string; sources: { title?: string; uri?: string }[] },
    history = '',
  ): AsyncGenerator<StreamEvent> {
    const k = (n: number) => (n > 0 ? Math.round(n).toLocaleString('vi-VN') : '—');
    const catalogCodes = this.catalog
      .all()
      .map((c) => `${c.code} | ${c.name} | ${c.unit} | VL ${k(c.material)} · NC ${k(c.labor)} · Máy ${k(c.machine)}`)
      .join('\n');

    const visualFiles = files.filter((f) => !this.isExcel(f.originalname));
    const excelFiles = files.filter((f) => this.isExcel(f.originalname));
    if (visualFiles.length) yield { event: 'step', data: { text: `Đọc ${visualFiles.length} tệp đính kèm…` } };
    const excelText = await this.excelToText(excelFiles);

    const visualParts: GeminiPart[] = visualFiles.map((f) => ({
      inlineData: { data: f.buffer.toString('base64'), mimeType: this.mime(f.originalname) },
    }));

    const benchmark = parseBenchmarkFromText(research.text, state.projectInfo) ?? staticBenchmark(state.projectInfo);

    yield { event: 'step', data: { text: 'Phân tích yêu cầu chỉnh sửa…' } };

    const streamParts: GeminiPart[] = [
      ...visualParts,
      { text: this.buildPrompt(state, context, message, visualFiles.length, excelText, research.text, catalogCodes, true, history) },
    ];

    let buf = '';
    let fullText = '';
    let jsonStarted = false;
    let jsonBuf = '';
    let streamErr = false;
    let lastStep = '';

    try {
      for await (const chunk of this.ai.stream(streamParts)) {
        if (chunk.thought) {
          yield { event: 'thinking', data: { text: chunk.text } };
          continue;
        }
        const text = chunk.text;
        if (!jsonStarted) {
          const ji = text.search(/JSON:/i);
          const visible = (ji >= 0 ? text.slice(0, ji) : text).replace(/\bSTEP:\s*/gi, '');
          if (visible.trim()) yield { event: 'token', data: { text: visible } };
        }
        buf += text;
        fullText += text;
        let idx: number;
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx);
          buf = buf.slice(idx + 1);
          if (jsonStarted) { jsonBuf += line + '\n'; continue; }
          const m = line.match(/^\s*STEP:\s*(.+)/i);
          if (m) {
            const stepText = m[1].trim();
            if (stepText !== lastStep) {
              lastStep = stepText;
              yield { event: 'step', data: { text: stepText } };
            }
          }
          else if (/^\s*(\*|#)*JSON\s*:/i.test(line)) {
            jsonStarted = true;
            jsonBuf += line.replace(/^\s*(\*|#)*JSON\s*:\s*/i, '') + '\n';
          }
        }
      }
      jsonBuf += buf;
      if (!jsonBuf.trim()) jsonBuf = this.extractOutermostJson(fullText);
    } catch (err) {
      this.logger.warn(`stream failed: ${(err as Error).message}`);
      streamErr = true;
    }

    let reply = this.parse(jsonBuf);
    if (streamErr || reply.actions.length === 0) {
      yield { event: 'step', data: { text: 'Tổng hợp kết quả…' } };
      try {
        const fbParts: GeminiPart[] = [
          ...visualParts,
          { text: this.buildPrompt(state, context, message, visualFiles.length, excelText, research.text, catalogCodes, false, history) },
        ];
        reply = this.parse(await this.ai.generate(fbParts));
      } catch (err) {
        yield { event: 'error', data: { message: `Lỗi AI: ${(err as Error).message}` } };
        return;
      }
    }

    let nextState = applyActions(state, reply.actions).state;
    let validation = validate(nextState, compute(nextState), benchmark);
    let stalls = 0;
    yield { event: 'step', data: { text: `Kiểm tra BOQ & khối lượng — trust ${validation.score}` } };

    for (let round = 1; round <= TRUST_MAX_ROUNDS; round++) {
      const done =
        validation.score >= TRUST_TARGET &&
        !validation.consistency.some((c) => c.severity === 'error') &&
        !validation.findings.some((f) => f.severity === 'error');
      if (done || reply.actions.length === 0) break;

      const focus = this.pickFocus(validation);
      const layer = focus === 'completeness' ? 'thiếu sót & khối lượng' : 'đơn giá & benchmark';
      yield { event: 'step', data: { text: `Kiểm tra ${layer} — vòng ${round}…` } };

      const res = await this.reviewPass(state, reply, validation, benchmark, focus);
      if (res) {
        yield { event: 'step', data: { text: `Cải thiện trust ${validation.score} → ${res.validation.score}` } };
        reply = res.reply;
        nextState = res.state;
        validation = res.validation;
        stalls = 0;
      } else if (++stalls >= 2) {
        yield { event: 'step', data: { text: 'Không thể cải thiện thêm với dữ liệu hiện có' } };
        break;
      }
    }

    if (research.sources.length > 0) {
      reply = { ...reply, actions: this.attachSourceLinks(reply.actions, research.sources) };
    }

    yield { event: 'step', data: { text: 'Đối chiếu benchmark & tổng hợp đề xuất' } };
    const preview = previewActions(state, reply.actions);
    const trace = buildTrace(nextState, compute(nextState));

    const belowGate = validation.score < TRUST_TARGET;
    const draftNote =
      belowGate && reply.actions.length > 0
        ? `⚠ Bản nháp (độ tin cậy ${validation.score}/100). Cần bổ sung dữ liệu để nâng độ tin cậy.\n\n`
        : '';

    yield {
      event: 'proposal',
      data: {
        thinking: reply.thinking,
        message: draftNote + (reply.message || `Đã xử lý ${reply.actions.length} thay đổi.`),
        confidence: reply.confidence,
        actions: reply.actions,
        sources: research.sources,
        preview,
        validation,
        trace,
      },
    };
  }

  private detectEditScope(message: string): EditScope {
    if (/(xóa|delete|loại bỏ|bỏ đi)/i.test(message)) return 'item_delete';
    if (/(markup|chi phí chung|lợi nhuận|vat|dự phòng|thuế)/i.test(message)) return 'markup';
    if (/(giá|đơn giá|cập nhật giá|sửa giá|thay giá)/i.test(message) && !/(thêm|bổ sung)/i.test(message))
      return 'price_update';
    if (/(thêm|bổ sung|thêm mới)/i.test(message)) return 'item_add';
    return 'general';
  }

  private buildPrompt(
    state: EstimateState,
    context: WorkbookContext,
    message: string,
    fileCount: number,
    excelText: string,
    researchText: string,
    catalogCodes: string,
    streaming: boolean,
    history = '',
  ): string {
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

    const docContext = this.citation.buildDocumentContext(
      ['định mức', 'đơn giá', 'nhân công', 'vật liệu'],
      state.projectInfo.location,
    );

    const concreteInfo = CONCRETE_NORMS.map(
      (n) => `${n.grade}: XM ${n.cement}kg + Cát ${n.sand}m³ + Đá ${n.stone}m³ / m³ BT; NC: ${n.laborNorm} công/m³`,
    ).join('\n');

    const steelInfo = STEEL_NORMS.map(
      (n) => `${n.application}: NC ${n.laborNorm} công/T; Dây buộc ${n.wireNorm} kg/T`,
    ).join('\n');

    const checklist = getChecklistForBuilding(state.projectInfo.buildingType);
    const requiredItems = checklist
      .filter((i) => i.required)
      .map((i) => `${i.group} — ${i.name}: cần có [${i.components.join(', ')}]`)
      .join('\n');

    return [
      'Bạn là Minh — QS senior đang chỉnh sửa dự toán theo yêu cầu.',
      'Làm đúng yêu cầu, không thêm không bớt. Nếu thiếu thông tin thực sự cần thiết → hỏi ngắn gọn 1 câu.',
      'Mọi action phải có source trung thực (ai_estimate nếu tự suy luận).',
      '',
      history ? `LỊCH SỬ:\n${history}` : '',
      '',
      'MÔ HÌNH DỮ LIỆU (Resource-based, F1/G8):',
      '- materials: giá vật liệu | labor: giá nhân công | equipment: giá ca máy',
      '- analyses: phân tích đơn giá (components định mức → ref tài nguyên)',
      '- takeoff: bóc tách khối lượng (dài×rộng×cao×count → quantity)',
      '- markups: chi phí chung, lợi nhuận, VAT, dự phòng',
      '',
      'BỘ ACTION HỢP LỆ:',
      '- {"type":"set_project_info","patch":{...}}',
      '- {"type":"set_markups","patch":{overheadPct,profitPct,vatPct,contingencyPct}}',
      '- {"type":"upsert_material","code","name","unit","price","source":{name,date,region,type,url}}',
      '- {"type":"upsert_labor","grade","name","dayRate","source":{...}}',
      '- {"type":"upsert_equipment","code","name","unit","shiftRate","source":{...}}',
      '- {"type":"upsert_analysis","code","name","unit","components":[{kind,ref,norm,unit}]}',
      '- {"type":"upsert_takeoff","group","code","name","unit","length","width","height","count","formula","note","quantity"}',
      '- {"type":"update_cells","sheetId","cell","oldValue","newValue","entityId"}',
      '- {"type":"delete_material|delete_labor|delete_equipment|delete_analysis|delete_takeoff","id"}',
      '',
      'QUY TẮC source.type: "government" (Bộ/Sở XD) | "supplier" (nhà cung cấp) | "market" (khảo sát) | "forum" (diễn đàn) | "ai_estimate" (AI suy luận). Khai báo trung thực.',
      'source.date = ngày/quý phát hành thực (vd "Q2/2026"). source.url = link thật nếu có.',
      '',
      'QUY TẮC CÔNG THỨC EXCEL (BẮT BUỘC):',
      '- update_cells: nếu ô đích cần tính từ ô khác → newValue PHẢI là "=A1+B2" (có dấu =). KHÔNG ĐƯỢC điền số đã tính sẵn.',
      '- Ví dụ đúng: {"type":"update_cells","sheetId":"...","cell":"C5","newValue":"=A5*B5"}',
      '- Ví dụ SAI: {"type":"update_cells","sheetId":"...","cell":"C5","newValue":15000000}  ← nếu C5=A5*B5',
      '- upsert_takeoff: dùng field "formula" (vd "5*3.14*2"), KHÔNG điền quantity là số cứng.',
      '- Giữ nguyên công thức hiện có của ô, chỉ thay giá trị nếu ô đó không phụ thuộc vào ô khác.',
      '',
      context.activeSheetSummary ? `SHEET ĐANG XEM (chỉnh sửa ưu tiên ở đây):\n${context.activeSheetSummary}` : '',
      context.focusedData ? `VÙNG ĐANG CHỌN (${context.selectionLabel ?? ''}) — action phải nhắm vào vùng này trước:\n${context.focusedData}` : '',
      context.drawingSummary ? `BẢN VẼ ĐANG MỞ:\n${context.drawingSummary}` : '',
      `WORKBOOK:\n${context.workbookSummary}`,
      '',
      researchText ? 'DỮ LIỆU WEB (giá/định mức mới nhất):' : '',
      researchText ? researchText.slice(0, 3000) : '',
      '',
      docContext ? `${docContext}` : '',
      '',
      'ĐỊNH MỨC THAM KHẢO (TT12/2021/TT-BXD):',
      `Bê tông đổ tại chỗ:\n${concreteInfo}`,
      `Cốt thép:\n${steelInfo}`,
      '',
      `CHECKLIST CÔNG TÁC BẮT BUỘC (${state.projectInfo.buildingType ?? 'nhà ở dân dụng'}):`,
      requiredItems,
      '',
      'DANH MỤC MÃ HIỆU THAM KHẢO (code | tên | đv | VL · NC · Máy):',
      catalogCodes,
      '',
      'STATE HIỆN TẠI (JSON):',
      JSON.stringify(stateSummary).slice(0, 6000),
      '',
      fileCount > 0 ? `Tệp đính kèm: ${fileCount} tệp — đọc để lấy dữ liệu theo yêu cầu.` : '',
      excelText ? `Dữ liệu Excel:\n${excelText.slice(0, 3000)}` : '',
      '',
      'YÊU CẦU CỦA NGƯỜI DÙNG:',
      message || '(chỉ có tệp đính kèm)',
      '',
      'Đánh giá confidence cho từng phần (0-100) với căn cứ rõ ràng (reasons[], missing[], uncertaintyPct).',
      streaming
        ? [
            'OUTPUT:',
            'Trong khi xử lý, viết từng dòng suy nghĩ ngắn bắt đầu bằng "STEP: " (tiếng Việt, tự nhiên như đang làm thật).',
            'Kết thúc bằng "JSON:" rồi object JSON hợp lệ trên dòng tiếp theo:',
            '{"thinking":string[],"message":string,"confidence":{boq,materials,labor,equipment,overall,reasons,missing,uncertaintyPct},"actions":Action[]}',
            'message: viết như đang báo cáo với đồng nghiệp, tự nhiên, không dùng "Đã thực hiện..." hay "Đề xuất...".',
            'Không markdown. JSON phải hợp lệ.',
          ].join('\n')
        : 'Chỉ trả về JSON: {"thinking":string[],"message":string,"confidence":{...},"actions":Action[]}. Không markdown.',
    ]
      .filter(Boolean)
      .join('\n');
  }

  private async reviewPass(
    base: EstimateState,
    reply: EditReply,
    validation: ValidationReport,
    benchmark: Benchmark | undefined,
    focus: ReviewFocus,
  ): Promise<{ reply: EditReply; state: EstimateState; validation: ValidationReport } | null> {
    try {
      const critique = await this.ai.reviewGemini(this.buildReviewPrompt(base, reply, validation, benchmark, focus));
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

  private buildReviewPrompt(
    state: EstimateState,
    reply: EditReply,
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
        ? 'TẬP TRUNG: hạng mục THIẾU, sai KHỐI LƯỢNG/định mức, mã hiệu sai.'
        : 'TẬP TRUNG: ĐƠN GIÁ có thực tế không, tổng mức so benchmark, nguồn giá.';
    return [
      `QS Workspace Agent — Reviewer${loc}. Kiểm chứng đề xuất bên dưới. TRA WEB nếu cần.`,
      lens,
      '',
      'Engine phát hiện:',
      engineIssues || '(chưa thấy lỗi cứng)',
      '',
      'Đề xuất (actions JSON):',
      JSON.stringify(reply.actions).slice(0, 6000),
      benchmark
        ? `Benchmark: ${Math.round(benchmark.low).toLocaleString('vi-VN')}–${Math.round(benchmark.high).toLocaleString('vi-VN')} đ.`
        : '',
      '',
      'Báo cáo ngắn gọn: lỗi cụ thể + giá đúng + nguồn. Không JSON.',
    ]
      .filter(Boolean)
      .join('\n');
  }

  private buildCritiquePrompt(
    state: EstimateState,
    reply: EditReply,
    validation: ValidationReport,
    benchmark: Benchmark | undefined,
    focus: ReviewFocus,
    critique: string,
  ): string {
    const relevant =
      focus === 'completeness'
        ? validation.findings.filter((f) => f.area === 'missing' || f.area === 'quantity')
        : validation.findings.filter(
            (f) => f.area === 'unitPrice' || f.area === 'benchmark' || f.area === 'source' || f.area === 'total',
          );
    const issues = [
      ...validation.consistency.map((c) => `- [${c.severity}] ${c.message}`),
      ...(relevant.length ? relevant : validation.findings).map((f) => `- [${f.severity}] ${f.title}: ${f.detail}`),
    ].join('\n');
    const persona =
      focus === 'completeness'
        ? 'QS Workspace Agent — soát THIẾU SÓT hạng mục, sai KHỐI LƯỢNG, mã hiệu sai.'
        : 'QS Workspace Agent — soát ĐƠN GIÁ và TỔNG MỨC so benchmark.';
    return [
      `${persona} Phản biện và sửa lại đề xuất.`,
      critique ? `Reviewer chỉ ra:\n${critique.slice(0, 3000)}\n` : '',
      'Validation Engine:',
      issues || '(không có lỗi cứng)',
      benchmark
        ? `Benchmark: ${Math.round(benchmark.low).toLocaleString('vi-VN')}–${Math.round(benchmark.high).toLocaleString('vi-VN')} đ${benchmark.basis ? ` (${benchmark.basis})` : ''}.`
        : '',
      '',
      'Đề xuất hiện tại:',
      JSON.stringify(reply.actions).slice(0, 8000),
      '',
      'State nền:',
      JSON.stringify({
        materials: state.materials.map((m) => ({ code: m.code, price: m.price })),
        labor: state.labor.map((l) => ({ grade: l.grade, dayRate: l.dayRate })),
        equipment: state.equipment.map((e) => ({ code: e.code, shiftRate: e.shiftRate })),
      }).slice(0, 2000),
      '',
      'Trả về JSON đã sửa (KHÔNG markdown): {"thinking":string[],"message":string,"confidence":{...},"actions":Action[]}',
    ]
      .filter(Boolean)
      .join('\n');
  }

  private attachSourceLinks(actions: Action[], sources: { title?: string; uri?: string }[]): Action[] {
    const refs = sources
      .filter((s) => !!s.uri)
      .map((s) => {
        const titleHost = /([a-z0-9-]+\.)+[a-z]{2,}/i.exec(s.title ?? '')?.[0]?.toLowerCase();
        return { host: titleHost ?? this.hostOf(s.uri!), uri: s.uri!, type: inferSourceType({ url: s.uri, name: s.title }) };
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
        const url = linkFor(a.source as PriceSource);
        if (url) return { ...a, source: { ...(a.source as PriceSource), url } } as Action;
      }
      return a;
    });
  }

  private pickFocus(validation: ValidationReport): ReviewFocus {
    const w = (sev: 'error' | 'warn' | 'info') => (sev === 'error' ? 3 : sev === 'warn' ? 1 : 0);
    let completeness = 0;
    let pricing = 0;
    for (const c of validation.consistency) completeness += w(c.severity);
    for (const f of validation.findings) {
      if (f.area === 'missing' || f.area === 'quantity') completeness += w(f.severity);
      else if (f.area === 'unitPrice' || f.area === 'benchmark' || f.area === 'source' || f.area === 'total')
        pricing += w(f.severity);
    }
    return pricing > completeness ? 'pricing' : 'completeness';
  }

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
    return text.slice(start);
  }

  private parse(raw: string): EditReply {
    try {
      const cleaned = raw.replace(/```json/gi, '').replace(/```/g, '').trim();
      const obj = JSON.parse(this.extractOutermostJson(cleaned)) as Partial<EditReply>;
      return {
        thinking: Array.isArray(obj.thinking) ? obj.thinking.filter((t) => typeof t === 'string') : [],
        message: typeof obj.message === 'string' ? obj.message : '',
        confidence: obj.confidence && typeof obj.confidence === 'object' ? (obj.confidence as Confidence) : undefined,
        actions: Array.isArray(obj.actions) ? (obj.actions as Action[]) : [],
      };
    } catch {
      return { thinking: [], message: 'Xin lỗi, không xử lý được yêu cầu này.', actions: [] };
    }
  }

  private hostOf(url: string): string {
    try { return new URL(url).hostname.replace(/^www\./, '').toLowerCase(); } catch { return ''; }
  }

  private isExcel(fileName: string): boolean { return /\.(xlsx|xls)$/i.test(fileName); }

  private async excelToText(files: Express.Multer.File[]): Promise<string> {
    if (files.length === 0) return '';
    const ExcelJS = await import('exceljs');
    const blocks: string[] = [];
    for (const file of files) {
      try {
        const wb = new ExcelJS.Workbook();
        await wb.xlsx.load(file.buffer as unknown as ArrayBuffer);
        const sb: string[] = [`### ${file.originalname}`];
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
        this.logger.warn(`Excel parse failed: ${(err as Error).message}`);
      }
    }
    return blocks.join('\n\n');
  }

  private cellText(value: unknown): string {
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
      case 'pdf': return 'application/pdf';
      case 'png': return 'image/png';
      case 'webp': return 'image/webp';
      case 'jpg': case 'jpeg': return 'image/jpeg';
      default: return 'application/octet-stream';
    }
  }
}
