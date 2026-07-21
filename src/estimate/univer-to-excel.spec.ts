import * as ExcelJS from 'exceljs';
import { excelToUniverSheets } from './excel-to-univer';
import { univerSheetsToExcel, univerSheetsToXlsxBuffer } from './univer-to-excel';

/** Dựng workbook "công ty" với style/formula/merge/width/hidden/freeze thật. */
function buildSourceWorkbook(): ExcelJS.Workbook {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('BẢNG KL CÔNG TY');

  ws.getColumn(1).width = 6;
  ws.getColumn(3).width = 40;
  ws.getColumn(5).hidden = true;
  ws.getRow(1).height = 30;

  const headers = ['TT', 'MÃ CÔNG TÁC', 'DIỄN GIẢI CÔNG VIỆC', 'ĐVT', 'KL', 'ĐƠN GIÁ', 'THÀNH TIỀN'];
  headers.forEach((h, i) => {
    const c = ws.getCell(1, i + 1);
    c.value = h;
    c.font = { bold: true, size: 13, name: 'Times New Roman', color: { argb: 'FFFFFFFF' } };
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F4E79' } };
    c.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
    c.border = {
      top: { style: 'thin', color: { argb: 'FF000000' } },
      bottom: { style: 'medium', color: { argb: 'FF000000' } },
      left: { style: 'thin', color: { argb: 'FF000000' } },
      right: { style: 'thin', color: { argb: 'FF000000' } },
    };
  });

  ws.getCell('A2').value = 1;
  ws.getCell('B2').value = 'AB.11413';
  ws.getCell('C2').value = 'Đào móng bằng thủ công';
  ws.getCell('D2').value = 'm³';
  ws.getCell('E2').value = 45.2;
  ws.getCell('F2').value = 250000;
  ws.getCell('F2').numFmt = '#,##0';
  ws.getCell('G2').value = { formula: 'E2*F2', result: 11300000 };
  ws.getCell('G2').numFmt = '#,##0';

  ws.getCell('A3').value = 2;
  ws.getCell('C3').value = 'Bê tông lót móng';
  ws.getCell('E3').value = 12.8;
  ws.getCell('C3').font = { italic: true, color: { argb: 'FFC00000' } };

  ws.mergeCells('A5:C5');
  ws.getCell('A5').value = 'CỘNG';
  ws.getCell('A5').alignment = { horizontal: 'right' };

  ws.views = [{ state: 'frozen', xSplit: 0, ySplit: 1 }];
  return wb;
}

/** import → export → import lại, so sánh vòng 1 với vòng 2. */
async function roundTrip() {
  const first = excelToUniverSheets(buildSourceWorkbook());
  const sheets = first.sheets.map((s, i) =>
    i === 0 ? { ...s, data: { ...s.data, _styles: first.styles } } : s,
  );
  const buffer = await univerSheetsToXlsxBuffer(sheets);
  const reloaded = new ExcelJS.Workbook();
  await reloaded.xlsx.load(buffer as unknown as ArrayBuffer);
  return { first, second: excelToUniverSheets(reloaded), reloaded };
}

const styleOf = (r: any, sheetIdx: number, row: number, col: number) => {
  const sid = r.sheets[sheetIdx].data.cellData?.[String(row)]?.[String(col)]?.s;
  return sid ? r.styles[sid] : undefined;
};

describe('univerSheetsToExcel — round-trip giữ nguyên Workbook của user', () => {
  it('giữ tên sheet, giá trị và formula', async () => {
    const { first, second } = await roundTrip();
    expect(second.sheets[0].name).toBe(first.sheets[0].name);
    const a = first.sheets[0].data.cellData;
    const b = second.sheets[0].data.cellData;
    expect(b['1']['2'].v).toBe('Đào móng bằng thủ công');
    expect(b['1']['4'].v).toBe(45.2);
    expect(b['1']['6'].f).toBe(a['1']['6'].f);
    expect(b['1']['6'].f).toBe('=E2*F2');
  });

  it('giữ nền, font, border, align, number format của header', async () => {
    const { first, second } = await roundTrip();
    const s1 = styleOf(first, 0, 0, 0);
    const s2 = styleOf(second, 0, 0, 0);
    expect(s2.bg).toEqual(s1.bg);
    expect(s2.bg.rgb).toBe('#1F4E79');
    expect(s2.cl.rgb).toBe('#FFFFFF');
    expect(s2.bl).toBe(1);
    expect(s2.fs).toBe(13);
    expect(s2.ff).toBe('Times New Roman');
    expect(s2.ht).toBe(2);
    expect(s2.vt).toBe(2);
    expect(s2.tb).toBe(3);
    expect(s2.bd.b.s).toBe(s1.bd.b.s);
    expect(styleOf(second, 0, 1, 5).n.pattern).toBe('#,##0');
    expect(styleOf(second, 0, 2, 2)).toMatchObject({ it: 1, cl: { rgb: '#C00000' } });
  });

  it('giữ merge, freeze, column width, hidden column, row height', async () => {
    const { first, second } = await roundTrip();
    expect(second.sheets[0].data.mergeData).toEqual(
      expect.arrayContaining([{ startRow: 4, startColumn: 0, endRow: 4, endColumn: 2 }]),
    );
    expect(second.sheets[0].data.freeze).toEqual(first.sheets[0].data.freeze);
    expect(second.sheets[0].data.columnData['2'].w).toBe(first.sheets[0].data.columnData['2'].w);
    expect(second.sheets[0].data.columnData['4'].hd).toBe(1);
    expect(second.sheets[0].data.rowData['0'].h).toBe(first.sheets[0].data.rowData['0'].h);
  });

  it('không tạo thêm sheet nào ngoài sheet của user', async () => {
    const { reloaded } = await roundTrip();
    expect(reloaded.worksheets.map((w) => w.name)).toEqual(['BẢNG KL CÔNG TY']);
  });

  it('style inline (không qua registry) vẫn được ghi', () => {
    const wb = univerSheetsToExcel([
      {
        name: 'S',
        data: { cellData: { '0': { '0': { v: 'x', s: { bl: 1, bg: { rgb: '#FF0000' } } } } } },
      },
    ]);
    const cell = wb.getWorksheet('S')!.getCell('A1');
    expect(cell.font?.bold).toBe(true);
    expect((cell.fill as any).fgColor.argb).toBe('FFFF0000');
  });
});
