import { Injectable } from '@nestjs/common';
import * as ExcelJS from 'exceljs';
import { CostSummary, ProjectInfo } from './estimate.types';

interface TmdtInput {
  name: string;
  projectInfo: ProjectInfo;
  costSummary: CostSummary;
}

const MONEY = '#,##0';

function thin(): Partial<ExcelJS.Borders> {
  const s: ExcelJS.Border = { style: 'thin', color: { argb: 'FF9CA3AF' } };
  return { top: s, left: s, bottom: s, right: s };
}

/**
 * Bảng TỔNG MỨC ĐẦU TƯ (TT 11/2021). Chi phí xây dựng (Gxd) lấy THẬT từ costSummary;
 * các cấu phần khác (thiết bị, QLDA, tư vấn, GPMB, khác) từ projectInfo.tmdt —
 * QS nhập, TRỐNG thì để "—" (KHÔNG bịa số). Dự phòng = % trên tổng I..VI nếu có.
 */
@Injectable()
export class ExportTmdtService {
  async build(e: TmdtInput): Promise<Buffer> {
    const wb = new ExcelJS.Workbook();
    wb.creator = 'GenSpec';
    const ws = wb.addWorksheet('TMDT');
    ws.columns = [
      { key: 'stt', width: 6 },
      { key: 'item', width: 48 },
      { key: 'sym', width: 10 },
      { key: 'value', width: 22 },
    ];

    const p = e.projectInfo;
    const t = p.tmdt ?? {};
    const gxd = Math.round(e.costSummary?.total ?? 0);

    const info = (label: string, value?: string | number) => {
      const r = ws.addRow({ item: `${label}: ${value ?? ''}` });
      ws.mergeCells(`A${r.number}:D${r.number}`);
    };
    info('Công trình', p.name || e.name);
    info('Địa điểm', p.location);
    info('Chủ đầu tư', p.investor);
    ws.addRow([]);

    const title = ws.addRow({ item: 'TỔNG MỨC ĐẦU TƯ XÂY DỰNG' });
    ws.mergeCells(`A${title.number}:D${title.number}`);
    title.getCell(1).value = 'TỔNG MỨC ĐẦU TƯ XÂY DỰNG';
    title.font = { bold: true, size: 14 };
    title.alignment = { horizontal: 'center' };
    const unit = ws.addRow({ item: 'Đơn vị tính: VNĐ' });
    ws.mergeCells(`A${unit.number}:D${unit.number}`);
    unit.getCell(1).value = 'Đơn vị tính: VNĐ';
    unit.font = { italic: true, size: 10 };
    unit.alignment = { horizontal: 'right' };
    ws.addRow([]);

    const head = ws.addRow({ stt: 'STT', item: 'KHOẢN MỤC CHI PHÍ', sym: 'KÝ HIỆU', value: 'GIÁ TRỊ (VNĐ)' });
    head.font = { bold: true };
    head.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    head.eachCell((c) => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8EEF7' } }; c.border = thin(); });

    // value=null → hiển thị "—" (chưa nhập, không bịa)
    const add = (stt: string, item: string, sym: string, value: number | null, bold = false) => {
      const r = ws.addRow({ stt, item, sym, value: value ?? '—' });
      if (typeof value === 'number') r.getCell('value').numFmt = MONEY;
      r.getCell('stt').alignment = { horizontal: 'center' };
      r.getCell('sym').alignment = { horizontal: 'center' };
      r.getCell('value').alignment = { horizontal: 'right' };
      if (bold) r.font = { bold: true };
      r.eachCell((c) => (c.border = thin()));
      return r;
    };

    const num = (v?: number) => (typeof v === 'number' ? v : null);
    add('I', 'Chi phí xây dựng', 'Gxd', gxd, true);
    add('II', 'Chi phí thiết bị', 'Gtb', num(t.equipment));
    add('III', 'Chi phí quản lý dự án', 'Gqlda', num(t.management));
    add('IV', 'Chi phí tư vấn đầu tư xây dựng', 'Gtv', num(t.consulting));
    add('V', 'Chi phí bồi thường, hỗ trợ và tái định cư (GPMB)', 'Gbt', num(t.land));
    add('VI', 'Chi phí khác', 'Gk', num(t.other));

    const sub = gxd + (t.equipment ?? 0) + (t.management ?? 0) + (t.consulting ?? 0) + (t.land ?? 0) + (t.other ?? 0);
    add('', 'Cộng (I + II + III + IV + V + VI)', '', Math.round(sub), true);

    // VII. Dự phòng (nếu có %)
    const hasDp = typeof t.contingencyPct === 'number' && t.contingencyPct > 0;
    const dp = hasDp ? Math.round(sub * (t.contingencyPct as number) / 100) : 0;
    if (hasDp) add('VII', `Chi phí dự phòng (${String(t.contingencyPct).replace('.', ',')}%)`, 'Gdp', dp);

    const total = add('', 'TỔNG MỨC ĐẦU TƯ', 'V', Math.round(sub + dp), true);
    total.eachCell((c) => (c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDCE6F1' } }));

    // Ghi chú minh bạch nếu các cấu phần chưa nhập
    const missing = ['equipment', 'management', 'consulting', 'land', 'other'].filter((k) => (t as any)[k] == null);
    if (missing.length) {
      ws.addRow([]);
      const n = ws.addRow({ item: '* Các cấu phần chưa nhập được để trống (—). Bổ sung ở thông tin dự án để hoàn thiện TMĐT.' });
      ws.mergeCells(`A${n.number}:D${n.number}`);
      n.font = { italic: true, size: 10, color: { argb: 'FF9A6A00' } };
    }

    const out = await wb.xlsx.writeBuffer();
    return Buffer.from(out as ArrayBuffer);
  }
}
