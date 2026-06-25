import { Injectable, Logger } from '@nestjs/common';
import { CatalogDbService } from '../catalog/catalog-db.service';
import { buildDataHubTools } from '../tools/data-hub.tools';
import { PriceService } from '../prices/price.service';
import { DocumentService } from '../documents/document.service';

export interface ReviewFinding {
  type: 'duplicate' | 'missing_code' | 'formula_error' | 'price_outlier' | 'missing_price';
  severity: 'critical' | 'warning' | 'info';
  description: string;
  rows?: number[];
  code?: string;
  suggestion?: string;
}

export interface ReviewAgentResult {
  findings: ReviewFinding[];
  summary: string;
  score: number; // 0–100
}

@Injectable()
export class ReviewAgentService {
  private readonly logger = new Logger(ReviewAgentService.name);

  constructor(
    private readonly catalog: CatalogDbService,
    private readonly price: PriceService,
    private readonly documents: DocumentService,
  ) {}

  /**
   * Sprint 5 — AI Review Agent
   * Runs all review tools against a list of BOQ rows and returns structured findings.
   */
  async review(rows: Array<{
    code?: string;
    name: string;
    unit: string;
    quantity: number;
    unitPrice: number;
    formula?: string;
  }>, province?: string): Promise<ReviewAgentResult> {
    const tools = buildDataHubTools(this.catalog, this.price, this.documents);
    const findings: ReviewFinding[] = [];

    // 1. Detect duplicate codes
    const codes = rows.map((r) => r.code).filter(Boolean) as string[];
    if (codes.length > 0) {
      const dupeResult = await tools['review.detectDuplicate']({ codes });
      for (const dupe of dupeResult.duplicates) {
        findings.push({
          type: 'duplicate',
          severity: 'warning',
          description: `Mã hiệu "${dupe.code}" xuất hiện ${dupe.indices.length} lần`,
          rows: dupe.indices,
          code: dupe.code,
          suggestion: 'Kiểm tra và gộp các dòng trùng lặp',
        });
      }
    }

    // 2. Detect missing codes in catalog
    if (codes.length > 0) {
      const missingResult = await tools['review.detectMissing']({ codes });
      for (const m of missingResult.missing) {
        findings.push({
          type: 'missing_code',
          severity: 'info',
          description: `Mã hiệu "${m.code}" không có trong catalog`,
          code: m.code,
          suggestion: 'Tra cứu mã hiệu chính xác hoặc cập nhật catalog',
        });
      }
    }

    // 3. Check formula completeness
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (!row.formula) continue;
      const formulaResult = await tools['review.checkFormula']({
        formula: row.formula,
        expectedUnit: row.unit,
      });
      if (!formulaResult.isComplete) {
        findings.push({
          type: 'formula_error',
          severity: 'critical',
          description: `Hàng ${i + 1} "${row.name}": ${formulaResult.note}`,
          rows: [i],
          suggestion: 'Bổ sung đầy đủ thành phần VL + NC + MTC trong công thức',
        });
      }
    }

    // 4. Price outlier detection (>50% deviation from catalog)
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (!row.code || row.unitPrice <= 0) continue;
      const catalogItem = await tools['catalog.findByCode']({ code: row.code });
      if (!catalogItem) continue;
      const catalogPrice = catalogItem.material + catalogItem.labor + catalogItem.machine;
      if (catalogPrice <= 0) continue;
      const deviation = Math.abs(row.unitPrice - catalogPrice) / catalogPrice;
      if (deviation > 0.5) {
        findings.push({
          type: 'price_outlier',
          severity: 'warning',
          description: `Hàng ${i + 1} "${row.name}": Đơn giá ${row.unitPrice.toLocaleString()} lệch ${Math.round(deviation * 100)}% so với định mức (${catalogPrice.toLocaleString()})`,
          rows: [i],
          code: row.code,
          suggestion: 'Kiểm tra lại đơn giá hoặc cập nhật theo bảng giá mới nhất',
        });
      }
    }

    // Score: 100 - penalty per finding
    const penalty = findings.reduce((sum, f) => {
      return sum + (f.severity === 'critical' ? 20 : f.severity === 'warning' ? 10 : 3);
    }, 0);
    const score = Math.max(0, 100 - penalty);

    const criticals = findings.filter((f) => f.severity === 'critical').length;
    const warnings = findings.filter((f) => f.severity === 'warning').length;
    const summary = findings.length === 0
      ? 'Workbook không có lỗi. Chất lượng tốt.'
      : `Phát hiện ${findings.length} vấn đề: ${criticals} nghiêm trọng, ${warnings} cảnh báo. Điểm: ${score}/100`;

    this.logger.log(`Review done: ${findings.length} findings, score=${score}`);
    return { findings, summary, score };
  }
}
