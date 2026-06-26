import { Injectable } from '@nestjs/common';
import type { DrawingParserInterface } from './drawing-parser.interface';
import { PdfParserService } from './pdf-parser.service';
import { DxfParserService } from './dxf-parser.service';

@Injectable()
export class DrawingParserFactory {
  private parsers: DrawingParserInterface[];

  constructor(
    private readonly pdf: PdfParserService,
    private readonly dxf: DxfParserService,
  ) {
    // Registration order = priority (first match wins)
    this.parsers = [this.dxf, this.pdf];
  }

  /** Resolve parser for a file extension. Throws if unsupported. */
  resolve(ext: string): DrawingParserInterface {
    const parser = this.parsers.find((p) =>
      p.supportedExtensions.includes(ext.toLowerCase().replace('.', ''))
    );
    if (!parser) throw new Error(`No parser for extension: ${ext}`);
    return parser;
  }

  supports(ext: string): boolean {
    return this.parsers.some((p) =>
      p.supportedExtensions.includes(ext.toLowerCase().replace('.', ''))
    );
  }
}
