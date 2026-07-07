import * as https from 'node:https';
import * as http from 'node:http';
import * as zlib from 'node:zlib';
import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { AiService } from '../ai/ai.service';
import { DrawingSceneEntity, DrawingSceneDocument } from '../drawing/schemas/drawing-scene.schema';
import { EstimateService } from './estimate.service';
import { ContextBuilderService } from './context-builder.service';
import { ReadModeHandler } from './modes/read.handler';
import { ReviewModeHandler } from './modes/review.handler';
import { EditModeHandler } from './modes/edit.handler';
import { TakeoffEngineService } from './takeoff-engine.service';
import { previewActions } from './transparency';
import { compute } from './boq.engine';

import { StreamEvent } from './copilot.types';
export type { StreamEvent } from './copilot.types';

export interface InsightItem {
  title: string;
  detail: string;
  type: 'cost' | 'risk' | 'saving' | 'data' | 'formula';
  impact?: string;
}

export interface OfficialFeedItem {
  title: string;
  region: string;
  source: string;
  issuedDate: string | null;
  effectiveDate: string | null;
  type: 'price_notification' | 'regulation' | 'circular' | 'decision';
  trustScore: number;
  url: string | null;
  imageUrl?: string | null;
  summary?: string | null;
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
// REVIEW only when user explicitly asks to audit the whole document
const REVIEW_INTENT = /(soat loi|tim loi|quet loi|bat thuong|trung|audit|review|outlier|soát lỗi|tìm lỗi|quét lỗi|bất thường|trùng|kiem tra (toan bo|workbook|du toan|file)|kiểm tra (toàn bộ|workbook|dự toán|file))/i;
// Web/legal intent overrides REVIEW — these are research questions, not document audits
const WEB_LEGAL_INTENT = /(thong tu|nghi dinh|quyet dinh|quy dinh|phap ly|dinh muc|tren mang|cu chua|hien hanh|moi nhat|thông tư|nghị định|quyết định|quy định|pháp lý|định mức|trên mạng|cũ chưa|hiện hành|mới nhất)/i;
const PRICE_INTENT = /(gia|don gia|vat lieu|vat tu|dinh muc|du toan|lap|boc|khoi luong|bao gia|thi truong|giá|đơn giá|vật liệu|vật tư|định mức|dự toán|lập|bóc|khối lượng|báo giá|thị trường|cập nhật)/i;
// "Bóc (tách) khối lượng" tự do trong chat — route thẳng deterministic engine, KHÔNG cho LLM bịa số.
const TAKEOFF_INTENT = /(bóc|boc)\s*(tách|tach)?\s*(khối lượng|khoi luong)|\btakeoff\b/i;
// Prompt cấu trúc ⚡ từ FE — cũng route engine cho an toàn (dù FE đã có đường REST riêng).
const TAKEOFF_ACTION = /\[ACTION:\s*generate[_-]?takeoff/i;
// Câu xác nhận ngắn — với Edit bật là lệnh thực thi, không phải câu hỏi đọc.
const CONFIRM_INTENT = /(lam di|lam luon|ap dung|dong y|chot|duyet|\bok(e)?\b|\byes\b|confirm)/i;

// Quy đổi đơn vị bản vẽ ($INSUNITS) → mét — port từ FE DrawingWorkspace.
const INSUNITS_TO_METERS: Record<string, number> = { mm: 0.001, m: 1, inch: 0.0254 };
// Giả định mặc định khi chat tự do (FE popover chưa gửi kèm).
const DEFAULT_TAKEOFF_ASSUMPTIONS = { floorHeight: 3.3, wallThickness: 0.2, beamDepth: 0.4 };

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
    private readonly takeoffEngine: TakeoffEngineService,
    @InjectModel(DrawingSceneEntity.name) private readonly sceneModel: Model<DrawingSceneDocument>,
  ) {}

  async *streamChat(
    userId: string,
    id: string,
    message: string,
    files: Express.Multer.File[] = [],
    activeSheetId?: string,
    selectedRange?: { startRow: number; startCol: number; endRow: number; endCol: number },
    editPermission = false,
    drawingId?: string,
    objectId?: string,
    drawingContext?: { page?: number; scale?: number; activeTool?: string; layer?: string; objectType?: string },
    calibrationFactor?: number,
    chatSessionId?: string,
  ): AsyncGenerator<StreamEvent> {
    if (!message?.trim() && files.length === 0) {
      yield { event: 'error', data: { message: 'Cần nhập yêu cầu hoặc đính kèm tệp.' } };
      return;
    }
    if (!this.ai.available) {
      yield { event: 'error', data: { message: 'Hệ thống AI chưa được cấu hình.' } };
      return;
    }

    const [doc, rawConvo] = await Promise.all([
      this.estimates.getOwned(userId, id),
      this.estimates.getSessionMessages(userId, id, chatSessionId).catch(() => [] as any[]),
    ]);
    const context = this.contextBuilder.buildContext(doc as any, activeSheetId, selectedRange);
    if (drawingId) {
      context.drawingSummary = await this.contextBuilder.buildDrawingSummary(drawingId, objectId, drawingContext);
    }
    const history = (rawConvo as any[])
      .slice(-6)
      .filter((m: any) => m.kind === 'user' || m.kind === 'assistant')
      .map((m: any) => `${m.kind === 'user' ? 'User' : 'Minh'}: ${String(m.text ?? '').slice(0, 300)}`)
      .join('\n');

    // "Bóc khối lượng" + có bản vẽ → deterministic engine, KHÔNG bao giờ để LLM ước lượng khối lượng.
    const normMsg = normalizeVi(message);
    if (drawingId && (TAKEOFF_INTENT.test(message) || TAKEOFF_INTENT.test(normMsg) || TAKEOFF_ACTION.test(message))) {
      yield* this.runTakeoffEngine(userId, id, doc, drawingId, calibrationFactor, editPermission);
      return;
    }

    const rawMode = this.detectMode(message, !!selectedRange, editPermission);
    // In safe mode (no editPermission) downgrade edit intent to read
    const mode: CopilotMode = !editPermission && rawMode === 'edit' ? 'read' : rawMode;
    this.logger.log(`Copilot mode: ${mode} (raw=${rawMode}, editPermission=${editPermission})`);

    if (!editPermission && rawMode === 'edit') {
      yield { event: 'step', data: { text: 'Chế độ đọc — bật quyền chỉnh sửa để AI đề xuất thay đổi' } };
    }

    if (mode === 'read') {
      yield* this.readHandler.handle(doc as any, context, message, history, editPermission);
      return;
    }

    if (mode === 'review') {
      yield* this.reviewHandler.handle(doc as any, context, message, history);
      return;
    }

    // edit mode (requires editPermission)
    const state = this.estimates.stateForPrompt(doc);
    let research = { text: '', sources: [] as { title?: string; uri?: string }[] };
    const isEmpty = state.takeoff.length === 0 && state.materials.length === 0;
    const isNonPriceEdit = /(xóa|delete|loại bỏ|markup|chi phí chung|lợi nhuận|vat|dự phòng)/i.test(message);

    if (!isNonPriceEdit && (PRICE_INTENT.test(message) || isEmpty)) {
      yield { event: 'step', data: { text: 'Thu thập dữ liệu giá thị trường…' } };
      // Heartbeat every 3s so the UI never sits silent during the ~20s
      // grounded-search wait — the user must see movement within a second.
      const researchPromise = this.ai.research(this.researchQuery(state, message));
      const t0 = Date.now();
      for (;;) {
        const winner = await Promise.race([
          researchPromise.then((r) => ({ r })),
          new Promise<null>((res) => setTimeout(() => res(null), 3000)),
        ]);
        if (winner) {
          research = winner.r;
          break;
        }
        const s = Math.round((Date.now() - t0) / 1000);
        yield { event: 'step', data: { text: `Đang tra cứu giá thị trường trên web… (${s}s)` } };
      }
      yield { event: 'step', data: { text: `Tham chiếu ${research.sources.length} nguồn giá` } };
    }

    yield* this.editHandler.handle(state, context, message, files, research, history);
  }

  /**
   * Route "bóc khối lượng" → TakeoffEngineService (deterministic, không LLM).
   * Ưu tiên calibrationFactor FE gửi; thiếu → heuristic $INSUNITS từ scene
   * (plausibility bbox 2m–5km, port từ FE DrawingWorkspace); vẫn không suy ra
   * được → proposal hướng dẫn thay vì để LLM bịa số.
   */
  private async *runTakeoffEngine(
    userId: string,
    estimateId: string,
    doc: unknown,
    drawingId: string,
    calibrationFactor?: number,
    editPermission = false,
  ): AsyncGenerator<StreamEvent> {
    yield { event: 'step', data: { text: 'Đo hình học bằng engine (không dùng AI ước lượng)…' } };

    const factor =
      calibrationFactor != null && calibrationFactor > 0
        ? calibrationFactor
        : await this.inferCalibrationFactor(drawingId);

    if (factor == null) {
      const state = this.estimates.stateForPrompt(doc as any);
      yield {
        event: 'proposal',
        data: {
          thinking: [
            'Yêu cầu bóc khối lượng — route sang engine đo hình học (không LLM).',
            'Không có hệ số hiệu chỉnh từ FE và không suy ra được đơn vị bản vẽ hợp lý từ header/scene.',
            'Từ chối chạy engine với tỉ lệ đoán mò — không ước lượng khối lượng.',
          ],
          message:
            'Chưa xác định được tỉ lệ bản vẽ (đơn vị vẽ → mét) nên tôi không bóc khối lượng để tránh sai số. ' +
            'Hãy bấm nút ⚡ trên bản vẽ (có hiệu chỉnh tỉ lệ) để bóc chính xác bằng engine đo hình học.',
          actions: [],
          sources: [],
          preview: previewActions(state, []),
          validation: {
            status: 'warning',
            score: 0,
            findings: [
              {
                id: 'takeoff-engine-calibration',
                severity: 'warn',
                area: 'quantity',
                title: 'Thiếu tỉ lệ bản vẽ',
                detail:
                  'Không có calibration và header bản vẽ không cho đơn vị hợp lý (kích thước công trình ngoài khoảng 2m–5km). Hiệu chỉnh 2 điểm trên bản vẽ rồi bấm ⚡.',
              },
            ],
            consistency: [],
          },
          trace: [],
        },
      };
      return;
    }

    const src = calibrationFactor != null && calibrationFactor > 0 ? 'hiệu chỉnh từ bản vẽ' : 'suy từ đơn vị bản vẽ ($INSUNITS)';
    yield { event: 'step', data: { text: `Tỉ lệ ${factor} m/đơn vị vẽ (${src}) — giả định mặc định cao tầng 3.3m, tường 0.2m, dầm 0.4m` } };

    try {
      const result = await this.takeoffEngine.run(userId, estimateId, {
        drawingId,
        unitsPerDrawingUnit: factor,
        assumptions: { ...DEFAULT_TAKEOFF_ASSUMPTIONS },
        editPermission,
      });
      result.thinking.unshift(
        `Chat "bóc khối lượng" route thẳng engine — tỉ lệ ${factor} m/đơn vị (${src}); giả định MẶC ĐỊNH cao tầng 3.3m, dày tường 0.2m, cao dầm 0.4m (chỉnh trong popover ⚡ nếu khác).`,
      );
      yield { event: 'proposal', data: result };
    } catch (err) {
      yield { event: 'error', data: { message: (err as Error).message } };
    }
  }

  /**
   * Heuristic đơn vị bản vẽ từ scene đã persist: units khai báo nếu hợp lý,
   * ngược lại thử mm → m → inch với plausibility bbox 2m–5km. Null = không suy ra được.
   */
  private async inferCalibrationFactor(drawingId: string): Promise<number | null> {
    try {
      const stored = (await this.sceneModel.findOne({ drawingId }).lean()) as any;
      if (!stored?.gz) return null;
      const buf = Buffer.isBuffer(stored.gz) ? stored.gz : Buffer.from(stored.gz.buffer ?? stored.gz);
      const scene = JSON.parse(zlib.gunzipSync(buf).toString('utf-8'));
      const w = (scene.bbox?.maxX ?? 0) - (scene.bbox?.minX ?? 0);
      const h = (scene.bbox?.maxY ?? 0) - (scene.bbox?.minY ?? 0);
      const span = Math.max(w, h) || 0;
      if (span <= 0) return null;
      const plausible = (f: number) => span * f >= 2 && span * f <= 5000;
      const declared = INSUNITS_TO_METERS[scene.units as string];
      if (declared != null && plausible(declared)) return declared;
      return [0.001, 1, 0.0254].find(plausible) ?? null;
    } catch {
      return null;
    }
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

  private feedCache: { items: OfficialFeedItem[]; at: number } | null = null;
  private readonly FEED_TTL_MS = 30 * 60 * 1000;
  private readonly OG_CACHE_MAX = 200;
  private readonly ogCache = new Map<string, string | null>();

  private setOgCache(url: string, value: string | null) {
    if (this.ogCache.size >= this.OG_CACHE_MAX) {
      const firstKey = this.ogCache.keys().next().value;
      if (firstKey !== undefined) this.ogCache.delete(firstKey);
    }
    this.ogCache.set(url, value);
  }

  private fetchUrl(url: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const mod = url.startsWith('https') ? https : http;
      const req = mod.get(
        url,
        {
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; GenSpec/1.0; +https://genspec.vn)' },
          timeout: 6000,
        },
        (res) => {
          if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            resolve(this.fetchUrl(res.headers.location));
            return;
          }
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => { if (Buffer.concat(chunks).length < 200_000) chunks.push(c); });
          res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
          res.on('error', reject);
        },
      );
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    });
  }

  private async fetchOgImage(url: string): Promise<string | null> {
    if (this.ogCache.has(url)) return this.ogCache.get(url) ?? null;
    try {
      const html = await this.fetchUrl(url);
      const ogMatch = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)
        ?? html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);
      const twMatch = html.match(/<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i)
        ?? html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']twitter:image["']/i);
      const result = ogMatch?.[1] ?? twMatch?.[1] ?? null;
      this.setOgCache(url, result);
      return result;
    } catch {
      this.setOgCache(url, null);
      return null;
    }
  }

  private async enrichWithImages(items: OfficialFeedItem[]): Promise<OfficialFeedItem[]> {
    return Promise.all(
      items.map(async (item) => {
        if (!item.url || item.imageUrl) return item;
        const imageUrl = await this.fetchOgImage(item.url);
        return { ...item, imageUrl };
      }),
    );
  }

  async fetchOfficialFeed(): Promise<OfficialFeedItem[]> {
    const now = Date.now();
    if (this.feedCache && now - this.feedCache.at >= this.FEED_TTL_MS) {
      this.feedCache = null;
    }
    if (this.feedCache) {
      return this.feedCache.items;
    }
    if (!this.ai.available) return [];

    const prompt = `Tìm kiếm các thông báo giá vật liệu xây dựng và văn bản pháp luật xây dựng Việt Nam MỚI NHẤT (trong 60 ngày gần nhất).

Ưu tiên nguồn chính thức:
- https://moc.gov.vn (Bộ Xây dựng)
- https://kinhtexaydung.gov.vn (Viện Kinh tế Xây dựng)
- https://soxaydung.hochiminhcity.gov.vn (Sở XD TP.HCM)
- https://soxaydung.hanoi.gov.vn (Sở XD Hà Nội)
- https://sxd.binhduong.gov.vn (Sở XD Bình Dương)
- https://sxd.dongnai.gov.vn (Sở XD Đồng Nai)
- https://vbpl.vn (Cơ sở dữ liệu VBPL)

Tìm: thông báo giá VLXD mới nhất các tỉnh, Thông tư/Quyết định của Bộ XD về định mức đơn giá, suất đầu tư xây dựng mới.

Trả về JSON array (CHỈ JSON, không markdown, không text thêm):
[
  {
    "title": "Tên văn bản hoặc thông báo",
    "region": "TP.HCM hoặc Hà Nội hoặc Bình Dương hoặc Đồng Nai hoặc Toàn quốc",
    "source": "Tên cơ quan ban hành",
    "issuedDate": "yyyy-mm-dd hoặc null",
    "effectiveDate": "yyyy-mm-dd hoặc null",
    "type": "price_notification hoặc regulation hoặc circular hoặc decision",
    "trustScore": 95,
    "url": "url đầy đủ hoặc null",
    "summary": "Mô tả ngắn 1-2 câu nội dung chính của văn bản"
  }
]
Trả về 6-8 kết quả chính xác nhất, mới nhất. trustScore từ 70-98 dựa vào độ chính thức của nguồn.`;

    try {
      const raw = await this.ai.reviewGemini(prompt);
      const start = raw.indexOf('[');
      const end = raw.lastIndexOf(']');
      if (start === -1 || end === -1) return [];
      const items = JSON.parse(raw.slice(start, end + 1)) as OfficialFeedItem[];
      const base = Array.isArray(items) ? items.slice(0, 10) : [];
      const result = await this.enrichWithImages(base);
      this.feedCache = { items: result, at: now };
      return result;
    } catch (err) {
      this.logger.warn('fetchOfficialFeed failed:', (err as Error).message);
      return this.feedCache?.items ?? [];
    }
  }

  private detectMode(message: string, hasSelection: boolean, editPermission = false): CopilotMode {
    // Structured agent tasks (⚡ full takeoff, generate-takeoff…) carry an
    // explicit [ACTION:*] tag — always edit intent. Without this, the prompt's
    // own vocabulary ("định mức", "đơn giá") trips WEB_LEGAL_INTENT below and
    // silently downgrades the task to read mode.
    if (/\[ACTION:/i.test(message)) return 'edit';
    const norm = normalizeVi(message);
    // Edit ON + edit verb ("cập nhật giá theo định mức…") → edit wins even when
    // the message also mentions định mức/thông tư — those are the OBJECT of the
    // edit, not a research question. Without this the WEB_LEGAL check below
    // hijacks the request into read mode and the model nags "bật Edit".
    if (editPermission && (EDIT_INTENT.test(message) || EDIT_INTENT.test(norm))) return 'edit';
    // Short confirmations ("oke làm đi", "áp dụng", "chốt") with edit ON are
    // orders to execute the agent's own last suggestion — never read questions.
    if (editPermission && message.trim().length <= 40 && CONFIRM_INTENT.test(norm)) return 'edit';
    // Web/legal questions always go to read — even if message contains "kiểm tra"
    if (WEB_LEGAL_INTENT.test(message) || WEB_LEGAL_INTENT.test(norm)) return 'read';
    // If user has a cell selected, treat as focused read unless edit action is explicit
    if (hasSelection && !EDIT_INTENT.test(message) && !EDIT_INTENT.test(norm)) return 'read';
    if (REVIEW_INTENT.test(message) || REVIEW_INTENT.test(norm)) return 'review';
    if (EDIT_INTENT.test(message) || EDIT_INTENT.test(norm)) return 'edit';
    return 'read';
  }

  private researchQuery(state: any, message: string): string {
    const prov = state.projectInfo.location?.trim();
    const loc = prov ? ` tại ${prov}` : ' tại Việt Nam';
    // Ghim tỉnh: ưu tiên công bố giá của CHÍNH tỉnh dự án (Sở XD tỉnh đó), quý gần nhất.
    const provPref = prov
      ? `Ưu tiên CÔNG BỐ GIÁ của Sở Xây dựng ${prov} (soxaydung.<${prov}>.gov.vn), quý gần nhất. Nêu rõ NGÀY và tên nguồn.`
      : 'Ưu tiên thông báo giá liên Sở / báo giá nhà cung cấp quý gần nhất. Nêu rõ NGÀY và tên nguồn.';
    return [
      `Bảng giá vật liệu xây dựng MỚI NHẤT${loc} (xi măng PCB40, cát, đá, thép, gạch, sơn).`,
      provPref,
      `Đơn giá nhân công và ca máy hiện hành${loc}.`,
      `Suất đầu tư "${state.projectInfo.buildingType ?? state.projectInfo.name ?? 'nhà ở dân dụng'}"${loc} (triệu đồng/m² sàn).`,
      message ? `Bối cảnh: ${message}` : '',
    ]
      .filter(Boolean)
      .join('\n');
  }
}
