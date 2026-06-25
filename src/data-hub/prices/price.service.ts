import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { MaterialPrice } from './material-price.schema';
import { NormalizeService } from '../normalizers/normalize.service';

export interface PriceLatestResult {
  materialId: string;
  name: string;
  unit: string;
  price: number;
  province: string | null;
  effectiveDate: Date;
  sourceId: string;
  trust: number;
  documentNumber?: string;
}

export interface PriceCompareResult {
  materialId: string;
  name: string;
  unit: string;
  currentPrice: number;
  latestPrice: number;
  delta: number;
  deltaPercent: number;
  province: string | null;
  sourceId: string;
  effectiveDate: Date;
  recommendation: 'update' | 'ok' | 'check';
}

@Injectable()
export class PriceService {
  private readonly logger = new Logger(PriceService.name);

  constructor(
    @InjectModel(MaterialPrice.name) private readonly model: Model<MaterialPrice>,
    private readonly normalize: NormalizeService,
  ) {}

  /** Get the latest official price for a material in a province */
  async latest(materialId: string, province?: string): Promise<PriceLatestResult | null> {
    const filter: any = { materialId, active: true };
    if (province) filter.province = province;

    const doc = await this.model
      .findOne(filter)
      .sort({ trust: -1, effectiveDate: -1 })
      .lean()
      .exec();

    if (!doc) return null;

    return {
      materialId: (doc as any).materialId,
      name: (doc as any).name,
      unit: (doc as any).unit,
      price: (doc as any).price,
      province: (doc as any).province ?? null,
      effectiveDate: (doc as any).effectiveDate,
      sourceId: (doc as any).sourceId,
      trust: (doc as any).trust,
      documentNumber: (doc as any).documentNumber,
    };
  }

  /** Compare a list of {materialId, currentPrice} against latest official prices */
  async compare(
    items: Array<{ materialId: string; name: string; unit: string; currentPrice: number }>,
    province?: string,
  ): Promise<PriceCompareResult[]> {
    const results: PriceCompareResult[] = [];

    for (const item of items) {
      const latest = await this.latest(item.materialId, province);
      if (!latest) continue;

      const delta = latest.price - item.currentPrice;
      const deltaPercent = item.currentPrice > 0 ? (delta / item.currentPrice) * 100 : 0;

      let recommendation: 'update' | 'ok' | 'check' = 'ok';
      if (Math.abs(deltaPercent) > 10) recommendation = 'update';
      else if (Math.abs(deltaPercent) > 3) recommendation = 'check';

      results.push({
        materialId: item.materialId,
        name: item.name,
        unit: item.unit,
        currentPrice: item.currentPrice,
        latestPrice: latest.price,
        delta,
        deltaPercent: Math.round(deltaPercent * 10) / 10,
        province: latest.province,
        sourceId: latest.sourceId,
        effectiveDate: latest.effectiveDate,
        recommendation,
      });
    }

    return results;
  }

  /** Search prices by name keyword */
  async searchByName(name: string, province?: string, limit = 10): Promise<PriceLatestResult[]> {
    const filter: any = { active: true, $text: { $search: name } };
    if (province) filter.province = province;
    const docs = await this.model
      .find(filter, { score: { $meta: 'textScore' } })
      .sort({ score: { $meta: 'textScore' }, trust: -1, effectiveDate: -1 })
      .limit(limit)
      .lean()
      .exec();

    return docs.map((d: any) => ({
      materialId: d.materialId,
      name: d.name,
      unit: d.unit,
      price: d.price,
      province: d.province ?? null,
      effectiveDate: d.effectiveDate,
      sourceId: d.sourceId,
      trust: d.trust,
      documentNumber: d.documentNumber,
    }));
  }

  /** Bulk upsert from parsed Excel/PDF */
  async bulkUpsert(
    rows: Array<{
      name: string;
      unit: string;
      price: number;
      province?: string;
      effectiveDate: Date;
      sourceId: string;
      trust?: number;
      documentNumber?: string;
      category?: string;
    }>,
  ) {
    let upserted = 0;
    for (const row of rows) {
      const materialId = this.normalize.toMaterialId(row.name) ?? this.normalize.normalizeNameForMatch(row.name);
      await this.model.updateOne(
        { materialId, province: row.province ?? null, sourceId: row.sourceId, effectiveDate: row.effectiveDate },
        {
          $set: {
            name: row.name,
            unit: this.normalize.normalizeUnit(row.unit),
            price: row.price,
            category: row.category ?? 'material',
            trust: row.trust ?? 50,
            documentNumber: row.documentNumber,
            active: true,
          },
          $setOnInsert: { materialId },
        },
        { upsert: true },
      );
      upserted++;
    }
    this.logger.log(`Upserted ${upserted} price rows`);
    return upserted;
  }
}
