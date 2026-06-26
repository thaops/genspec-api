import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { DrawingIndex, DrawingIndexDocument } from '../schemas/drawing-index.schema';
import type { DetectedObject } from './drawing-detector.service';
import type { RawPdfPage } from '../parsers/pdf-parser.service';
import type { DxfLayer } from '../parsers/dxf-parser.service';

/**
 * Builds the search index (drawing_index collection) from parsed/detected data.
 * Called after detection completes — never directly by controller.
 *
 * Index kinds:
 *   object    — each detected DrawingObject (searchable by label/type)
 *   text      — TEXT/MTEXT entities (annotations, notes)
 *   dimension — DIMENSION entities + PDF dimension strings
 *   layer     — layer names
 *   block     — INSERT block references
 */
@Injectable()
export class DrawingIndexerService {
  private readonly logger = new Logger(DrawingIndexerService.name);

  constructor(
    @InjectModel(DrawingIndex.name)
    private indexModel: Model<DrawingIndexDocument>,
  ) {}

  async buildIndex(
    drawingId: string,
    objects: DetectedObject[],
    layers?: DxfLayer[],
    pdfPages?: RawPdfPage[],
  ): Promise<number> {
    // Clear stale index for this drawing
    await this.indexModel.deleteMany({ drawingId });

    const entries: Partial<DrawingIndex>[] = [];

    // Objects
    for (const obj of objects) {
      const value = [obj.objectType, obj.layer, obj.text].filter(Boolean).join(' ');
      entries.push({
        drawingId,
        pageNumber: obj.boundingBox.page ?? 1,
        kind: obj.rawType === 'DIMENSION' ? 'dimension'
          : obj.rawType === 'TEXT' || obj.rawType === 'MTEXT' ? 'text'
          : obj.rawType === 'INSERT' ? 'block'
          : 'object',
        value,
        objectId: obj.stableId,
        boundingBox: obj.boundingBox,
      });
    }

    // Layer names
    for (const layer of layers ?? []) {
      entries.push({
        drawingId,
        pageNumber: 1,
        kind: 'layer',
        value: layer.name,
      });
    }

    // PDF page full text (for free-text search)
    for (const page of pdfPages ?? []) {
      // Index significant tokens from page text
      const tokens = this.tokenize(page.text);
      for (const token of tokens) {
        entries.push({
          drawingId,
          pageNumber: page.pageNumber,
          kind: 'text',
          value: token,
        });
      }
    }

    if (entries.length > 0) {
      await this.indexModel.insertMany(entries, { ordered: false });
    }

    this.logger.log(`Index built: ${entries.length} entries for drawing ${drawingId}`);
    return entries.length;
  }

  /** Full-text search — returns entries ordered by relevance */
  async search(drawingId: string, query: string, limit = 40) {
    const q = query.trim();
    if (!q) return [];
    return this.indexModel
      .find({
        drawingId,
        value: { $regex: q, $options: 'i' },
      })
      .sort({ kind: 1 })
      .limit(limit)
      .lean();
  }

  /** Extract meaningful tokens: labels, dimension strings, code-like words */
  private tokenize(text: string): string[] {
    const tokens = new Set<string>();
    // Structural labels: C12, B-3, SL1
    for (const m of text.match(/\b[A-Z]{1,4}-?\d{1,3}\b/g) ?? []) tokens.add(m);
    // Dimensions: "3500", "B300x600"
    for (const m of text.match(/\b\d{3,5}\b/g) ?? []) tokens.add(m);
    for (const m of text.match(/\b[BCDb]\s*\d+\s*[xX×]\s*\d+/g) ?? []) tokens.add(m.trim());
    // Vietnamese keywords
    for (const m of text.match(/\b(dầm|cột|tường|sàn|móng|cọc|mái|thang)\b/gi) ?? []) {
      tokens.add(m.toLowerCase());
    }
    return Array.from(tokens).slice(0, 100); // cap per page
  }
}
