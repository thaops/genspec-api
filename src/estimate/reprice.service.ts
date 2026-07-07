import { Injectable, Logger } from '@nestjs/common';
import { CatalogService, lookupComponentPrice } from '../catalog/catalog.service';
import { PriceItem, PriceSet } from '../catalog/catalog-db.schemas';
import { EstimateService } from './estimate.service';
import { previewActions } from './transparency';
import { Action, EstimateState, PriceSource, ProposalPreview } from './estimate.types';

/** Một tài nguyên chưa khớp được giá tỉnh (để FE liệt kê phần còn thiếu). */
export interface UnmatchedResource {
  kind: 'material' | 'labor' | 'equipment';
  ref: string;
  name: string;
}

/** Kết quả áp giá tỉnh — KHÔNG tự apply; FE preview rồi POST actions sang /actions. */
export interface RepricePlan {
  province: string | null;
  effectiveDate: string | null;
  sourceDoc: string | null;
  coverage: { matched: number; total: number };
  unmatched: UnmatchedResource[];
  actions: Action[];
  preview: ProposalPreview | null;
  message: string;
}

const EMPTY = (message: string): RepricePlan => ({
  province: null,
  effectiveDate: null,
  sourceDoc: null,
  coverage: { matched: 0, total: 0 },
  unmatched: [],
  actions: [],
  preview: null,
  message,
});

/**
 * Áp đơn giá tỉnh (price_sets đã import) vào giá VL/NC/máy của estimate.
 * Đây là mảnh còn thiếu của bước "định mức & đơn giá": giá tỉnh trước đây chỉ
 * feed prompt AI/takeoff-engine, nay nối thẳng vào resource state deterministic.
 */
@Injectable()
export class RepriceService {
  private readonly logger = new Logger(RepriceService.name);

  constructor(
    private readonly catalog: CatalogService,
    private readonly estimates: EstimateService,
  ) {}

  async plan(userId: string, id: string, province?: string): Promise<RepricePlan> {
    const doc = await this.estimates.getOwned(userId, id);
    const state = this.estimates.stateForPrompt(doc);

    // Tỉnh chỉ định > projectInfo.location (matchProvince xử lý cả 2 dạng).
    const location = province?.trim() || state.projectInfo.location;
    const ctx = await this.catalog.priceContextForLocation(location);
    if (!ctx) {
      return EMPTY(
        location
          ? `Chưa có công bố giá tỉnh khớp "${location}". Cần import price_set cho tỉnh này.`
          : 'Chưa xác định được tỉnh — nhập địa điểm dự án hoặc chọn tỉnh để áp giá.',
      );
    }

    const { actions, unmatched, matched, total } = this.buildActions(state, ctx.set, ctx.prices);
    const preview = actions.length ? previewActions(state, actions) : null;
    const effectiveDate = ctx.set.effectiveDate.toISOString().slice(0, 10);

    return {
      province: ctx.set.province,
      effectiveDate,
      sourceDoc: ctx.set.sourceDoc || null,
      coverage: { matched, total },
      unmatched,
      actions,
      preview,
      message: `Áp giá tỉnh ${ctx.set.province} (${effectiveDate}): khớp ${matched}/${total} tài nguyên.`,
    };
  }

  private buildActions(
    state: EstimateState,
    set: PriceSet,
    prices: PriceItem[],
  ): { actions: Action[]; unmatched: UnmatchedResource[]; matched: number; total: number } {
    const source: PriceSource = {
      name: set.sourceDoc || `Công bố giá ${set.province}`,
      date: set.effectiveDate.toISOString().slice(0, 10),
      region: set.province,
      type: 'government',
    };
    // Tách price_items theo kind để không match chéo (equipment ↔ 'machine').
    const byMaterial = prices.filter((p) => p.kind === 'material');
    const byLabor = prices.filter((p) => p.kind === 'labor');
    const byMachine = prices.filter((p) => p.kind === 'machine');

    const actions: Action[] = [];
    const unmatched: UnmatchedResource[] = [];
    let matched = 0;
    let total = 0;

    for (const m of state.materials) {
      total++;
      const price = lookupComponentPrice({ refCode: m.code, name: m.name }, byMaterial);
      if (price == null) {
        unmatched.push({ kind: 'material', ref: m.code, name: m.name });
        continue;
      }
      matched++;
      if (Math.round(price) === Math.round(m.price)) continue; // không đổi → bỏ qua
      actions.push({ type: 'upsert_material', id: m.id, code: m.code, name: m.name, unit: m.unit, price: Math.round(price), source });
    }

    for (const l of state.labor) {
      total++;
      const price = lookupComponentPrice({ refCode: l.grade, name: l.name }, byLabor);
      if (price == null) {
        unmatched.push({ kind: 'labor', ref: l.grade, name: l.name });
        continue;
      }
      matched++;
      if (Math.round(price) === Math.round(l.dayRate)) continue;
      actions.push({ type: 'upsert_labor', id: l.id, grade: l.grade, name: l.name, dayRate: Math.round(price), source });
    }

    for (const e of state.equipment) {
      total++;
      const price = lookupComponentPrice({ refCode: e.code, name: e.name }, byMachine);
      if (price == null) {
        unmatched.push({ kind: 'equipment', ref: e.code, name: e.name });
        continue;
      }
      matched++;
      if (Math.round(price) === Math.round(e.shiftRate)) continue;
      actions.push({ type: 'upsert_equipment', id: e.id, code: e.code, name: e.name, unit: e.unit, shiftRate: Math.round(price), source });
    }

    return { actions, unmatched, matched, total };
  }
}
