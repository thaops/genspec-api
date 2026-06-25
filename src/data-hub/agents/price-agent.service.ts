import { Injectable, Logger } from '@nestjs/common';
import { PriceService } from '../prices/price.service';
import { NormalizeService } from '../normalizers/normalize.service';

export interface PriceUpdateProposal {
  rowIndex: number;
  name: string;
  unit: string;
  currentPrice: number;
  proposedPrice: number;
  delta: number;
  deltaPercent: number;
  source: string;
  effectiveDate: Date;
  action: 'update' | 'check' | 'ok';
}

export interface PriceAgentResult {
  proposals: PriceUpdateProposal[];
  totalRows: number;
  updateCount: number;
  summary: string;
}

@Injectable()
export class PriceAgentService {
  private readonly logger = new Logger(PriceAgentService.name);

  constructor(
    private readonly price: PriceService,
    private readonly normalize: NormalizeService,
  ) {}

  /**
   * Sprint 5 — AI Price Agent
   * Compares workbook materials against latest official prices and generates update proposals.
   */
  async generatePriceProposals(
    rows: Array<{ name: string; unit: string; currentPrice: number; rowIndex: number }>,
    province?: string,
  ): Promise<PriceAgentResult> {
    const proposals: PriceUpdateProposal[] = [];

    for (const row of rows) {
      const materialId = this.normalize.toMaterialId(row.name)
        ?? this.normalize.normalizeNameForMatch(row.name);

      const latest = await this.price.latest(materialId, province);
      if (!latest || latest.price <= 0) continue;

      const delta = latest.price - row.currentPrice;
      const deltaPercent = row.currentPrice > 0 ? (delta / row.currentPrice) * 100 : 100;

      let action: 'update' | 'check' | 'ok' = 'ok';
      if (Math.abs(deltaPercent) > 10) action = 'update';
      else if (Math.abs(deltaPercent) > 3) action = 'check';

      if (action !== 'ok') {
        proposals.push({
          rowIndex: row.rowIndex,
          name: row.name,
          unit: row.unit,
          currentPrice: row.currentPrice,
          proposedPrice: latest.price,
          delta,
          deltaPercent: Math.round(deltaPercent * 10) / 10,
          source: latest.sourceId,
          effectiveDate: latest.effectiveDate,
          action,
        });
      }
    }

    const updateCount = proposals.filter((p) => p.action === 'update').length;
    const summary = proposals.length === 0
      ? 'Tất cả đơn giá đã cập nhật theo bảng giá hiện hành.'
      : `Phát hiện ${proposals.length} vật liệu cần xem xét, ${updateCount} cần cập nhật ngay.`;

    this.logger.log(`Price agent: ${proposals.length} proposals for ${rows.length} rows`);
    return { proposals, totalRows: rows.length, updateCount, summary };
  }
}
