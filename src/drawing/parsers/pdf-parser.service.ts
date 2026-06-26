import { Injectable, Logger } from '@nestjs/common';
import * as pdfParse from 'pdf-parse';
import * as fs from 'fs';

export interface RawPdfPage {
  pageNumber: number;
  text: string;
  width: number;
  height: number;
}

export interface RawPdfResult {
  pages: RawPdfPage[];
  metadata: Record<string, unknown>;
}

/**
 * Extracts raw text + page metadata from PDF.
 * Does NOT classify objects — DrawingDetectorService handles that.
 */
@Injectable()
export class PdfParserService {
  private readonly logger = new Logger(PdfParserService.name);

  async parse(filePath: string): Promise<RawPdfResult> {
    const buffer = fs.readFileSync(filePath);
    const pageTexts: string[] = [];

    const data = await pdfParse(buffer, {
      // Capture per-page text via pagerender hook
      pagerender: (pageData: any) =>
        pageData.getTextContent().then((tc: any) => {
          const text = tc.items
            .map((item: any) => item.str)
            .join(' ')
            .replace(/\s+/g, ' ')
            .trim();
          pageTexts.push(text);
          return text;
        }),
    });

    const pages: RawPdfPage[] = Array.from({ length: data.numpages }, (_, i) => ({
      pageNumber: i + 1,
      text: pageTexts[i] ?? '',
      width: 841,   // A1 default; override when viewport info available
      height: 594,
    }));

    this.logger.log(`PDF parsed: ${data.numpages} pages`);
    return { pages, metadata: data.info ?? {} };
  }

  /** Structural dimension patterns: "3500", "B300x600", "Ø16a200" */
  extractDimensions(text: string): string[] {
    const patterns = [
      /\b\d{3,5}\b/g,
      /\b\d+\.?\d*\s*[Mm]\b/g,
      /\b[BCDb]\s*\d+\s*[xX×]\s*\d+/g,
      /\bHW?\s*\d+\b/gi,
      /\bФ?\d+\s*[aA]\s*\d+/g,
    ];
    const dims = new Set<string>();
    for (const p of patterns) {
      for (const m of text.match(p) ?? []) dims.add(m.trim());
    }
    return Array.from(dims);
  }

  /** Object label patterns: "C-1", "B12", "W3" */
  extractLabels(text: string): string[] {
    const pattern = /\b[A-Z]{1,4}-?\d{1,3}\b/g;
    return Array.from(new Set(text.match(pattern) ?? []));
  }
}
