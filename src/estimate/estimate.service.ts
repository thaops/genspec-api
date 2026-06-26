import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
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

  async getConversation(userId: string, id: string): Promise<any[]> {
    const doc = await this.getOwned(userId, id);
    return (doc as any).conversationMessages ?? [];
  }

  async saveConversation(userId: string, id: string, messages: any[]): Promise<{ ok: true }> {
    await this.getOwned(userId, id); // auth check
    await this.model.findByIdAndUpdate(id, {
      $set: { conversationMessages: messages.slice(-100) },
    });
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
    doc.sheets = state.sheets;
    doc.entityMaps = state.entityMaps;
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
    const excelWb = new ExcelJS.Workbook();
    await excelWb.xlsx.load(buffer);

    // Shared style registry (Univer uses workbook-level style IDs referenced by cells)
    const stylesRegistry: Record<string, any> = {};
    const styleKeyToId: Record<string, string> = {};
    let styleCounter = 0;

    function hexFromArgb(argb?: string): string | undefined {
      if (!argb || argb.length < 6) return undefined;
      const hex = (argb.length === 8 ? argb.slice(2) : argb).toUpperCase();
      if (hex === 'FFFFFF' || hex === '000000' || hex === '00000000') return undefined;
      return '#' + hex;
    }

    function buildStyleId(cell: ExcelJS.Cell): string | undefined {
      const s: Record<string, any> = {};
      const fill = (cell as any).fill;
      if (fill?.type === 'pattern' && fill.pattern !== 'none') {
        const rgb = hexFromArgb(fill.fgColor?.argb);
        if (rgb) s.bg = { rgb };
      }
      const font = (cell as any).font;
      if (font?.bold) s.bl = 1;
      if (font?.italic) s.it = 1;
      if (font?.size && font.size !== 11) s.fs = font.size;
      if (font?.color?.argb) { const rgb = hexFromArgb(font.color.argb); if (rgb) s.cl = { rgb }; }
      const align = (cell as any).alignment;
      const HT: Record<string, number> = { left: 1, center: 2, right: 3 };
      const VT: Record<string, number> = { top: 1, middle: 2, bottom: 3 };
      if (align?.horizontal && HT[align.horizontal]) s.ht = HT[align.horizontal];
      if (align?.vertical && VT[align.vertical]) s.vt = VT[align.vertical];
      if (align?.wrapText) s.tb = 3;
      if (!Object.keys(s).length) return undefined;
      const key = JSON.stringify(s);
      if (!styleKeyToId[key]) {
        const newId = String(++styleCounter);
        styleKeyToId[key] = newId;
        stylesRegistry[newId] = s;
      }
      return styleKeyToId[key];
    }

    const sheets = excelWb.worksheets.map((ws) => {
      const cellData: Record<string, Record<string, any>> = {};
      const columnData: Record<string, { w: number }> = {};
      const rowData: Record<string, { h: number }> = {};
      let maxRow = 0;
      let maxCol = 0;

      // Column widths: Excel char units → pixels (≈ 8px per char)
      for (let ci = 1; ci <= ws.columnCount; ci++) {
        const col = ws.getColumn(ci);
        const w = (col as any).width;
        if (w && w > 0) columnData[String(ci - 1)] = { w: Math.round(w * 8) };
      }

      ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
        const ri = rowNumber - 1;
        // Row heights: points → pixels (1pt ≈ 1.333px at 96dpi)
        if ((row as any).height > 0) rowData[String(ri)] = { h: Math.round((row as any).height * 1.333) };

        row.eachCell({ includeEmpty: false }, (cell, colNumber) => {
          const ci = colNumber - 1;
          let v: any = cell.value;
          let f: string | undefined;

          if (typeof v === 'object' && v !== null && 'formula' in v) {
            const fs = String((v as any).formula ?? '').trim();
            if (fs) f = '=' + fs;
            v = (v as any).result ?? '';
          }
          if (typeof v === 'object' && v !== null && 'richText' in v) {
            v = ((v as any).richText as Array<{ text?: string }>).map((p) => p.text ?? '').join('');
          }
          if (typeof v === 'object' && v !== null && 'text' in v) v = (v as any).text;
          if (v instanceof Date) v = v.toLocaleDateString('vi-VN');
          if (typeof v === 'object' && v !== null) v = String(v);

          const sid = buildStyleId(cell);
          const hasValue = v !== null && v !== undefined && v !== '';
          if (!hasValue && !f && !sid) return;

          if (!cellData[String(ri)]) cellData[String(ri)] = {};
          const entry: any = f ? { v: v ?? '', f } : { v: v ?? '' };
          if (sid) entry.s = sid;
          cellData[String(ri)][String(ci)] = entry;

          if (ri > maxRow) maxRow = ri;
          if (ci > maxCol) maxCol = ci;
        });
      });

      // Merged cells
      const mergeData: any[] = [];
      const wsModel = (ws as any).model;
      if (Array.isArray(wsModel?.merges)) {
        for (const mergeRef of wsModel.merges) {
          const parts = String(mergeRef).split(':');
          if (parts.length !== 2) continue;
          try {
            const sc = ws.getCell(parts[0]);
            const ec = ws.getCell(parts[1]);
            mergeData.push({ startRow: sc.row - 1, startColumn: sc.col - 1, endRow: ec.row - 1, endColumn: ec.col - 1 });
          } catch { /* skip invalid */ }
        }
      }

      return {
        id: `sheet-${ws.id}`,
        name: ws.name,
        data: {
          cellData,
          rowCount: Math.max(maxRow + 10, 100),
          columnCount: Math.max(maxCol + 5, 20),
          ...(Object.keys(columnData).length && { columnData }),
          ...(Object.keys(rowData).length && { rowData }),
          ...(mergeData.length && { mergeData }),
        },
      };
    });

    // Attach workbook-level style registry to first sheet so WorkbookEditor can restore it
    if (sheets.length > 0 && Object.keys(stylesRegistry).length > 0) {
      (sheets[0].data as any)._styles = stylesRegistry;
    }

    const state = stateOf(doc);
    const { state: next } = applyActions(state, [{ type: 'set_sheets', sheets } as any]);
    return this.saveState(doc, next);
  }
}
