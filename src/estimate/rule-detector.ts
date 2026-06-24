import { Sheet } from './estimate.types';

export interface SheetDetectionResult {
  sheetType: 'boq' | 'material' | 'unknown';
  confidence: number;
}

export function detectSheetType(sheet: Sheet): SheetDetectionResult {
  const cellData = sheet.data?.cellData;
  if (!cellData) {
    return { sheetType: 'unknown', confidence: 0 };
  }

  const headers: string[] = [];
  const maxRowsToScan = Math.min(10, Object.keys(cellData).length);

  for (let r = 0; r < maxRowsToScan; r++) {
    const row = cellData[String(r)];
    if (!row) continue;

    const rowValues: string[] = [];
    Object.keys(row).forEach((c) => {
      const cell = row[c];
      const val = String(cell?.v || cell?.m || '').trim().toLowerCase();
      if (val) {
        rowValues.push(val);
      }
    });

    const hasCode = rowValues.some((v) => v.includes('mã') || v.includes('hiệu') || v.includes('code'));
    const hasName = rowValues.some((v) => v.includes('tên') || v.includes('nội dung') || v.includes('name'));
    const hasUnit = rowValues.some((v) => v.includes('đơn vị') || v.includes('dvt') || v.includes('unit'));
    const hasPrice = rowValues.some((v) => v.includes('giá') || v.includes('rate') || v.includes('price'));
    const hasQty = rowValues.some((v) => v.includes('khối lượng') || v.includes('qty') || v.includes('quantity'));

    if (hasCode && hasName && hasUnit) {
      if (hasQty && hasPrice) {
        return { sheetType: 'boq', confidence: 0.95 };
      }
      if (hasPrice && !hasQty) {
        return { sheetType: 'material', confidence: 0.9 };
      }
    }
  }

  return { sheetType: 'unknown', confidence: 0 };
}
