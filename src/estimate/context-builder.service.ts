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
  selectionLabel?: string; // human-readable "B3:C5"
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
