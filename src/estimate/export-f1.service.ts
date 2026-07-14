import { Injectable } from '@nestjs/common';
import * as ExcelJS from 'exceljs';
import {
  BoqRow,
  CostSummary,
  Equipment,
  Labor,
  Markups,
  Material,
  MaterialSummaryRow,
  ProjectInfo,
  TakeoffItem,
  UnitPriceAnalysis,
} from './estimate.types';

interface ExportInput {
  name: string;
  projectInfo: ProjectInfo;
  takeoff: TakeoffItem[];
  analyses: UnitPriceAnalysis[];
  materials: Material[];
  labor: Labor[];
  equipment: Equipment[];
  markups: Markups;
  boq: BoqRow[];
  materialSummary: MaterialSummaryRow[];
  costSummary: CostSummary;
}

const MONEY = '#,##0';
const QTY = '#,##0.###';

@Injectable()
export class ExportF1Service {
  async build(e: ExportInput): Promise<Buffer> {
    const wb = new ExcelJS.Workbook();
    wb.creator = 'GenSpec';

    this.projectInfo(wb, e);
    this.takeoffSheet(wb, e);
    this.boqSheet(wb, e);
    this.rebarScheduleSheet(wb, e);
    this.analysisSheet(wb, e);
    this.materialPrice(wb, e);
    this.laborPrice(wb, e);
    this.equipmentPrice(wb, e);
    this.materialSummary(wb, e);
    this.materialDiffSheet(wb, e);
    this.costSummary(wb, e);

    const out = await wb.xlsx.writeBuffer();
    return Buffer.from(out as ArrayBuffer);
  }

  private head(ws: ExcelJS.Worksheet, title: string, span: string) {
    ws.spliceRows(1, 0, [title]);
    ws.mergeCells(span);
    ws.getCell('A1').font = { bold: true, size: 13 };
    ws.getCell('A1').alignment = { horizontal: 'center' };
    const h = ws.getRow(2);
    h.font = { bold: true };
    h.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    h.eachCell((c) => {
      c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8EEF7' } };
      c.border = thin();
    });
  }

  private projectInfo(wb: ExcelJS.Workbook, e: ExportInput) {
    const ws = wb.addWorksheet('01_ThongTinCT');
    ws.columns = [{ key: 'k', width: 26 }, { key: 'v', width: 50 }];
    const p = e.projectInfo;
    const rows: [string, unknown][] = [
      ['Tên công trình', p.name || e.name],
      ['Loại công trình', p.buildingType],
      ['Số tầng', p.floors],
      ['Diện tích', p.area],
      ['Địa điểm', p.location],
      ['Chủ đầu tư', p.investor],
      ['Người lập', p.preparedBy],
      ['Ngày lập', p.dateCreated],
      ['Phiên bản định mức', p.normVersion],
      ['Phiên bản đơn giá', p.priceVersion],
      ['Ghi chú', p.note],
    ];
    ws.spliceRows(1, 0, ['THÔNG TIN CÔNG TRÌNH']);
    ws.mergeCells('A1:B1');
    ws.getCell('A1').font = { bold: true, size: 14 };
    ws.getCell('A1').alignment = { horizontal: 'center' };
    rows.forEach(([k, v]) => {
      const r = ws.addRow({ k, v: v ?? '' });
      r.getCell('k').font = { bold: true };
      r.eachCell((c) => (c.border = thin()));
    });
  }

  private takeoffSheet(wb: ExcelJS.Workbook, e: ExportInput) {
    const ws = wb.addWorksheet('02_BocTachKL');
    ws.columns = [
      { header: 'STT', key: 'stt', width: 6 },
      { header: 'Hạng mục', key: 'group', width: 18 },
      { header: 'Mã hiệu', key: 'code', width: 14 },
      { header: 'Công tác', key: 'name', width: 38 },
      { header: 'ĐV', key: 'unit', width: 7 },
      { header: 'Dài', key: 'length', width: 9 },
      { header: 'Rộng', key: 'width', width: 9 },
      { header: 'Cao', key: 'height', width: 9 },
      { header: 'SL', key: 'count', width: 7 },
      { header: 'Công thức', key: 'formula', width: 22 },
      { header: 'Khối lượng', key: 'quantity', width: 13 },
    ];
    this.head(ws, 'BẢNG BÓC TÁCH KHỐI LƯỢNG', 'A1:K1');

    // Group take-off rows by hạng mục, with a subtotal per group.
    const groups = new Map<string, typeof e.takeoff>();
    for (const t of e.takeoff ?? []) {
      const g = t.group || 'Khác';
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g)!.push(t);
    }
    let stt = 0;
    for (const [group, items] of groups) {
      const gr = ws.addRow({ group });
      gr.font = { bold: true };
      gr.getCell('group').value = group;
      gr.eachCell((c) => (c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF2F4F8' } }));
      for (const t of items) {
        stt++;
        const r = ws.addRow({
          stt,
          group: '',
          code: t.code,
          name: t.name,
          unit: t.unit,
          length: t.length ?? '',
          width: t.width ?? '',
          height: t.height ?? '',
          count: t.count ?? '',
          formula: t.formula || this.derivedFormula(t),
          quantity: t.quantity,
        });
        ['length', 'width', 'height', 'count', 'quantity'].forEach((k) => (r.getCell(k).numFmt = QTY));
        r.getCell('name').alignment = { wrapText: true, vertical: 'top' };
        r.eachCell((c) => (c.border = thin()));
      }
    }
  }

  private derivedFormula(t: { length?: number; width?: number; height?: number; count?: number }): string {
    const parts = [t.length, t.width, t.height].filter((x) => x != null) as number[];
    if (!parts.length && t.count == null) return '';
    const dims = parts.join(' × ');
    return t.count != null ? (dims ? `${dims} × ${t.count}` : `${t.count}`) : dims;
  }

  private boqSheet(wb: ExcelJS.Workbook, e: ExportInput) {
    const ws = wb.addWorksheet('03_BOQ');
    ws.columns = [
      { header: 'STT', key: 'stt', width: 6 },
      { header: 'Mã hiệu', key: 'code', width: 14 },
      { header: 'Công tác', key: 'name', width: 40 },
      { header: 'Đơn vị', key: 'unit', width: 9 },
      { header: 'Khối lượng', key: 'quantity', width: 13 },
      { header: 'Đơn giá VL', key: 'material', width: 14 },
      { header: 'Đơn giá NC', key: 'labor', width: 14 },
      { header: 'Đơn giá Máy', key: 'machine', width: 14 },
      { header: 'Đơn giá', key: 'unitPrice', width: 15 },
      { header: 'Thành tiền', key: 'total', width: 17 },
    ];
    this.head(ws, 'BẢNG DỰ TOÁN CHI TIẾT (BOQ)', 'A1:J1');
    let grand = 0;
    (e.boq ?? []).forEach((b, i) => {
      // Đơn giá để trống (không phải 0) khi chưa có giá — tránh hiểu nhầm "miễn phí".
      const r = ws.addRow({
        stt: i + 1, code: b.code, name: b.name, unit: b.unit, quantity: b.quantity,
        material: b.material || null, labor: b.labor || null, machine: b.machine || null,
        unitPrice: b.unitPrice || null, total: b.total || null,
      });
      r.getCell('quantity').numFmt = QTY;
      for (const key of ['material', 'labor', 'machine', 'unitPrice', 'total']) r.getCell(key).numFmt = MONEY;
      r.eachCell((c) => (c.border = thin()));
      grand += b.total || 0;
    });
    // Dòng tổng cộng
    const totalRow = ws.addRow({ name: 'TỔNG CỘNG', total: grand || null });
    totalRow.font = { bold: true };
    totalRow.getCell('total').numFmt = MONEY;
    totalRow.eachCell((c) => (c.border = thin()));
  }

  /**
   * Bảng thống kê thép — chỉ sinh khi có dòng cốt thép (group "Cốt thép" hoặc
   * tên "Cốt thép Ø…" đơn vị kg, do RebarPanel thêm vào). KHÔNG bịa: chỉ tổng
   * hợp lại các dòng đã có trong takeoff.
   */
  private rebarScheduleSheet(wb: ExcelJS.Workbook, e: ExportInput) {
    const steel = (e.takeoff ?? []).filter(
      (t) => t.group === 'Cốt thép' || /c[ốô]t th[ée]p|thép\s*Ø|thep\s*O/i.test(t.name),
    );
    if (steel.length === 0) return; // không có thép → bỏ sheet

    const ws = wb.addWorksheet('10_ThongKeThep');
    ws.columns = [
      { header: 'STT', key: 'stt', width: 6 },
      { header: 'Đường kính', key: 'dia', width: 12 },
      { header: 'Cấu kiện / Diễn giải', key: 'name', width: 44 },
      { header: 'Đơn vị', key: 'unit', width: 8 },
      { header: 'Khối lượng', key: 'qty', width: 14 },
    ];
    this.head(ws, 'BẢNG THỐNG KÊ CỐT THÉP', 'A1:E1');
    let totalKg = 0;
    steel.forEach((t, i) => {
      const m = /Ø\s*(\d{1,2})/.exec(t.name);
      const r = ws.addRow({
        stt: i + 1,
        dia: m ? `Ø${m[1]}` : '',
        name: t.note ? `${t.name} — ${t.note}` : t.name,
        unit: t.unit || 'kg',
        qty: t.quantity || null,
      });
      r.getCell('qty').numFmt = QTY;
      r.eachCell((c) => (c.border = thin()));
      if ((t.unit || 'kg').toLowerCase() === 'kg') totalKg += t.quantity || 0;
    });
    const tr = ws.addRow({ name: 'TỔNG KHỐI LƯỢNG THÉP', unit: 'kg', qty: totalKg || null });
    tr.font = { bold: true };
    tr.getCell('qty').numFmt = QTY;
    tr.eachCell((c) => (c.border = thin()));
  }

  /**
   * Bảng bù/chênh lệch giá vật tư — so GIÁ HIỆN HÀNH (price) vs GIÁ GỐC tại thời điểm
   * lập (basePrice, chốt lần đầu). Thành tiền bù = (hiện − gốc) × khối lượng (từ THVT).
   * Chỉ sinh khi có vật tư đã chênh giá. KHÔNG bịa: dùng basePrice đã lưu.
   */
  private materialDiffSheet(wb: ExcelJS.Workbook, e: ExportInput) {
    const mats = (e.materials ?? []).filter(
      (m) => typeof m.basePrice === 'number' && m.basePrice !== m.price,
    );
    if (mats.length === 0) return;

    // Khối lượng vật tư từ tổng hợp vật tư (khớp theo ref/tên).
    const qtyOf = (m: { code: string; name: string }): number => {
      const key = (s: string) => (s ?? '').toLowerCase().trim();
      const hit = (e.materialSummary ?? []).find(
        (r) => r.kind === 'material' && (key(r.ref) === key(m.code) || key(r.name) === key(m.name)),
      );
      return hit?.quantity ?? 0;
    };

    const ws = wb.addWorksheet('11_BuGiaVatTu');
    ws.columns = [
      { header: 'STT', key: 'stt', width: 6 },
      { header: 'Vật tư', key: 'name', width: 34 },
      { header: 'ĐVT', key: 'unit', width: 8 },
      { header: 'Khối lượng', key: 'qty', width: 13 },
      { header: 'Giá gốc', key: 'base', width: 14 },
      { header: 'Giá hiện hành', key: 'cur', width: 14 },
      { header: 'Chênh đơn giá', key: 'diff', width: 14 },
      { header: 'Thành tiền bù', key: 'amount', width: 16 },
    ];
    this.head(ws, 'BẢNG BÙ CHÊNH LỆCH GIÁ VẬT TƯ', 'A1:H1');
    let totalBu = 0;
    mats.forEach((m, i) => {
      const base = m.basePrice as number;
      const diff = m.price - base;
      const qty = qtyOf(m);
      const amount = Math.round(diff * qty);
      totalBu += amount;
      const r = ws.addRow({
        stt: i + 1, name: m.name, unit: m.unit, qty: qty || null,
        base, cur: m.price, diff, amount: amount || null,
      });
      for (const k of ['qty']) r.getCell(k).numFmt = QTY;
      for (const k of ['base', 'cur', 'diff', 'amount']) r.getCell(k).numFmt = MONEY;
      r.eachCell((c) => (c.border = thin()));
    });
    const tr = ws.addRow({ name: 'TỔNG BÙ GIÁ', amount: totalBu || null });
    tr.font = { bold: true };
    tr.getCell('amount').numFmt = MONEY;
    tr.eachCell((c) => (c.border = thin()));
  }

  private analysisSheet(wb: ExcelJS.Workbook, e: ExportInput) {
    const ws = wb.addWorksheet('04_PhanTichDonGia');
    ws.columns = [
      { header: 'TP', key: 'kind', width: 12 },
      { header: 'Mã/Tên', key: 'ref', width: 34 },
      { header: 'ĐV', key: 'unit', width: 8 },
      { header: 'Định mức', key: 'norm', width: 12 },
      { header: 'Đơn giá', key: 'price', width: 14 },
      { header: 'Thành tiền', key: 'amount', width: 16 },
    ];
    this.head(ws, 'PHÂN TÍCH ĐƠN GIÁ', 'A1:F1');
    const priceOf = this.priceResolver(e);
    for (const a of e.analyses ?? []) {
      const title = ws.addRow({ kind: `${a.code}`, ref: `${a.name} (${a.unit})` });
      title.font = { bold: true };
      title.eachCell((c) => (c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF2F4F8' } }));
      let unitTotal = 0;
      for (const c of a.components ?? []) {
        const price = priceOf(c.kind, c.ref);
        const amount = Math.round(price * c.norm);
        unitTotal += amount;
        const r = ws.addRow({ kind: kindLabel(c.kind), ref: c.name || c.ref, unit: c.unit ?? '', norm: c.norm, price, amount });
        r.getCell('norm').numFmt = QTY;
        r.getCell('price').numFmt = MONEY;
        r.getCell('amount').numFmt = MONEY;
        r.eachCell((cell) => (cell.border = thin()));
      }
      const sum = ws.addRow({ ref: `Đơn giá ${a.code}`, amount: unitTotal });
      sum.font = { italic: true, bold: true };
      sum.getCell('amount').numFmt = MONEY;
    }
  }

  private materialPrice(wb: ExcelJS.Workbook, e: ExportInput) {
    const ws = wb.addWorksheet('05_GiaVatLieu');
    ws.columns = [
      { header: 'Mã', key: 'code', width: 12 },
      { header: 'Tên vật liệu', key: 'name', width: 36 },
      { header: 'ĐV', key: 'unit', width: 8 },
      { header: 'Đơn giá', key: 'price', width: 14 },
      { header: 'Nguồn giá', key: 'source', width: 34 },
    ];
    this.head(ws, 'BẢNG GIÁ VẬT LIỆU', 'A1:E1');
    (e.materials ?? []).forEach((m) => {
      const src = m.source ? [m.source.name, m.source.date, m.source.region].filter(Boolean).join(' · ') : '';
      const r = ws.addRow({ code: m.code, name: m.name, unit: m.unit, price: m.price, source: src });
      r.getCell('price').numFmt = MONEY;
      r.eachCell((c) => (c.border = thin()));
    });
  }

  private laborPrice(wb: ExcelJS.Workbook, e: ExportInput) {
    const ws = wb.addWorksheet('06_GiaNhanCong');
    ws.columns = [
      { header: 'Bậc thợ', key: 'grade', width: 12 },
      { header: 'Mô tả', key: 'name', width: 36 },
      { header: 'Lương ngày', key: 'dayRate', width: 16 },
    ];
    this.head(ws, 'BẢNG GIÁ NHÂN CÔNG', 'A1:C1');
    (e.labor ?? []).forEach((l) => {
      const r = ws.addRow({ grade: l.grade, name: l.name, dayRate: l.dayRate });
      r.getCell('dayRate').numFmt = MONEY;
      r.eachCell((c) => (c.border = thin()));
    });
  }

  private equipmentPrice(wb: ExcelJS.Workbook, e: ExportInput) {
    const ws = wb.addWorksheet('07_GiaCaMay');
    ws.columns = [
      { header: 'Mã', key: 'code', width: 12 },
      { header: 'Tên máy', key: 'name', width: 36 },
      { header: 'ĐV', key: 'unit', width: 8 },
      { header: 'Đơn giá ca', key: 'shiftRate', width: 16 },
    ];
    this.head(ws, 'BẢNG GIÁ CA MÁY', 'A1:D1');
    (e.equipment ?? []).forEach((q) => {
      const r = ws.addRow({ code: q.code, name: q.name, unit: q.unit, shiftRate: q.shiftRate });
      r.getCell('shiftRate').numFmt = MONEY;
      r.eachCell((c) => (c.border = thin()));
    });
  }

  private materialSummary(wb: ExcelJS.Workbook, e: ExportInput) {
    const ws = wb.addWorksheet('08_TongHopVatTu');
    ws.columns = [
      { header: 'Loại', key: 'kind', width: 12 },
      { header: 'Tên', key: 'name', width: 38 },
      { header: 'ĐV', key: 'unit', width: 8 },
      { header: 'Khối lượng', key: 'quantity', width: 14 },
      { header: 'Đơn giá', key: 'price', width: 14 },
      { header: 'Thành tiền', key: 'amount', width: 16 },
    ];
    this.head(ws, 'TỔNG HỢP VẬT TƯ', 'A1:F1');
    (e.materialSummary ?? []).forEach((m) => {
      const r = ws.addRow({ kind: kindLabel(m.kind), name: m.name, unit: m.unit, quantity: m.quantity, price: m.price, amount: m.amount });
      r.getCell('quantity').numFmt = QTY;
      r.getCell('price').numFmt = MONEY;
      r.getCell('amount').numFmt = MONEY;
      r.eachCell((c) => (c.border = thin()));
    });
  }

  private costSummary(wb: ExcelJS.Workbook, e: ExportInput) {
    const ws = wb.addWorksheet('09_TongHopKinhPhi');
    ws.columns = [
      { header: 'Khoản mục', key: 'k', width: 46 },
      { header: 'Cách tính', key: 'f', width: 24 },
      { header: 'Thành tiền', key: 'v', width: 20 },
    ];
    this.head(ws, 'TỔNG HỢP KINH PHÍ', 'A1:C1');
    const c = e.costSummary;
    const m = e.markups;
    const add = (k: string, v: number, f = '', bold = false) => {
      const r = ws.addRow({ k, f, v });
      r.getCell('v').numFmt = MONEY;
      if (bold) r.font = { bold: true };
      r.eachCell((cell) => (cell.border = thin()));
      return r;
    };
    add('A. CHI PHÍ TRỰC TIẾP', c.directTotal, '', true);
    add('   - Vật liệu', c.directMaterial);
    add('   - Nhân công', c.directLabor);
    add('   - Máy thi công', c.directMachine);
    add('B. Chi phí chung', c.overhead, `${m.overheadPct}% × A`);
    add('C. Thu nhập chịu thuế tính trước', c.profit, `${m.profitPct}% × (A+B)`);
    add('Cộng trước thuế (A+B+C)', c.preTax, '', true);
    add('D. Thuế VAT', c.vat, `${m.vatPct}%`);
    add('E. Dự phòng', c.contingency, `${m.contingencyPct}%`);
    const f = add('F. TỔNG CỘNG', c.total, '', true);
    f.eachCell((cell) => (cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDCE6F1' } }));
  }

  private priceResolver(e: ExportInput) {
    const key = (v: unknown) => (v ?? '').toString().toLowerCase();
    const mat = new Map((e.materials ?? []).map((m) => [key(m?.code), m?.price]));
    const lab = new Map((e.labor ?? []).map((l) => [key(l?.grade), l?.dayRate]));
    const eq = new Map((e.equipment ?? []).map((q) => [key(q?.code), q?.shiftRate]));
    return (kind: string, ref: string) => {
      const k = (ref ?? '').toLowerCase();
      if (kind === 'material') return mat.get(k) ?? 0;
      if (kind === 'labor') return lab.get(k) ?? 0;
      return eq.get(k) ?? 0;
    };
  }
}

function kindLabel(kind: string): string {
  return kind === 'material' ? 'Vật liệu' : kind === 'labor' ? 'Nhân công' : 'Máy';
}

function thin(): Partial<ExcelJS.Borders> {
  const s: ExcelJS.Border = { style: 'thin', color: { argb: 'FFCBD5E1' } };
  return { top: s, left: s, bottom: s, right: s };
}
