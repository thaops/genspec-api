import { Workbook } from '../estimate.types';
import { detectSheetType } from '../rule-detector';
import {
  findDuplicateRowsInSheet,
  detectOutlierPrices,
  detectMissingPrices,
  detectFormulaErrors,
  getMaterialsFromWorkbook,
  DuplicateRow,
  OutlierPrice,
  MissingPrice,
  FormulaError,
} from './workbook.tools';

export interface SheetMeta {
  id: string;
  name: string;
  type: string;
  confidence: number;
  matchedRules: string[];
  rowCount: number;
  colCount: number;
  headers: string[];
}

export interface WorkbookSummary {
  name: string;
  sheets: SheetMeta[];
}

export interface SheetSummary extends SheetMeta {
  sampleRows: Record<string, Record<string, any>>;
}

export interface SearchMatch {
  sheetId: string;
  sheetName: string;
  rowKey: string;
  colKey: string;
  cellAddress: string;
  value: string;
}

export interface ToolResult<T> {
  tool: string;
  ok: boolean;
  data: T;
  error?: string;
}

function colIndexToLetter(idx: number): string {
  let result = '';
  let n = idx;
  while (n >= 0) {
    result = String.fromCharCode(65 + (n % 26)) + result;
    n = Math.floor(n / 26) - 1;
  }
  return result;
}

function extractHeaders(sheet: { data?: any }): string[] {
  const cellData = sheet.data?.cellData;
  if (!cellData) return [];
  const maxRows = Math.min(5, Object.keys(cellData).length);
  for (let r = 0; r < maxRows; r++) {
    const row = cellData[String(r)];
    if (!row) continue;
    const vals = Object.values(row).map((c: any) => String(c?.v || c?.m || '').trim()).filter(Boolean);
    if (vals.length >= 2) return vals;
  }
  return [];
}

export function getWorkbookSummary(workbook: Workbook): ToolResult<WorkbookSummary> {
  try {
    const sheets: SheetMeta[] = (workbook.sheets ?? []).map((s) => {
      const det = detectSheetType(s);
      return {
        id: s.id,
        name: s.name,
        type: det.sheetType,
        confidence: det.confidence,
        matchedRules: det.matchedRules,
        rowCount: s.data?.rowCount ?? Object.keys(s.data?.cellData ?? {}).length,
        colCount: s.data?.columnCount ?? 0,
        headers: extractHeaders(s),
      };
    });
    return { tool: 'getWorkbookSummary', ok: true, data: { name: workbook.name, sheets } };
  } catch (err) {
    return { tool: 'getWorkbookSummary', ok: false, data: { name: workbook.name, sheets: [] }, error: (err as Error).message };
  }
}

export function getSheetSummary(workbook: Workbook, sheetId: string): ToolResult<SheetSummary> {
  try {
    const sheet = (workbook.sheets ?? []).find((s) => s.id === sheetId);
    if (!sheet) return { tool: 'getSheetSummary', ok: false, data: null as any, error: `Sheet ${sheetId} not found` };

    const det = detectSheetType(sheet);
    const cellData = sheet.data?.cellData ?? {};
    const sampleRows: Record<string, Record<string, any>> = {};
    const rowKeys = Object.keys(cellData).slice(0, 20);
    rowKeys.forEach((rKey) => {
      const row = cellData[rKey];
      if (!row) return;
      const cols: Record<string, any> = {};
      Object.keys(row).forEach((cKey) => {
        cols[cKey] = row[cKey]?.v ?? row[cKey]?.m ?? '';
      });
      sampleRows[rKey] = cols;
    });

    return {
      tool: 'getSheetSummary',
      ok: true,
      data: {
        id: sheet.id,
        name: sheet.name,
        type: det.sheetType,
        confidence: det.confidence,
        matchedRules: det.matchedRules,
        rowCount: sheet.data?.rowCount ?? Object.keys(cellData).length,
        colCount: sheet.data?.columnCount ?? 0,
        headers: extractHeaders(sheet),
        sampleRows,
      },
    };
  } catch (err) {
    return { tool: 'getSheetSummary', ok: false, data: null as any, error: (err as Error).message };
  }
}

export function searchWorkbook(workbook: Workbook, query: string): ToolResult<SearchMatch[]> {
  try {
    const lq = query.toLowerCase();
    const matches: SearchMatch[] = [];

    for (const sheet of workbook.sheets ?? []) {
      if (matches.length >= 30) break;
      const cellData = sheet.data?.cellData ?? {};
      for (const rKey of Object.keys(cellData)) {
        if (matches.length >= 30) break;
        const row = cellData[rKey];
        if (!row) continue;
        for (const cKey of Object.keys(row)) {
          if (matches.length >= 30) break;
          const val = String(row[cKey]?.v ?? row[cKey]?.m ?? '').trim();
          if (val.toLowerCase().includes(lq)) {
            const colIdx = Number(cKey);
            const rowNum = Number(rKey) + 1;
            matches.push({
              sheetId: sheet.id,
              sheetName: sheet.name,
              rowKey: rKey,
              colKey: cKey,
              cellAddress: `${colIndexToLetter(colIdx)}${rowNum}`,
              value: val,
            });
          }
        }
      }
    }

    return { tool: 'searchWorkbook', ok: true, data: matches };
  } catch (err) {
    return { tool: 'searchWorkbook', ok: false, data: [], error: (err as Error).message };
  }
}

export function runReviewTools(workbook: Workbook): ToolResult<{
  duplicates: DuplicateRow[][];
  outliers: OutlierPrice[];
  missingPrices: MissingPrice[];
  formulaErrors: FormulaError[];
  totalFindings: number;
}> {
  try {
    const duplicates = (workbook.sheets ?? []).map((s) => findDuplicateRowsInSheet(s));
    const materials = getMaterialsFromWorkbook(workbook);
    const outliers = detectOutlierPrices(materials);
    const missingPrices = detectMissingPrices(workbook);
    const formulaErrors = detectFormulaErrors(workbook);
    const totalFindings = duplicates.flat().length + outliers.length + missingPrices.length + formulaErrors.length;

    return { tool: 'runReviewTools', ok: true, data: { duplicates, outliers, missingPrices, formulaErrors, totalFindings } };
  } catch (err) {
    return {
      tool: 'runReviewTools', ok: false,
      data: { duplicates: [], outliers: [], missingPrices: [], formulaErrors: [], totalFindings: 0 },
      error: (err as Error).message,
    };
  }
}
