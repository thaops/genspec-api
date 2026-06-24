import { Injectable } from '@nestjs/common';
import { Sheet, Workbook } from './estimate.types';
import { detectSheetType } from './rule-detector';

export interface CompressedContext {
  workbookSummary: string;
  activeSheetSummary: string;
  focusedData: string;
}

@Injectable()
export class ContextBuilderService {
  buildContext(
    workbook: Workbook,
    activeSheetId?: string,
    selectedRange?: { startRow: number; startCol: number; endRow: number; endCol: number },
  ): CompressedContext {
    const sheetsList = workbook.sheets ?? [];

    const indexInfo = sheetsList.map((s) => {
      const { sheetType } = detectSheetType(s);
      const rowCount = s.data?.rowCount ?? 0;
      const colCount = s.data?.columnCount ?? 0;
      const headers = this.extractHeaders(s);
      return {
        id: s.id,
        name: s.name,
        type: sheetType,
        rows: rowCount,
        cols: colCount,
        headers,
      };
    });

    const workbookSummary = JSON.stringify({
      workbookName: workbook.name,
      sheets: indexInfo,
    });

    let activeSheetSummary = '';
    let focusedData = '';

    if (activeSheetId) {
      const activeSheet = sheetsList.find((s) => s.id === activeSheetId);
      if (activeSheet) {
        const { sheetType } = detectSheetType(activeSheet);
        activeSheetSummary = JSON.stringify({
          activeSheetId: activeSheet.id,
          activeSheetName: activeSheet.name,
          type: sheetType,
        });

        focusedData = this.extractFocusedCells(activeSheet, selectedRange);
      }
    }

    return {
      workbookSummary,
      activeSheetSummary,
      focusedData,
    };
  }

  private extractHeaders(sheet: Sheet): string[] {
    const cellData = sheet.data?.cellData;
    if (!cellData) return [];

    const maxRowsScan = Math.min(5, Object.keys(cellData).length);
    for (let r = 0; r < maxRowsScan; r++) {
      const row = cellData[String(r)];
      if (!row) continue;

      const vals = Object.keys(row).map((c) => String(row[c]?.v || row[c]?.m || '').trim());
      if (vals.filter(Boolean).length >= 2) {
        return vals.filter(Boolean);
      }
    }
    return [];
  }

  private extractFocusedCells(
    sheet: Sheet,
    range?: { startRow: number; startCol: number; endRow: number; endCol: number },
  ): string {
    const cellData = sheet.data?.cellData;
    if (!cellData) return 'No data';

    const result: Record<string, Record<string, any>> = {};

    if (range) {
      const startR = Math.max(0, range.startRow - 2);
      const endR = Math.min(range.endRow + 2, (sheet.data?.rowCount ?? 100) - 1);

      for (let r = startR; r <= endR; r++) {
        const row = cellData[String(r)];
        if (!row) continue;

        const cols: Record<string, any> = {};
        for (let c = range.startCol; c <= range.endCol; c++) {
          const cell = row[String(c)];
          if (cell) {
            cols[String(c)] = cell.v || cell.m || '';
          }
        }
        result[String(r)] = cols;
      }
    } else {
      const rows = Object.keys(cellData).slice(0, 10);
      rows.forEach((rKey) => {
        const row = cellData[rKey];
        if (row) {
          const cols: Record<string, any> = {};
          Object.keys(row).slice(0, 8).forEach((cKey) => {
            cols[cKey] = row[cKey]?.v || row[cKey]?.m || '';
          });
          result[rKey] = cols;
        }
      });
    }

    return JSON.stringify(result);
  }
}
