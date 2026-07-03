import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { NormItem, PriceItem, PriceSet } from './catalog-db.schemas';
import {
  HeaderDetection,
  ParsedNormItem,
  ParsedPriceItem,
  parseNormWorkbook,
  parsePriceWorkbook,
} from './catalog-import.parser';

export interface ImportSummary {
  inserted: number;
  updated: number;
  skipped: number;
  errors: string[];
}

export interface ImportPreview<T> {
  dryRun: true;
  header: HeaderDetection | null;
  detectedColumns: string[];
  total: number;
  preview: T[]; // 100 dòng đầu đã map
  errors: string[];
}

@Injectable()
export class CatalogImportService {
  private readonly logger = new Logger(CatalogImportService.name);

  constructor(
    @InjectModel(NormItem.name) private readonly norms: Model<NormItem>,
    @InjectModel(PriceSet.name) private readonly priceSets: Model<PriceSet>,
    @InjectModel(PriceItem.name) private readonly priceItems: Model<PriceItem>,
  ) {}

  async importNorms(
    buffer: Buffer,
    sourceDoc: string,
    dryRun: boolean,
  ): Promise<ImportSummary | ImportPreview<ParsedNormItem>> {
    const parsed = await parseNormWorkbook(buffer);
    if (!parsed.header) throw new BadRequestException(parsed.errors[0] ?? 'Không đọc được file định mức');

    if (dryRun) {
      return {
        dryRun: true,
        header: parsed.header,
        detectedColumns: Object.keys(parsed.header.columns),
        total: parsed.items.length,
        preview: parsed.items.slice(0, 100),
        errors: parsed.errors,
      };
    }

    const summary: ImportSummary = { inserted: 0, updated: 0, skipped: 0, errors: [...parsed.errors] };
    for (const item of parsed.items) {
      if (!item.code || !item.name) {
        summary.skipped++;
        continue;
      }
      try {
        const res = await this.norms.updateOne(
          { code: item.code },
          { $set: { ...item, sourceDoc: sourceDoc || 'unknown', importedAt: new Date() } },
          { upsert: true },
        );
        if (res.upsertedCount) summary.inserted++;
        else if (res.modifiedCount) summary.updated++;
        else summary.skipped++;
      } catch (err) {
        summary.errors.push(`${item.code}: ${(err as Error).message}`);
      }
    }
    this.logger.log(`import-norms (${sourceDoc}): +${summary.inserted} ~${summary.updated}`);
    return summary;
  }

  async importPrices(
    buffer: Buffer,
    meta: { province: string; effectiveDate: string; sourceDoc?: string },
    dryRun: boolean,
  ): Promise<ImportSummary | ImportPreview<ParsedPriceItem>> {
    if (!meta.province?.trim()) throw new BadRequestException('Thiếu field "province"');
    const effectiveDate = new Date(meta.effectiveDate);
    if (isNaN(effectiveDate.getTime())) throw new BadRequestException('effectiveDate không hợp lệ (ISO date)');

    const parsed = await parsePriceWorkbook(buffer);
    if (!parsed.header) throw new BadRequestException(parsed.errors[0] ?? 'Không đọc được file giá');

    if (dryRun) {
      return {
        dryRun: true,
        header: parsed.header,
        detectedColumns: Object.keys(parsed.header.columns),
        total: parsed.items.length,
        preview: parsed.items.slice(0, 100),
        errors: parsed.errors,
      };
    }

    const province = meta.province.trim();
    const set = await this.priceSets.findOneAndUpdate(
      { province, effectiveDate },
      { $set: { sourceDoc: meta.sourceDoc ?? '', importedAt: new Date() } },
      { upsert: true, new: true },
    );
    const priceSetId = set._id as Types.ObjectId;
    const existing = await this.priceItems.countDocuments({ priceSetId });
    await this.priceItems.deleteMany({ priceSetId });

    const docs = parsed.items.map((p) => ({ ...p, priceSetId }));
    if (docs.length) await this.priceItems.insertMany(docs);

    this.logger.log(`import-prices ${province} ${meta.effectiveDate}: ${docs.length} items (replaced ${existing})`);
    return {
      inserted: docs.length,
      updated: existing,
      skipped: 0,
      errors: parsed.errors,
    };
  }
}
