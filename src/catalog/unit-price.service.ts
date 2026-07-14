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

  /** Nạp MỌI file gia-*.json (giá VL/NC/Máy) vào material_prices. Hỗ trợ 2 shape:
   *  { materials, labor, machines:[{name,unit,price}] } và { machines:[{code,type,unit,price}] }. */
  private async seedResourcePrices() {
    const dir = path.join(__dirname, 'data');
    if (!fs.existsSync(dir)) return;
    const files = fs.readdirSync(dir).filter((f) => /^gia-.*\.json$/.test(f));
    for (const f of files) {
      try {
        await this.seedResourceFile(path.join(dir, f));
      } catch (err) {
        this.logger.warn(`resource seed ${f}: ${(err as Error).message}`);
      }
    }
  }

  private async seedResourceFile(file: string) {
    const data = JSON.parse(fs.readFileSync(file, 'utf-8')) as {
      source: { province: string; document: string };
      materials?: Array<{ name: string; unit: string; price: number }>;
      labor?: Array<{ name: string; unit: string; price: number }>;
      machines?: Array<{ name?: string; type?: string; code?: string; unit: string; price: number }>;
    };
    const province = data.source?.province || 'Không rõ';
    const sourceId = data.source?.document || 'Công bố giá';
    if ((await this.matPrices.countDocuments({ province, sourceId })) > 0) return; // idempotent theo (tỉnh, nguồn)
    const effectiveDate = new Date('2022-06-30T00:00:00Z'); // deterministic; đối chiếu note trong nguồn
    const norm = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const ops: any[] = [];
    const push = (name: string, unit: string, price: number, category: string, materialId: string) => {
      ops.push({ insertOne: { document: {
        materialId, name, category, unit, price, province, sourceId, trust: 90,
        effectiveDate, documentNumber: sourceId, active: true,
      } } });
    };
    for (const x of data.materials ?? []) if (x.name && x.price > 0) push(x.name, x.unit, x.price, 'material', `material-${norm(x.name)}`);
    for (const x of data.labor ?? []) if (x.name && x.price > 0) push(x.name, x.unit, x.price, 'labor', `labor-${norm(x.name)}`);
    for (const x of data.machines ?? []) {
      const nm = x.name || x.type || x.code || '';
      if (!nm || !(x.price > 0)) continue;
      // Ca máy: giữ MÃ (M-code) làm materialId để tra theo mã; tên OCR để hiển thị.
      push(x.code ? `${x.code} ${x.type ?? ''}`.trim() : nm, x.unit, x.price, 'equipment', x.code ? `M-${x.code}` : `equipment-${norm(nm)}`);
    }
    if (ops.length === 0) return;
    for (let i = 0; i < ops.length; i += 1000) {
      await this.matPrices.bulkWrite(ops.slice(i, i + 1000), { ordered: false }).catch(() => {});
    }
    this.logger.log(`Seeded ${ops.length} giá tài nguyên — ${province}, ${sourceId}`);
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
