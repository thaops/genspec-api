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

  constructor(
    @InjectModel(UnitPrice.name) private readonly model: Model<UnitPrice>,
    @InjectModel(MaterialPrice.name) private readonly matPrices: Model<MaterialPrice>,
  ) {}

  async onModuleInit() {
    try {
      await this.seedFromJson();
    } catch (err) {
      this.logger.warn(`unit_prices seed skipped: ${(err as Error).message}`);
    }
    try {
      await this.seedResourcePrices();
    } catch (err) {
      this.logger.warn(`resource prices seed skipped: ${(err as Error).message}`);
    }
  }

  /** Nạp giá Vật liệu/Nhân công/Ca máy (từ JSON tài nguyên) vào material_prices. */
  private async seedResourcePrices() {
    const file = path.join(__dirname, 'data', 'gia-taiguyen-hanoi.json');
    if (!fs.existsSync(file)) return;
    const data = JSON.parse(fs.readFileSync(file, 'utf-8')) as {
      source: { province: string; document: string; priceLevel?: string };
      materials: Array<{ name: string; unit: string; price: number }>;
      labor: Array<{ name: string; unit: string; price: number }>;
      machines: Array<{ name: string; unit: string; price: number }>;
    };
    const province = data.source?.province || 'Hà Nội';
    const sourceId = data.source?.document || 'Đơn giá tỉnh';
    // Đã seed cho tỉnh này rồi → bỏ qua (tránh nạp lại mỗi lần khởi động).
    const existing = await this.matPrices.countDocuments({ province, sourceId });
    if (existing > 0) return;
    // Q2/2022 (không dùng Date.now để deterministic)
    const effectiveDate = new Date('2022-06-30T00:00:00Z');
    const norm = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const groups: Array<[Array<{ name: string; unit: string; price: number }>, string]> = [
      [data.materials ?? [], 'material'],
      [data.labor ?? [], 'labor'],
      [data.machines ?? [], 'equipment'],
    ];
    const ops = groups.flatMap(([arr, category]) =>
      arr.filter((x) => x.name && x.price > 0).map((x) => ({
        insertOne: {
          document: {
            materialId: `${category}-${norm(x.name)}`, name: x.name, category,
            unit: x.unit, price: x.price, province, sourceId, trust: 90,
            effectiveDate, documentNumber: sourceId, active: true,
          },
        },
      })),
    );
    if (ops.length === 0) return;
    for (let i = 0; i < ops.length; i += 1000) {
      await this.matPrices.bulkWrite(ops.slice(i, i + 1000) as any, { ordered: false }).catch(() => {});
    }
    this.logger.log(`Seeded ${ops.length} giá tài nguyên (VL/NC/Máy) — ${province}, ${sourceId}`);
  }

  /** Nạp MỌI file dongia-*.json (mỗi tỉnh 1 file) vào unit_prices — guard theo tỉnh. */
  private async seedFromJson() {
    const dir = path.join(__dirname, 'data');
    if (!fs.existsSync(dir)) return;
    const files = fs.readdirSync(dir).filter((f) => /^dongia-.*\.json$/.test(f));
    for (const f of files) {
      try {
        await this.seedOneProvince(path.join(dir, f));
      } catch (err) {
        this.logger.warn(`unit_prices seed ${f}: ${(err as Error).message}`);
      }
    }
  }

  private async seedOneProvince(file: string) {
    const data = JSON.parse(fs.readFileSync(file, 'utf-8')) as DongiaFile;
    const province = data.source?.province || 'Không rõ';
    const sourceDoc = data.source?.document || 'Đơn giá tỉnh';
    const sourceOrigin = data.source?.origin || '';
    // Đã có đơn giá tỉnh này → bỏ qua (idempotent).
    if ((await this.model.countDocuments({ province })) > 0) return;
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
