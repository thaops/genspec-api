import { Sheet, Workbook, Material } from '../estimate.types';
import { syncWorkbookToSemantic } from '../semantic.layer';
import { detectSheetType } from '../rule-detector';

export interface DuplicateRow {
  rowKey: string;
  code: string;
  name: string;
}

export interface OutlierPrice {
  materialId: string;
  code: string;
  name: string;
  price: number;
  reason: string;
}

export interface MissingPrice {
  sheetId: string;
  rowKey: string;
  code: string;
  name: string;
  reason: string;
}

export interface FormulaError {
  sheetId: string;
  rowKey: string;
  colKey: string;
  cellAddress: string;
  errorValue: string;
}

export function getMaterialsFromWorkbook(workbook: Workbook): Material[] {
  const { materials } = syncWorkbookToSemantic(workbook);
  return materials;
}

export function findDuplicateRowsInSheet(sheet: Sheet): DuplicateRow[] {
  const cellData = sheet.data?.cellData;
  if (!cellData) return [];

  const { sheetType } = detectSheetType(sheet);
  if (sheetType === 'unknown') return [];

  const seen = new Map<string, string>();
  const duplicates: DuplicateRow[] = [];
  const rows = Object.keys(cellData);
  let codeCol = -1;
  let nameCol = -1;

  for (const rKey of rows) {
    const row = cellData[rKey];
    if (!row) continue;
    let hasHeader = false;
    Object.keys(row).forEach((cKey) => {
      const val = String(row[cKey]?.v || '').trim().toLowerCase();
      if (val.includes('mã') || val.includes('code')) { codeCol = Number(cKey); hasHeader = true; }
      if (val.includes('tên') || val.includes('name')) { nameCol = Number(cKey); hasHeader = true; }
    });
    if (hasHeader) break;
  }

  if (codeCol === -1 || nameCol === -1) return [];

  rows.forEach((rKey) => {
    const row = cellData[rKey];
    if (!row) return;
    const code = String(row[String(codeCol)]?.v || '').trim();
    const name = String(row[String(nameCol)]?.v || '').trim();
    if (code) {
      if (seen.has(code)) duplicates.push({ rowKey: rKey, code, name });
      else seen.set(code, rKey);
    }
  });

  return duplicates;
}

export function detectOutlierPrices(materials: Material[]): OutlierPrice[] {
  const outliers: OutlierPrice[] = [];
  if (materials.length === 0) return outliers;

  materials.forEach((m) => {
    if (m.price <= 0) {
      outliers.push({ materialId: m.id, code: m.code, name: m.name, price: m.price, reason: 'Đơn giá bằng 0 hoặc âm' });
    }
  });

  const xmMaterials = materials.filter((m) => m.name.toLowerCase().includes('xi măng'));
  if (xmMaterials.length > 0) {
    const xmPrices = xmMaterials.map((m) => m.price).filter((p) => p > 0);
    if (xmPrices.length > 0) {
      const avg = xmPrices.reduce((s, p) => s + p, 0) / xmPrices.length;
      xmMaterials.forEach((m) => {
        if (m.price > avg * 2.5) {
          outliers.push({
            materialId: m.id, code: m.code, name: m.name, price: m.price,
            reason: `Giá cao bất thường so với trung bình xi măng (${Math.round(avg).toLocaleString()} VND)`,
          });
        }
      });
    }
  }

  return outliers;
}

function findPriceCol(cellData: Record<string, any>, headerRowIdx: number): number {
  const headerRow = cellData[String(headerRowIdx)];
  if (!headerRow) return -1;
  for (const cKey of Object.keys(headerRow)) {
    const val = String(headerRow[cKey]?.v || '').trim().toLowerCase();
    if (val.includes('giá') || val.includes('price') || val.includes('rate') || val.includes('đơn giá')) {
      return Number(cKey);
    }
  }
  return -1;
}

function findHeaderRow(cellData: Record<string, any>): { rowIdx: number; codeCol: number; nameCol: number } {
  const rows = Object.keys(cellData);
  for (const rKey of rows) {
    const row = cellData[rKey];
    if (!row) continue;
    let codeCol = -1, nameCol = -1;
    Object.keys(row).forEach((cKey) => {
      const val = String(row[cKey]?.v || '').trim().toLowerCase();
      if (val.includes('mã') || val.includes('code')) codeCol = Number(cKey);
      if (val.includes('tên') || val.includes('name')) nameCol = Number(cKey);
    });
    if (codeCol !== -1 && nameCol !== -1) return { rowIdx: Number(rKey), codeCol, nameCol };
  }
  return { rowIdx: -1, codeCol: -1, nameCol: -1 };
}

export function detectMissingPrices(workbook: Workbook): MissingPrice[] {
  const results: MissingPrice[] = [];
  for (const sheet of workbook.sheets ?? []) {
    const { sheetType } = detectSheetType(sheet);
    if (sheetType !== 'material' && sheetType !== 'labor' && sheetType !== 'equipment') continue;
    const cellData = sheet.data?.cellData;
    if (!cellData) continue;

    const { rowIdx, codeCol, nameCol } = findHeaderRow(cellData);
    if (rowIdx === -1) continue;
    const priceCol = findPriceCol(cellData, rowIdx);
    if (priceCol === -1) continue;

    Object.keys(cellData).forEach((rKey) => {
      if (Number(rKey) <= rowIdx) return;
      const row = cellData[rKey];
      if (!row) return;
      const code = String(row[String(codeCol)]?.v || '').trim();
      const name = String(row[String(nameCol)]?.v || '').trim();
      if (!code && !name) return;
      const priceCell = row[String(priceCol)];
      const priceVal = priceCell?.v;
      if (priceVal === undefined || priceVal === null || priceVal === '') {
        results.push({ sheetId: sheet.id, rowKey: rKey, code, name, reason: 'Giá trống' });
      } else if (Number(priceVal) === 0) {
        results.push({ sheetId: sheet.id, rowKey: rKey, code, name, reason: 'Giá bằng 0' });
      }
    });
  }
  return results;
}

const FORMULA_ERROR_PATTERN = /^#(REF!|VALUE!|N\/A|DIV\/0!|NAME\?|NUM!|NULL!)/;

function colIndexToLetter(idx: number): string {
  let result = '';
  let n = idx;
  while (n >= 0) {
    result = String.fromCharCode(65 + (n % 26)) + result;
    n = Math.floor(n / 26) - 1;
  }
  return result;
}

export function detectFormulaErrors(workbook: Workbook): FormulaError[] {
  const results: FormulaError[] = [];
  for (const sheet of workbook.sheets ?? []) {
    const cellData = sheet.data?.cellData;
    if (!cellData) continue;
    Object.keys(cellData).forEach((rKey) => {
      const row = cellData[rKey];
      if (!row) return;
      Object.keys(row).forEach((cKey) => {
        const cell = row[cKey];
        const val = String(cell?.v ?? cell?.m ?? '').trim();
        if (FORMULA_ERROR_PATTERN.test(val)) {
          const colIdx = Number(cKey);
          const rowNum = Number(rKey) + 1; // Excel is 1-indexed
          results.push({
            sheetId: sheet.id,
            rowKey: rKey,
            colKey: cKey,
            cellAddress: `${colIndexToLetter(colIdx)}${rowNum}`,
            errorValue: val,
          });
        }
      });
    });
  }
  return results;
}
