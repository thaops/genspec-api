import { Injectable, Logger } from '@nestjs/common';
import * as ExcelJS from 'exceljs';
import { Readable } from 'stream';

export interface ExcelPriceRow {
  rowIndex: number;
  sheetName: string;
  code?: string;
  name: string;
  unit: string;
  price: number;
  material?: number;
  labor?: number;
  machine?: number;
}

@Injectable()
export class ExcelParserService {
  private readonly logger = new Logger(ExcelParserService.name);

  async parsePriceList(buffer: Buffer): Promise<ExcelPriceRow[]> {
    const rows: ExcelPriceRow[] = [];
    const workbook = new ExcelJS.Workbook();
    try {
      await workbook.xlsx.load(buffer as any);
    } catch {
      try {
        await workbook.csv.read(Readable.from(buffer));
      } catch (e) {
        this.logger.error(`Excel parse failed: ${(e as Error).message}`);
        return rows;
      }
    }

    workbook.eachSheet((sheet) => {
      sheet.eachRow((row, rowNumber) => {
        if (rowNumber < 2) return;
        const vals = row.values as any[];
        if (!vals || vals.length < 3) return;

        const v = (i: number) => {
          const c = vals[i];
          if (c == null) return '';
          if (typeof c === 'object' && 'result' in c) return String(c.result ?? '');
          if (typeof c === 'object' && 'richText' in c)
            return (c.richText as any[]).map((r) => r.text).join('');
          return String(c);
        };
        const num = (i: number) => {
          const n = parseFloat(v(i).replace(/[,. ]/g, '').replace(/\D+$/, ''));
          return isNaN(n) ? 0 : n;
        };

        const name = v(2) || v(3);
        if (!name || name.length < 2) return;
        const unit = v(3) || v(4) || '';
        const price = num(4) || num(5) || num(6);
        if (price === 0) return;

        const codeCandidate = v(1);
        const code = /^[A-Z]{2}\.\d{4,6}$/.test(codeCandidate) ? codeCandidate : undefined;

        rows.push({
          rowIndex: rowNumber,
          sheetName: sheet.name,
          code,
          name: name.trim().slice(0, 200),
          unit: unit.trim().slice(0, 20),
          price,
          material: num(4) || undefined,
          labor: num(5) || undefined,
          machine: num(6) || undefined,
        });
      });
    });

    this.logger.log(`Excel parsed: ${rows.length} price rows`);
    return rows;
  }
}
