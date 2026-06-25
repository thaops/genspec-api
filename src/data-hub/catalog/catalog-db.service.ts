import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { CatalogCode } from './catalog-code.schema';
import { CATALOG } from '../../catalog/catalog.seed';

@Injectable()
export class CatalogDbService implements OnModuleInit {
  private readonly logger = new Logger(CatalogDbService.name);

  constructor(
    @InjectModel(CatalogCode.name) private readonly model: Model<CatalogCode>,
  ) {}

  async onModuleInit() {
    const count = await this.model.countDocuments();
    if (count === 0) await this.seedFromLegacy();
  }

  // ── Suggest API queries ─────────────────────────────────────────────────

  async suggest(q: string, limit = 10): Promise<CatalogCode[]> {
    if (!q?.trim()) {
      return this.model.find({ active: true }).limit(limit).lean().exec() as any;
    }

    // Code prefix takes priority
    const codePrefix = q.toUpperCase();
    const byCode = await this.model
      .find({ code: { $regex: `^${escapeRegex(codePrefix)}`, $options: 'i' }, active: true })
      .limit(limit)
      .lean()
      .exec();

    if (byCode.length >= limit) return byCode as any;

    // Full-text search for remaining slots
    const byText = await this.model
      .find(
        { $text: { $search: normalize(q) }, active: true },
        { score: { $meta: 'textScore' } },
      )
      .sort({ score: { $meta: 'textScore' } })
      .limit(limit - byCode.length)
      .lean()
      .exec();

    const seen = new Set(byCode.map((c: any) => String(c._id)));
    const merged = [...byCode, ...byText.filter((c: any) => !seen.has(String(c._id)))];
    return merged as any;
  }

  async findByCode(code: string): Promise<CatalogCode | null> {
    return this.model.findOne({ code: code.toUpperCase(), active: true }).lean().exec() as any;
  }

  async searchKeyword(keyword: string, limit = 20): Promise<CatalogCode[]> {
    return this.model
      .find(
        { $text: { $search: normalize(keyword) }, active: true },
        { score: { $meta: 'textScore' } },
      )
      .sort({ score: { $meta: 'textScore' } })
      .limit(limit)
      .lean()
      .exec() as any;
  }

  async upsertFromParsed(items: Partial<CatalogCode>[], sourceId: string) {
    let upserted = 0;
    for (const item of items) {
      if (!item.code) continue;
      await this.model.updateOne(
        { code: item.code.toUpperCase(), sourceId },
        { $set: { ...item, sourceId, active: true } },
        { upsert: true },
      );
      upserted++;
    }
    this.logger.log(`Upserted ${upserted} catalog codes from source ${sourceId}`);
    return upserted;
  }

  // ── Seed ────────────────────────────────────────────────────────────────

  private async seedFromLegacy() {
    const docs = CATALOG.map((c) => ({
      code: c.code.toUpperCase(),
      name: c.name,
      unit: c.unit,
      group: c.group,
      material: c.material,
      labor: c.labor,
      machine: c.machine,
      sourceId: 'seed',
      trust: 50,
      active: true,
    }));
    await this.model.insertMany(docs, { ordered: false }).catch(() => {});
    this.logger.log(`Seeded ${docs.length} catalog codes from legacy data`);
  }
}

function escapeRegex(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalize(s: string) {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd');
}
