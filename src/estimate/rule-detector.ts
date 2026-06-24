import { Sheet } from './estimate.types';

export type SheetType = 'boq' | 'material' | 'labor' | 'equipment' | 'analysis' | 'takeoff' | 'summary' | 'unknown';

export interface SheetDetectionResult {
  sheetType: SheetType;
  confidence: number;
  matchedRules: string[];
}

function extractHeaderValues(sheet: Sheet): string[] {
  const cellData = sheet.data?.cellData;
  if (!cellData) return [];
  const maxRows = Math.min(15, Object.keys(cellData).length);
  const values: string[] = [];
  for (let r = 0; r < maxRows; r++) {
    const row = cellData[String(r)];
    if (!row) continue;
    Object.values(row).forEach((cell: any) => {
      const v = String(cell?.v || cell?.m || '').trim().toLowerCase();
      if (v) values.push(v);
    });
  }
  return values;
}

function hasCol(values: string[], ...keywords: string[]): boolean {
  return keywords.some((kw) => values.some((v) => v.includes(kw)));
}

export function detectSheetType(sheet: Sheet): SheetDetectionResult {
  const cellData = sheet.data?.cellData;
  if (!cellData) return { sheetType: 'unknown', confidence: 0, matchedRules: [] };

  const vals = extractHeaderValues(sheet);
  const sheetName = sheet.name?.toLowerCase() ?? '';

  const rules: Record<string, boolean> = {
    has_code_col: hasCol(vals, 'mã', 'hiệu', 'code'),
    has_name_col: hasCol(vals, 'tên', 'nội dung', 'name'),
    has_unit_col: hasCol(vals, 'đơn vị', 'dvt', 'unit'),
    has_qty_col: hasCol(vals, 'khối lượng', 'qty', 'quantity'),
    has_amount_col: hasCol(vals, 'thành tiền', 'amount', 'giá trị'),
    has_price_col: hasCol(vals, 'đơn giá', 'giá', 'rate', 'price'),
    no_qty_col: !hasCol(vals, 'khối lượng', 'qty', 'quantity'),
    has_dayrate_col: hasCol(vals, 'nhân công', 'công', 'lương', 'dayrate', 'ngày'),
    has_grade_col: hasCol(vals, 'bậc', 'grade', 'thợ'),
    has_shiftrate_col: hasCol(vals, 'ca máy', 'ca', 'shift'),
    has_norm_col: hasCol(vals, 'định mức', 'hao phí', 'norm', 'hệ số'),
    has_dim_col: hasCol(vals, 'dài', 'rộng', 'cao', 'length', 'width', 'height'),
    has_count_col: hasCol(vals, 'số lượng', 'count'),
    has_total_col: hasCol(vals, 'tổng', 'total', 'cộng'),
    has_summary_keyword: hasCol(vals, 'tổng hợp', 'kinh phí', 'chi phí', 'cost summary') ||
      sheetName.includes('tổng') || sheetName.includes('summary') || sheetName.includes('tổng hợp'),
  };

  const matched = (keys: string[]) => keys.filter((k) => rules[k]);

  // boq: code + name + unit + qty + amount
  const boqKeys = ['has_code_col', 'has_name_col', 'has_unit_col', 'has_qty_col', 'has_amount_col'];
  if (boqKeys.every((k) => rules[k])) {
    return { sheetType: 'boq', confidence: 0.95, matchedRules: matched(boqKeys) };
  }

  // material: code + name + unit + price + no_qty
  const matKeys = ['has_code_col', 'has_name_col', 'has_unit_col', 'has_price_col', 'no_qty_col'];
  if (matKeys.every((k) => rules[k])) {
    return { sheetType: 'material', confidence: 0.9, matchedRules: matched(matKeys) };
  }

  // labor: name + dayrate + grade
  const laborKeys = ['has_name_col', 'has_dayrate_col', 'has_grade_col'];
  if (laborKeys.every((k) => rules[k])) {
    return { sheetType: 'labor', confidence: 0.88, matchedRules: matched(laborKeys) };
  }

  // equipment: code + name + shiftrate
  const equipKeys = ['has_code_col', 'has_name_col', 'has_shiftrate_col'];
  if (equipKeys.every((k) => rules[k])) {
    return { sheetType: 'equipment', confidence: 0.87, matchedRules: matched(equipKeys) };
  }

  // analysis: code + name + norm + unit
  const analysisKeys = ['has_code_col', 'has_name_col', 'has_norm_col', 'has_unit_col'];
  if (analysisKeys.every((k) => rules[k])) {
    return { sheetType: 'analysis', confidence: 0.85, matchedRules: matched(analysisKeys) };
  }

  // takeoff: code + name + (dim or count) + qty
  const takeoffBase = ['has_code_col', 'has_name_col', 'has_qty_col'];
  const hasDimOrCount = rules['has_dim_col'] || rules['has_count_col'];
  if (takeoffBase.every((k) => rules[k]) && hasDimOrCount) {
    const keys = [...takeoffBase, rules['has_dim_col'] ? 'has_dim_col' : 'has_count_col'];
    return { sheetType: 'takeoff', confidence: 0.85, matchedRules: matched(keys) };
  }

  // summary: total + summary_keyword
  const summaryKeys = ['has_total_col', 'has_summary_keyword'];
  if (summaryKeys.every((k) => rules[k])) {
    return { sheetType: 'summary', confidence: 0.80, matchedRules: matched(summaryKeys) };
  }

  return { sheetType: 'unknown', confidence: 0, matchedRules: [] };
}
