import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { MaterialPrice } from '../prices/material-price.schema';
import { PricePoint, materialKnowledge, swapImpact } from './knowledge-graph';

/**
 * Knowledge Graph service — tri thức Vật tư → Nguồn → Giá → Lịch sử, dựng từ
 * material_prices (crawler/import, có sourceId + trust + effectiveDate).
 */
@Injectable()
export class KnowledgeGraphService {
  constructor(@InjectModel(MaterialPrice.name) private readonly model: Model<MaterialPrice>) {}

  private async points(province?: string): Promise<PricePoint[]> {
    const filter: Record<string, unknown> = { active: true };
    if (province?.trim()) {
      filter.province = new RegExp(`^${province.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i');
    }
    const docs = await this.model.find(filter).lean();
    return docs.map((d: any) => ({
      name: d.name, price: d.price, sourceId: d.sourceId, trust: d.trust,
      effectiveDate: d.effectiveDate, province: d.province ?? null,
      documentNumber: d.documentNumber, category: d.category, unit: d.unit,
    }));
  }

  /** Tri thức 1 vật tư: nguồn + giá mới nhất + lịch sử. */
  async material(name: string, province?: string) {
    return materialKnowledge(await this.points(province), name);
  }

  /** "Đổi A → B chênh bao nhiêu?" × khối lượng. */
  async swap(from: string, to: string, quantity = 1, province?: string) {
    return swapImpact(await this.points(province), from, to, quantity);
  }
}
