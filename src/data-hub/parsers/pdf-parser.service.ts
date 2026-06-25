import { Injectable, Logger } from '@nestjs/common';

export interface ParsedDocument {
  text: string;
  pageCount: number;
  /** Catalog codes detected in the document */
  catalogCodes: ExtractedCode[];
  /** Price rows detected (bang gia) */
  priceRows: ExtractedPriceRow[];
}

export interface ExtractedCode {
  code: string;
  name: string;
  unit?: string;
  material?: number;
  labor?: number;
  machine?: number;
}

export interface ExtractedPriceRow {
  materialName: string;
  unit: string;
  price: number;
  province?: string;
  effectiveDate?: string;
}

// Mã hiệu: starts with 2 capital letters followed by dot and digits, e.g. AB.25322, AF.11111
const CODE_REGEX = /\b([A-Z]{2}\.\d{4,6})\b/g;
const PRICE_REGEX = /(\d{1,3}(?:[.,]\d{3})*)\s*(đồng|VNĐ|VND|đ)?/gi;

@Injectable()
export class PdfParserService {
  private readonly logger = new Logger(PdfParserService.name);

  async parse(buffer: Buffer, sourceId?: string): Promise<ParsedDocument> {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const pdfParse = require('pdf-parse') as (buf: Buffer) => Promise<{ text: string; numpages: number }>;
      const data = await pdfParse(buffer);
      const text = data.text ?? '';
      const catalogCodes = this.extractCodes(text);
      const priceRows = this.extractPriceRows(text, sourceId);
      return { text, pageCount: data.numpages ?? 0, catalogCodes, priceRows };
    } catch (err) {
      this.logger.error(`PDF parse failed: ${(err as Error).message}`);
      return { text: '', pageCount: 0, catalogCodes: [], priceRows: [] };
    }
  }

  private extractCodes(text: string): ExtractedCode[] {
    const matches: ExtractedCode[] = [];
    const seen = new Set<string>();
    const lines = text.split('\n');
    for (const line of lines) {
      const m = line.match(CODE_REGEX);
      if (!m) continue;
      for (const code of m) {
        if (seen.has(code)) continue;
        seen.add(code);
        const nameRaw = line.replace(code, '').replace(/\d+[.,]\d+/g, '').trim();
        const name = nameRaw.slice(0, 120).trim();
        matches.push({ code, name });
      }
    }
    return matches;
  }

  private extractPriceRows(text: string, province?: string): ExtractedPriceRow[] {
    const rows: ExtractedPriceRow[] = [];
    const lines = text.split('\n');
    for (const line of lines) {
      const pm = line.match(PRICE_REGEX);
      if (!pm) continue;
      const price = parseVietnameseNumber(pm[0]);
      if (price < 1000) continue;
      const materialName = line.replace(pm[0], '').trim().slice(0, 200);
      if (!materialName) continue;
      rows.push({ materialName, unit: 'đồng', price, province });
    }
    return rows;
  }
}

function parseVietnameseNumber(s: string): number {
  return parseFloat(s.replace(/\./g, '').replace(',', '.').replace(/[^\d.]/g, '')) || 0;
}
