import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import * as fs from 'fs';
import * as path from 'path';
import { UnitPrice } from './unit-price.schema';
import { MaterialPrice } from '../data-hub/prices/material-price.schema';

interface DongiaFile {
  source: { province: string; document: string; origin: string };
  items: Array<{
    code: string; name: string; unit: string;
    material: number; labor: number; machine: number; unitPrice: number;
    splitConfident?: boolean;
  }>;
}

/**
 * Nạp đơn giá công tác THẬT (tập Đơn giá tỉnh) từ JSON đã chuẩn hóa → collection
 * unit_prices; tra theo mã hiệu cho tầng giá dự toán. Có nguồn, không bịa.
 */
@Injectable()
export class UnitPriceService implements OnModuleInit {
  private readonly logger = new Logger(UnitPriceService.name);

  constructor(@InjectModel(UnitPrice.name) private readonly model: Model<UnitPrice>) {}

  async onModuleInit() {
    try {
      const count = await this.model.estimatedDocumentCount();
      if (count === 0) await this.seedFromJson();
    } catch (err) {
      this.logger.warn(`unit_prices seed skipped: ${(err as Error).message}`);
    }
  }

  /** Đọc file JSON (được copy vào dist qua nest-cli assets) và bulk upsert. */
  private async seedFromJson() {
    // __dirname: src/catalog (dev) hoặc dist/catalog (prod) → data/dongia-hanoi.json
    const file = path.join(__dirname, 'data', 'dongia-hanoi.json');
    if (!fs.existsSync(file)) {
      this.logger.warn(`unit_prices: không thấy ${file} — bỏ qua seed`);
      return;
    }
    const data = JSON.parse(fs.readFileSync(file, 'utf-8')) as DongiaFile;
    const province = data.source?.province || 'Hà Nội';
    const sourceDoc = data.source?.document || 'Đơn giá tỉnh';
    const sourceOrigin = data.source?.origin || '';
    const docs = (data.items ?? [])
      .filter((it) => it.code && it.unitPrice > 0)
      .map((it) => ({
        updateOne: {
          filter: { code: it.code.toUpperCase(), province },
          update: {
            $set: {
              name: it.name, unit: it.unit,
              material: it.material ?? 0, labor: it.labor ?? 0, machine: it.machine ?? 0,
              unitPrice: it.unitPrice, province, sourceDoc, sourceOrigin,
              splitConfident: it.splitConfident !== false,
            },
            $setOnInsert: { code: it.code.toUpperCase() },
          },
          upsert: true,
        },
      }));
    if (docs.length === 0) return;
    // chia lô để tránh payload lớn
    for (let i = 0; i < docs.length; i += 1000) {
      await this.model.bulkWrite(docs.slice(i, i + 1000), { ordered: false }).catch((e) => {
        this.logger.warn(`unit_prices bulkWrite lô ${i}: ${e.message}`);
      });
    }
    this.logger.log(`Seeded ${docs.length} đơn giá công tác (${province}, ${sourceDoc})`);
  }

  /**
   * Tra đơn giá công tác theo mã hiệu (khớp prefix — mã đơn giá thường dài hơn mã
   * định mức, vd định mức AF.615 → đơn giá AF.61520). Ưu tiên tỉnh, fallback bất kỳ.
   */
  async byCode(code: string, province?: string): Promise<UnitPrice | null> {
    if (!code?.trim()) return null;
    const c = code.trim().toUpperCase();
    const rx = new RegExp(`^${c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`);
    const filter: Record<string, unknown> = { code: rx };
    if (province?.trim()) filter.province = province.trim();
    return this.model.findOne(filter).sort({ code: 1 }).lean<UnitPrice>().exec();
  }

  /**
   * Tìm đơn giá công tác theo TỪ KHÓA tên (vd "bê tông cột", "xây tường") + mã.
   * Cho agent chọn ĐÚNG dòng (có nhiều biến thể Mác/kích thước) — có nguồn.
   */
  async search(query: string, province?: string, limit = 8): Promise<UnitPrice[]> {
    if (!query?.trim()) return [];
    const q = query.trim();
    const provFilter = province?.trim() ? { province: province.trim() } : {};
    // Mã hiệu → prefix; else → full-text theo tên (đa từ).
    if (/^[A-Z]{2}\.\d/i.test(q)) {
      return this.model
        .find({ code: new RegExp(`^${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i'), ...provFilter })
        .limit(limit).lean<UnitPrice[]>().exec();
    }
    try {
      return await this.model
        .find({ $text: { $search: q }, ...provFilter }, { score: { $meta: 'textScore' } })
        .sort({ score: { $meta: 'textScore' } })
        .limit(limit).lean<UnitPrice[]>().exec();
    } catch {
      // fallback regex nếu text index chưa sẵn
      return this.model
        .find({ name: new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'), ...provFilter })
        .limit(limit).lean<UnitPrice[]>().exec();
    }
  }

  /** Số bản ghi (chẩn đoán). */
  count(province?: string) {
    return this.model.countDocuments(province ? { province } : {});
  }
}
