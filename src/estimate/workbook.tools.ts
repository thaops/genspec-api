import { Sheet, Workbook, Material } from './estimate.types';
import { syncWorkbookToSemantic } from './semantic.layer';
import { detectSheetType } from './rule-detector';

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
      if (val.includes('mã') || val.includes('code')) {
        codeCol = Number(cKey);
        hasHeader = true;
      }
      if (val.includes('tên') || val.includes('name')) {
        nameCol = Number(cKey);
        hasHeader = true;
      }
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
      if (seen.has(code)) {
        duplicates.push({ rowKey: rKey, code, name });
      } else {
        seen.set(code, rKey);
      }
    }
  });

  return duplicates;
}

export function detectOutlierPrices(materials: Material[]): OutlierPrice[] {
  const outliers: OutlierPrice[] = [];
  if (materials.length === 0) return outliers;

  materials.forEach((m) => {
    if (m.price <= 0) {
      outliers.push({
        materialId: m.id,
        code: m.code,
        name: m.name,
        price: m.price,
        reason: 'Đơn giá bằng 0 hoặc âm',
      });
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
            materialId: m.id,
            code: m.code,
            name: m.name,
            price: m.price,
            reason: `Giá cao bất thường so với trung bình xi măng (${Math.round(avg).toLocaleString()} VND)`,
          });
        }
      });
    }
  }

  return outliers;
}
