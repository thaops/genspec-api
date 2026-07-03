import { Injectable } from '@nestjs/common';
import * as ExcelJS from 'exceljs';
import { CostSummary, Markups, ProjectInfo } from './estimate.types';

interface ThdtInput {
  name: string;
  projectInfo: ProjectInfo;
  markups: Markups;
  costSummary: CostSummary;
}

const MONEY = '#,##0';

// Format a markup percent the Vietnamese way: 6.5 -> "6,5%"
function pct(p: number): string {
  return `${String(p).replace('.', ',')}%`;
}

function thin(): Partial<ExcelJS.Borders> {
  const s: ExcelJS.Border = { style: 'thin', color: { argb: 'FF9CA3AF' } };
  return { top: s, left: s, bottom: s, right: s };
}

@Injectable()
export class ExportThdtService {
  async build(e: ThdtInput): Promise<Buffer> {
    const wb = new ExcelJS.Workbook();
    wb.creator = 'GenSpec';
    const ws = wb.addWorksheet('THDT');
    ws.columns = [
      { key: 'stt', width: 6 },
      { key: 'item', width: 46 },
      { key: 'sym', width: 10 },
      { key: 'calc', width: 26 },
      { key: 'value', width: 20 },
    ];

    const p = e.projectInfo;
    const c = e.costSummary;
    const m = e.markups;

    // ---- Header block ----
    const info = (label: string, value?: string | number) => {
      const r = ws.addRow({ stt: '', item: `${label}: ${value ?? ''}` });
      ws.mergeCells(`A${r.number}:E${r.number}`);
      r.getCell('stt').alignment = { horizontal: 'left' };
    };
    info('Công trình', p.name || e.name);
    info('Hạng mục', p.buildingType);
    info('Địa điểm', p.location);
    ws.addRow([]);

    const title = ws.addRow({ item: 'BẢNG TỔNG HỢP DỰ TOÁN CHI PHÍ XÂY DỰNG' });
    ws.mergeCells(`A${title.number}:E${title.number}`);
    title.getCell(1).value = 'BẢNG TỔNG HỢP DỰ TOÁN CHI PHÍ XÂY DỰNG';
    title.font = { bold: true, size: 14 };
    title.alignment = { horizontal: 'center' };

    const unit = ws.addRow({ item: 'Đơn vị tính: VNĐ' });
    ws.mergeCells(`A${unit.number}:E${unit.number}`);
    unit.getCell(1).value = 'Đơn vị tính: VNĐ';
    unit.font = { italic: true, size: 10 };
    unit.alignment = { horizontal: 'right' };
    ws.addRow([]);

    // ---- Table head ----
    const head = ws.addRow({
      stt: 'STT',
      item: 'KHOẢN MỤC CHI PHÍ',
      sym: 'KÝ HIỆU',
      calc: 'CÁCH TÍNH',
      value: 'GIÁ TRỊ (VNĐ)',
    });
    head.font = { bold: true };
    head.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    head.eachCell((cell) => {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8EEF7' } };
      cell.border = thin();
    });

    const add = (
      stt: string,
      item: string,
      sym: string,
      calc: string,
      value: number,
      bold = false,
    ) => {
      const r = ws.addRow({ stt, item, sym, calc, value });
      r.getCell('value').numFmt = MONEY;
      r.getCell('stt').alignment = { horizontal: 'center' };
      r.getCell('sym').alignment = { horizontal: 'center' };
      r.getCell('item').alignment = { wrapText: true };
      if (bold) r.font = { bold: true };
      r.eachCell((cell) => (cell.border = thin()));
      return r;
    };

    // Which markup-driven lines actually exist (never invent a missing rate).
    const hasOverhead = m.overheadPct != null;
    const hasProfit = m.profitPct != null;
    const hasVat = m.vatPct != null;
    const hasContingency = m.contingencyPct != null;

    // I. Direct costs
    add('I', 'CHI PHÍ TRỰC TIẾP', 'T', 'VL + NC + M', c.directTotal, true);
    add('1', 'Chi phí vật liệu', 'VL', '', c.directMaterial);
    add('2', 'Chi phí nhân công', 'NC', '', c.directLabor);
    add('3', 'Chi phí máy thi công', 'M', '', c.directMachine);

    // II. Indirect costs (only from real markups)
    if (hasOverhead) {
      add('II', 'CHI PHÍ GIÁN TIẾP', 'GT', '', c.overhead, true);
      add('1', 'Chi phí chung', 'C', `T × ${pct(m.overheadPct)}`, c.overhead);
    }
    const profitBase = hasOverhead ? '(T + GT)' : 'T';

    // III. Pre-calculated taxable income
    if (hasProfit) {
      add('III', 'THU NHẬP CHỊU THUẾ TÍNH TRƯỚC', 'TL', `${profitBase} × ${pct(m.profitPct)}`, c.profit, true);
    }

    // IV. Pre-tax total
    const preTaxParts = ['T', ...(hasOverhead ? ['GT'] : []), ...(hasProfit ? ['TL'] : [])];
    add('IV', 'CHI PHÍ XÂY DỰNG TRƯỚC THUẾ', 'G', preTaxParts.join(' + '), c.preTax, true);

    // V. VAT
    if (hasVat) {
      add('V', 'THUẾ GIÁ TRỊ GIA TĂNG', 'GTGT', `G × ${pct(m.vatPct)}`, c.vat, true);
    }

    // VI. Contingency (per boq.engine: on after-tax value)
    if (hasContingency) {
      const base = hasVat ? '(G + GTGT)' : 'G';
      add('VI', 'CHI PHÍ DỰ PHÒNG', 'DP', `${base} × ${pct(m.contingencyPct)}`, c.contingency, true);
    }

    // Grand total
    const totalParts = ['G', ...(hasVat ? ['GTGT'] : []), ...(hasContingency ? ['DP'] : [])];
    const total = add('', 'TỔNG CỘNG', 'GXD', totalParts.join(' + '), Math.round(c.total), true);
    total.eachCell((cell) => {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDCE6F1' } };
    });

    // ---- Signatures ----
    ws.addRow([]);
    const date = ws.addRow({ calc: p.dateCreated ? `Ngày lập: ${p.dateCreated}` : '' });
    date.getCell('calc').alignment = { horizontal: 'center' };
    const sig = ws.addRow({ item: 'NGƯỜI LẬP', calc: 'NGƯỜI CHỦ TRÌ' });
    sig.font = { bold: true };
    sig.getCell('item').alignment = { horizontal: 'center' };
    sig.getCell('calc').alignment = { horizontal: 'center' };
    ws.addRow([]);
    ws.addRow([]);
    ws.addRow([]);
    const names = ws.addRow({ item: p.preparedBy ?? '', calc: '' });
    names.getCell('item').alignment = { horizontal: 'center' };

    const out = await wb.xlsx.writeBuffer();
    return Buffer.from(out as ArrayBuffer);
  }
}
