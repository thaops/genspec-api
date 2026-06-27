import { Injectable, Logger } from '@nestjs/common';
import { PDFParse } from 'pdf-parse';
import * as fs from 'fs';
import type {
  DrawingParserInterface,
  DrawingParseResult,
  ParsedPage,
  RawEntity,
} from './drawing-parser.interface';

@Injectable()
export class PdfParserService implements DrawingParserInterface {
  readonly supportedExtensions = ['pdf', 'image', 'png', 'jpg', 'jpeg'];
  private readonly logger = new Logger(PdfParserService.name);

  async parse(filePath: string): Promise<DrawingParseResult> {
    const isUrl = filePath.startsWith('http://') || filePath.startsWith('https://');
    const parser = isUrl
      ? new PDFParse({ url: filePath })
      : new PDFParse({ data: fs.readFileSync(filePath) });

    try {
      const info = await parser.getInfo({ parsePageInfo: true });
      const numPages = info.total ?? 1;

      const pageTexts: string[] = [];
      for (let i = 1; i <= numPages; i++) {
        try {
          const res = await parser.getText({ partial: [i] });
          pageTexts.push((res.text ?? '').replace(/\s+/g, ' ').trim());
        } catch {
          pageTexts.push('');
        }
      }

      const pages: ParsedPage[] = pageTexts.map((text, i) => {
        const pageInfo = info.pages?.[i];
        const width  = pageInfo?.width  ?? 841;
        const height = pageInfo?.height ?? 594;
        const labels = this.extractLabels(text);
        const dims   = this.extractDimensions(text);

        const entities: RawEntity[] = [
          ...labels.map((label) => ({
            type: 'TEXT', layer: 'PDF', x: 0, y: 0,
            text: label, page: i + 1, properties: { label },
          })),
          ...dims.map((dim) => ({
            type: 'DIMENSION', layer: 'PDF', x: 0, y: 0,
            text: dim, page: i + 1, properties: { dimension: dim },
          })),
        ];

        return { pageNumber: i + 1, width, height, text, entities };
      });

      this.logger.log(`PDF parsed: ${numPages} pages`);
      return {
        pages,
        layers: [{ name: 'PDF', visible: true }],
        extMin: { x: 0, y: 0 },
        extMax: { x: 841, y: 594 },
        metadata: info.info ?? {},
        parserVersion: 'pdf-parse@2',
      };
    } finally {
      await parser.destroy().catch(() => {});
    }
  }

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

  extractLabels(text: string): string[] {
    const pattern = /\b[A-Z]{1,4}-?\d{1,3}\b/g;
    return Array.from(new Set(text.match(pattern) ?? []));
  }
}
