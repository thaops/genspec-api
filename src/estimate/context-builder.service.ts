import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Workbook } from './estimate.types';
import { getWorkbookSummary, getSheetSummary } from './tools/tool-registry';
import { Drawing, DrawingDocument } from '../drawing/schemas/drawing.schema';
import { DrawingObject, DrawingObjectDocument } from '../drawing/schemas/drawing-object.schema';

export interface DrawingViewContext {
  page?: number;
  scale?: number;
  activeTool?: string;
  layer?: string;
  objectType?: string;
}

export interface CellRow {
  rowKey: string;
  cells: Record<string, string>;
}

export interface WorkbookContext {
  workbookSummary: string;
  activeSheetSummary?: string;
  selectedRows?: CellRow[];
  neighborRows?: CellRow[];
  focusedData?: string;
  selectionLabel?: string; // human-readable "B3:C5"
  drawingSummary?: string; // compact summary of the active drawing (if any)
}

// Kept for backward compatibility with any code that still imports CompressedContext
export type CompressedContext = WorkbookContext;

@Injectable()
export class ContextBuilderService {
  constructor(
    @InjectModel(Drawing.name) private readonly drawingModel: Model<DrawingDocument>,
    @InjectModel(DrawingObject.name) private readonly drawingObjectModel: Model<DrawingObjectDocument>,
  ) {}

  /** Compact summary of the active drawing for the copilot prompt. Returns undefined on missing/failed load. */
  async buildDrawingSummary(
    drawingId: string,
    objectId?: string,
    drawingContext?: DrawingViewContext,
  ): Promise<string | undefined> {
    try {
      const [drawing, objects] = await Promise.all([
        this.drawingModel.findById(drawingId).lean(),
        this.drawingObjectModel.find({ drawingId }).lean(),
      ]);
      if (!drawing) return undefined;

      // Chỉ đếm đối tượng đã chốt loại vào inventory cho LLM — object ambiguous
      // (còn nhiều candidate) đếm riêng, tránh LLM coi là khối lượng thật.
      const byType: Record<string, number> = {};
      let ambiguous = 0;
      for (const o of objects) {
        if ((o as any).ambiguous) { ambiguous += 1; continue; }
        byType[o.type] = (byType[o.type] ?? 0) + 1;
      }
      const typeLine = Object.entries(byType)
        .map(([t, n]) => `${t}: ${n}`)
        .join(', ');

      const lines: string[] = [
        `Bản vẽ: "${drawing.name}" (${drawing.type}, ${drawing.pageCount} trang, trạng thái: ${drawing.parseStatus})`,
        `Tổng ${objects.length} đối tượng${typeLine ? ` — ${typeLine}` : ''}` +
          (ambiguous ? ` (${ambiguous} chưa chốt loại, chưa tính khối lượng)` : ''),
      ];

      if (objectId) {
        const obj = objects.find((o) => String((o as any)._id) === objectId || o.stableId === objectId);
        if (obj) {
          lines.push(
            `Đối tượng đang chọn: ${obj.type} (layer: ${obj.layer}${obj.floor ? `, tầng: ${obj.floor}` : ''}, confidence: ${obj.confidence})` +
              (Object.keys(obj.properties ?? {}).length ? ` — thuộc tính: ${JSON.stringify(obj.properties)}` : ''),
          );
        }
      }

      if (drawingContext) {
        const view: string[] = [];
        if (drawingContext.page != null) view.push(`trang ${drawingContext.page}`);
        if (drawingContext.scale != null) view.push(`tỷ lệ ${drawingContext.scale}`);
        if (drawingContext.activeTool) view.push(`công cụ: ${drawingContext.activeTool}`);
        if (drawingContext.layer) view.push(`layer: ${drawingContext.layer}`);
        if (drawingContext.objectType) view.push(`loại đối tượng: ${drawingContext.objectType}`);
        if (view.length) lines.push(`Đang xem: ${view.join(', ')}`);
      }

      return lines.join('\n');
    } catch {
      return undefined;
    }
  }

  buildContext(
    workbook: Workbook,
    activeSheetId?: string,
    selectedRange?: { startRow: number; startCol: number; endRow: number; endCol: number },
  ): WorkbookContext {
    const summaryResult = getWorkbookSummary(workbook);
    const workbookSummary = JSON.stringify(summaryResult.data);

    let activeSheetSummary: string | undefined;
    let selectedRows: CellRow[] | undefined;
    let neighborRows: CellRow[] | undefined;
    let focusedData: string | undefined;

    if (activeSheetId) {
      const sheetResult = getSheetSummary(workbook, activeSheetId);
      if (sheetResult.ok) {
        activeSheetSummary = JSON.stringify(sheetResult.data);
      }

      if (selectedRange) {
        const sheet = (workbook.sheets ?? []).find((s) => s.id === activeSheetId);
        const cellData = sheet?.data?.cellData;
        if (cellData) {
          selectedRows = this.extractRows(cellData, selectedRange.startRow, selectedRange.endRow, selectedRange.startCol, selectedRange.endCol);
          const beforeRows = this.extractRows(cellData, Math.max(0, selectedRange.startRow - 2), selectedRange.startRow - 1, selectedRange.startCol, selectedRange.endCol);
          const afterRows = this.extractRows(cellData, selectedRange.endRow + 1, selectedRange.endRow + 2, selectedRange.startCol, selectedRange.endCol);
          neighborRows = [...beforeRows, ...afterRows];

          const selStart = this.cellAddress(selectedRange.startRow, selectedRange.startCol);
          const selEnd = this.cellAddress(selectedRange.endRow, selectedRange.endCol);
          const label = selStart === selEnd ? selStart : `${selStart}:${selEnd}`;

          const lines: string[] = [`Ô được chọn: ${label}`];
          for (const row of selectedRows) {
            const vals = Object.entries(row.cells).map(([col, val]) => `${this.colLetter(Number(col))}${Number(row.rowKey) + 1}="${val}"`).join(', ');
            lines.push(`  Hàng ${Number(row.rowKey) + 1}: ${vals}`);
          }
          if (neighborRows.length > 0) {
            lines.push('Ngữ cảnh lân cận:');
            for (const row of neighborRows) {
              const vals = Object.entries(row.cells).map(([col, val]) => `${this.colLetter(Number(col))}${Number(row.rowKey) + 1}="${val}"`).join(', ');
              lines.push(`  Hàng ${Number(row.rowKey) + 1}: ${vals}`);
            }
          }
          focusedData = lines.join('\n');

          // For UI display
          const merged: Record<string, Record<string, string>> = {};
          [...neighborRows, ...selectedRows].forEach((r) => { merged[r.rowKey] = r.cells; });

          // selectionLabel for frontend/AI reference
          const selectionLabel = label;
          return { workbookSummary, activeSheetSummary, selectedRows, neighborRows, focusedData, selectionLabel };
        }
      }
    }

    return { workbookSummary, activeSheetSummary, selectedRows, neighborRows, focusedData };
  }

  private colLetter(col: number): string {
    let letter = '';
    let n = col;
    do {
      letter = String.fromCharCode(65 + (n % 26)) + letter;
      n = Math.floor(n / 26) - 1;
    } while (n >= 0);
    return letter;
  }

  private cellAddress(row: number, col: number): string {
    return `${this.colLetter(col)}${row + 1}`;
  }

  private extractRows(
    cellData: Record<string, any>,
    startRow: number,
    endRow: number,
    startCol: number,
    endCol: number,
  ): CellRow[] {
    const rows: CellRow[] = [];
    for (let r = startRow; r <= endRow; r++) {
      const row = cellData[String(r)];
      if (!row) continue;
      const cells: Record<string, string> = {};
      for (let c = startCol; c <= endCol; c++) {
        const cell = row[String(c)];
        if (cell) {
          // Include formula if present so AI knows to use =ref syntax, not hardcoded values
          cells[String(c)] = cell.f ? `=${cell.f}` : String(cell.v ?? cell.m ?? '');
        }
      }
      if (Object.keys(cells).length > 0) rows.push({ rowKey: String(r), cells });
    }
    return rows;
  }
}
