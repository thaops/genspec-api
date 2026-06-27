import { Injectable, Logger } from '@nestjs/common';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const _pdfMod = require('pdf-parse');
const pdfParse: (buf: Buffer, opts?: any) => Promise<any> =
  typeof _pdfMod === 'function' ? _pdfMod : (_pdfMod.default ?? _pdfMod);
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
    const buffer = fs.readFileSync(filePath);
    const pageTexts: string[] = [];

    const data = await pdfParse(buffer, {
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

    const pages: ParsedPage[] = Array.from({ length: data.numpages }, (_, i) => {
      const text = pageTexts[i] ?? '';
      const labels = this.extractLabels(text);
      const dims   = this.extractDimensions(text);

      // Each label/dim becomes a RawEntity for the normalizer
      const entities: RawEntity[] = [
        ...labels.map((label) => ({
          type: 'TEXT',
          layer: 'PDF',
          x: 0, y: 0,
          text: label,
          page: i + 1,
          properties: { label },
        })),
        ...dims.map((dim) => ({
          type: 'DIMENSION',
          layer: 'PDF',
          x: 0, y: 0,
          text: dim,
          page: i + 1,
          properties: { dimension: dim },
        })),
      ];

      return {
        pageNumber: i + 1,
        width: 841,
        height: 594,
        text,
        entities,
      };
    });

    this.logger.log(`PDF parsed: ${data.numpages} pages`);
    return {
      pages,
      layers: [{ name: 'PDF', visible: true }],
      extMin: { x: 0, y: 0 },
      extMax: { x: 841, y: 594 },
      metadata: data.info ?? {},
      parserVersion: 'pdf-parse@1',
    };
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
