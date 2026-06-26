import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { DrawingIndex, DrawingIndexDocument } from '../schemas/drawing-index.schema';
import type { DetectedObject } from './drawing-detector.service';
import type { ParsedPage } from '../parsers/drawing-parser.interface';

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
    layers: Array<{ name: string }> = [],
    pages: ParsedPage[] = [],
  ): Promise<number> {
    await this.indexModel.deleteMany({ drawingId });

    const entries: Partial<DrawingIndex>[] = [];

    for (const obj of objects) {
      const kind = obj.rawType === 'DIMENSION' ? 'dimension'
        : obj.rawType === 'TEXT' || obj.rawType === 'MTEXT' ? 'text'
        : obj.rawType === 'INSERT' ? 'block' : 'object';
      entries.push({
        drawingId,
        pageNumber: obj.boundingBox.page ?? 1,
        kind,
        value: [obj.objectType, obj.layer, obj.text].filter(Boolean).join(' '),
        objectId: obj.stableId,
        boundingBox: obj.boundingBox,
      });
    }

    for (const layer of layers) {
      entries.push({ drawingId, pageNumber: 1, kind: 'layer', value: layer.name });
    }

    for (const page of pages) {
      for (const token of this.tokenize(page.text)) {
        entries.push({ drawingId, pageNumber: page.pageNumber, kind: 'text', value: token });
      }
    }

    if (entries.length > 0) await this.indexModel.insertMany(entries, { ordered: false });
    this.logger.log(`Index: ${entries.length} entries for ${drawingId}`);
    return entries.length;
  }

  async search(drawingId: string, query: string, limit = 40) {
    if (!query.trim()) return [];
    return this.indexModel
      .find({ drawingId, value: { $regex: query.trim(), $options: 'i' } })
      .sort({ kind: 1 })
      .limit(limit)
      .lean();
  }

  private tokenize(text: string): string[] {
    const tokens = new Set<string>();
    for (const m of text.match(/\b[A-Z]{1,4}-?\d{1,3}\b/g) ?? []) tokens.add(m);
    for (const m of text.match(/\b\d{3,5}\b/g) ?? []) tokens.add(m);
    for (const m of text.match(/\b[BCDb]\s*\d+\s*[xX×]\s*\d+/g) ?? []) tokens.add(m.trim());
    for (const m of text.match(/\b(dầm|cột|tường|sàn|móng|cọc|mái|thang)\b/gi) ?? []) tokens.add(m.toLowerCase());
    return Array.from(tokens).slice(0, 100);
  }
}
