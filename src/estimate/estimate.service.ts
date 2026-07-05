import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import * as ExcelJS from 'exceljs';
import { compute } from './boq.engine';
import { staticBenchmark } from './benchmark';
import { Estimate, EstimateDocument } from './estimate.schema';
import { Action, DEFAULT_MARKUPS, EstimateState } from './estimate.types';
import { applyActions } from './reducer';
import { buildActivity, previewActions } from './transparency';
import { buildTrace } from './trace';
import { validate } from './validation';
import { generatePatch, applyRollback } from './patch-history';
import { Drawing, DrawingDocument } from '../drawing/schemas/drawing.schema';
import { excelToUniverSheets } from './excel-to-univer';
import {
  ChatSession,
  ChatSessionMeta,
  capSessions,
  deriveTitle,
  latestSession,
  newChatSession,
  toSessionMeta,
  wrapLegacyConversation,
  MAX_SESSION_MESSAGES,
} from './chat-sessions';

function stateOf(doc: EstimateDocument): EstimateState {
  return {
    projectInfo: doc.projectInfo ?? {},
    takeoff: doc.takeoff ?? [],
    analyses: doc.analyses ?? [],
    materials: doc.materials ?? [],
    labor: doc.labor ?? [],
    equipment: doc.equipment ?? [],
    markups: doc.markups ?? { ...DEFAULT_MARKUPS },
    sheets: doc.sheets ?? [],
    entityMaps: doc.entityMaps ?? [],
    patchHistory: (doc as any).patchHistory ?? [],
  };
}

export function toEstimateDto(doc: EstimateDocument) {
  const ts = doc as unknown as { createdAt?: Date; updatedAt?: Date };
  const state = stateOf(doc);
  const computed = compute(state);
  const validation = validate(state, computed, staticBenchmark(state.projectInfo));
  return {
    id: doc._id.toString(),
    userId: doc.userId,
    name: doc.name,
    ...state,
    ...computed, // boq, materialSummary, costSummary, costs
    validation, // self-check: status, score, benchmark, findings, consistency
    trace: buildTrace(state, computed), // auditable derivation per BOQ line
    activityLog: (doc.activityLog ?? []).slice(-100),
    patchHistory: (state.patchHistory ?? []).slice(-100),
    createdAt: ts.createdAt,
    updatedAt: ts.updatedAt,
  };
}

@Injectable()
export class EstimateService {
  constructor(
    @InjectModel(Estimate.name) private readonly model: Model<EstimateDocument>,
    @InjectModel(Drawing.name) private readonly drawingModel: Model<DrawingDocument>,
  ) {}

  // ── Chat sessions ────────────────────────────────────────────────────────
  // Mỗi estimate có nhiều phiên chat; endpoint /conversation cũ proxy vào
  // session MỚI NHẤT. Migration mềm: doc chỉ có conversationMessages cũ →
  // lần đọc đầu bọc thành session {id:'legacy', title:'Hội thoại cũ'}.

  /** Đọc sessions + lazy-migrate conversation cũ (auth qua getOwned). */
  private async loadSessions(userId: string, id: string): Promise<ChatSession[]> {
    const doc = await this.getOwned(userId, id);
    const existing = (doc as any).chatSessions as ChatSession[] | undefined;
    if (existing?.length) return existing;
    const legacy = (doc as any).conversationMessages as any[] | undefined;
    if (legacy?.length) {
      const sessions = [wrapLegacyConversation(legacy)];
      await this.model.findByIdAndUpdate(id, { $set: { chatSessions: sessions } });
      return sessions;
    }
    return [];
  }

  private async persistSessions(id: string, sessions: ChatSession[]): Promise<void> {
    await this.model.findByIdAndUpdate(id, { $set: { chatSessions: capSessions(sessions) } });
  }

  async listChatSessions(userId: string, id: string): Promise<ChatSessionMeta[]> {
    const sessions = await this.loadSessions(userId, id);
    return sessions
      .map(toSessionMeta)
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  }

  async createChatSession(userId: string, id: string): Promise<ChatSessionMeta> {
    const sessions = await this.loadSessions(userId, id);
    const session = newChatSession(sessions.length);
    await this.persistSessions(id, [...sessions, session]);
    return toSessionMeta(session);
  }

  async getChatSession(userId: string, id: string, sid: string): Promise<any[]> {
    const sessions = await this.loadSessions(userId, id);
    const session = sessions.find((s) => s.id === sid);
    if (!session) throw new NotFoundException('Không tìm thấy phiên chat');
    return session.messages ?? [];
  }

  async saveChatSession(
    userId: string,
    id: string,
    sid: string,
    messages: any[],
  ): Promise<{ ok: true }> {
    const sessions = await this.loadSessions(userId, id);
    const session = sessions.find((s) => s.id === sid);
    if (!session) throw new NotFoundException('Không tìm thấy phiên chat');
    session.messages = (messages ?? []).slice(-MAX_SESSION_MESSAGES);
    session.title = deriveTitle(session.title, session.messages);
    session.updatedAt = new Date().toISOString();
    await this.persistSessions(id, sessions);
    return { ok: true };
  }

  async deleteChatSession(userId: string, id: string, sid: string): Promise<{ ok: true }> {
    const sessions = await this.loadSessions(userId, id);
    await this.persistSessions(id, sessions.filter((s) => s.id !== sid));
    return { ok: true };
  }

  /** History cho copilot: sid chỉ định → session đó; không → session mới nhất. */
  async getSessionMessages(userId: string, id: string, sid?: string): Promise<any[]> {
    const sessions = await this.loadSessions(userId, id);
    const session = sid ? sessions.find((s) => s.id === sid) : latestSession(sessions);
    return session?.messages ?? [];
  }

  /** Endpoint cũ — đọc session mới nhất (FE cũ không vỡ). */
  async getConversation(userId: string, id: string): Promise<any[]> {
    return this.getSessionMessages(userId, id);
  }

  /** Endpoint cũ — lưu vào session mới nhất (tạo nếu chưa có). */
  async saveConversation(userId: string, id: string, messages: any[]): Promise<{ ok: true }> {
    const sessions = await this.loadSessions(userId, id);
    let session = latestSession(sessions);
    if (!session) {
      session = newChatSession(sessions.length);
      sessions.push(session);
    }
    session.messages = (messages ?? []).slice(-MAX_SESSION_MESSAGES);
    session.title = deriveTitle(session.title, session.messages);
    session.updatedAt = new Date().toISOString();
    await this.persistSessions(id, sessions);
    return { ok: true };
  }

  async create(userId: string, name: string) {
    const doc = await this.model.create({
      userId,
      name: name?.trim() || 'Dự án mới',
      projectInfo: { name: name?.trim() },
      markups: { ...DEFAULT_MARKUPS },
    });
    return toEstimateDto(doc);
  }

  async list(userId: string) {
    const docs = await this.model.find({ userId }).sort({ updatedAt: -1 }).exec();
    const ids = docs.map((d) => d._id.toString());

    // Batch-fetch drawings: count + first thumbnail per estimate (2 queries total)
    const drawings = await this.drawingModel
      .find({ estimateId: { $in: ids } }, { estimateId: 1, thumbnail: 1, createdAt: 1 })
      .sort({ estimateId: 1, createdAt: 1 })
      .exec();

    const drawingMap = new Map<string, { count: number; thumbnail?: string }>();
    for (const drw of drawings) {
      const eid = drw.estimateId;
      if (!drawingMap.has(eid)) {
        drawingMap.set(eid, { count: 0, thumbnail: drw.thumbnail ?? undefined });
      }
      drawingMap.get(eid)!.count++;
    }

    return docs.map((d) => {
      const dto = toEstimateDto(d);
      const drwInfo = drawingMap.get(dto.id);
      return {
        id: dto.id,
        name: dto.name,
        projectInfo: dto.projectInfo,
        costs: dto.costs,
        itemCount: dto.boq.length,
        takeoffCount: dto.takeoff.length,
        drawingCount: drwInfo?.count ?? 0,
        thumbnail: drwInfo?.thumbnail ?? null,
        createdAt: dto.createdAt,
        updatedAt: dto.updatedAt,
      };
    });
  }

  async getOwned(userId: string, id: string) {
    const doc = await this.model.findById(id).exec();
    if (!doc) throw new NotFoundException('Estimate not found');
    if (doc.userId !== userId) throw new ForbiddenException();
    return doc;
  }

  async getOne(userId: string, id: string) {
    return toEstimateDto(await this.getOwned(userId, id));
  }

  async rename(userId: string, id: string, name: string) {
    const doc = await this.getOwned(userId, id);
    doc.name = name.trim() || doc.name;
    await doc.save();
    return toEstimateDto(doc);
  }

  async remove(userId: string, id: string) {
    const doc = await this.getOwned(userId, id);
    await doc.deleteOne();
    return { ok: true };
  }

  private async saveState(doc: EstimateDocument, state: EstimateState) {
    const computed = compute(state);
    doc.projectInfo = state.projectInfo;
    doc.takeoff = state.takeoff;
    doc.analyses = state.analyses;
    doc.materials = state.materials;
    doc.labor = state.labor;
    doc.equipment = state.equipment;
    doc.markups = state.markups;
    doc.sheets = state.sheets ?? [];
    doc.entityMaps = state.entityMaps ?? [];
    (doc as any).patchHistory = state.patchHistory;
    doc.costs = computed.costs;
    await doc.save();
    return toEstimateDto(doc);
  }

  /** Single mutation path — manual edits and AI-confirmed proposals both flow through here. */
  async applyActions(userId: string, id: string, actions: Action[], src: 'ai' | 'manual' = 'manual') {
    const doc = await this.getOwned(userId, id);
    const before = stateOf(doc);
    const { state, applied, warnings } = applyActions(before, actions);
    const patch = generatePatch(before, actions, src);
    state.patchHistory = [...(before.patchHistory ?? []), patch].slice(-100);
    const log = buildActivity(before, actions, new Date().toISOString(), src);
    doc.activityLog = [...(doc.activityLog ?? []), ...log].slice(-200);
    const estimate = await this.saveState(doc, state);
    return { estimate, applied, warnings };
  }

  /** Dry-run preview of a batch of actions (no persistence) — for the AI change preview. */
  async preview(userId: string, id: string, actions: Action[]) {
    const doc = await this.getOwned(userId, id);
    return previewActions(stateOf(doc), actions);
  }

  stateForPrompt(doc: EstimateDocument): EstimateState {
    return stateOf(doc);
  }

  async rollback(userId: string, id: string, patchId: string) {
    const doc = await this.getOwned(userId, id);
    const state = stateOf(doc);
    const history = state.patchHistory ?? [];
    const idx = history.findIndex((p) => p.id === patchId);
    if (idx === -1) throw new NotFoundException('Patch not found in history');
    const toRollback = history.slice(idx);
    let nextState = state;
    for (let i = toRollback.length - 1; i >= 0; i--) {
      nextState = applyRollback(nextState, toRollback[i]);
    }
    nextState.patchHistory = history.slice(0, idx);
    const rollbackLog = {
      at: new Date().toISOString(),
      source: 'manual' as const,
      kind: 'rollback',
      label: `Khôi phục về trạng thái trước thay đổi: "${toRollback[0].description}"`,
      detail: `Đã đảo ngược ${toRollback.length} thay đổi`,
    };
    doc.activityLog = [...(doc.activityLog ?? []), rollbackLog].slice(-200);
    return this.saveState(doc, nextState);
  }

  async importExcel(userId: string, id: string, buffer: Buffer) {
    const doc = await this.getOwned(userId, id);

    // Legacy .xls (OLE compound file, magic D0 CF 11 E0): ExcelJS only reads
    // .xlsx — convert via SheetJS first (values/formulas/merges survive;
    // styles are limited in the legacy format).
    let xlsxBuffer = buffer;
    const isLegacyXls =
      buffer.length > 4 && buffer[0] === 0xd0 && buffer[1] === 0xcf && buffer[2] === 0x11 && buffer[3] === 0xe0;
    if (isLegacyXls) {
      try {
        const XLSX = await import('xlsx');
        const legacy = XLSX.read(buffer, { type: 'buffer', cellStyles: true, cellDates: true });
        xlsxBuffer = XLSX.write(legacy, { type: 'buffer', bookType: 'xlsx', cellStyles: true }) as Buffer;
      } catch {
        throw new BadRequestException(
          'File .xls (định dạng Excel cũ) không đọc được. Vui lòng mở bằng Excel → Save As → .xlsx rồi import lại.',
        );
      }
    }

    const excelWb = new ExcelJS.Workbook();
    try {
      await excelWb.xlsx.load(xlsxBuffer as unknown as ArrayBuffer);
    } catch {
      throw new BadRequestException('File không phải định dạng Excel hợp lệ (.xlsx). Kiểm tra lại file rồi import lại.');
    }

    const { sheets, styles } = excelToUniverSheets(excelWb);
    if (sheets.length === 0 || sheets.every((s) => Object.keys((s.data as any)?.cellData ?? {}).length === 0)) {
      throw new BadRequestException(
        'Không đọc được dữ liệu nào từ file. Nếu là file .xls cũ, hãy mở bằng Excel → Save As → .xlsx rồi thử lại.',
      );
    }

    // Attach workbook-level style registry to first sheet so WorkbookEditor can restore it
    if (sheets.length > 0 && Object.keys(styles).length > 0) {
      (sheets[0].data as any)._styles = styles;
    }

    const state = stateOf(doc);
    const { state: next } = applyActions(state, [{ type: 'set_sheets', sheets } as any]);
    return this.saveState(doc, next);
  }
}
