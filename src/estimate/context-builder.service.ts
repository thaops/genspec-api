import { Injectable } from '@nestjs/common';
import { Workbook } from './estimate.types';
import { getWorkbookSummary, getSheetSummary } from './tools/tool-registry';

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
}

// Kept for backward compatibility with any code that still imports CompressedContext
export type CompressedContext = WorkbookContext;

@Injectable()
export class ContextBuilderService {
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

          const merged: Record<string, Record<string, string>> = {};
          [...neighborRows, ...selectedRows].forEach((r) => { merged[r.rowKey] = r.cells; });
          focusedData = JSON.stringify(merged);
        }
      }
    }

    return { workbookSummary, activeSheetSummary, selectedRows, neighborRows, focusedData };
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
        if (cell) cells[String(c)] = String(cell.v ?? cell.m ?? '');
      }
      if (Object.keys(cells).length > 0) rows.push({ rowKey: String(r), cells });
    }
    return rows;
  }
}
