import {
  composeAll,
  composeBoqSummary,
  composeCostSummary,
  composeDashboard,
  composeDoorSchedule,
  composeAiFindings,
  ComposeInput,
  drawingIdOfTakeoff,
} from './composers';
import { CostSummary, Sheet, TakeoffItem, ValidationReport } from '../estimate.types';

function cell(s: Sheet, r: number, c: number): any {
  return s.data.cellData?.[String(r)]?.[String(c)]?.v;
}
/** Tất cả giá trị của một cột (bỏ ô rỗng). */
function col(s: Sheet, c: number): any[] {
  const cd = s.data.cellData ?? {};
  return Object.keys(cd)
    .map((r) => cd[r]?.[String(c)]?.v)
    .filter((v) => v !== undefined);
}
/** Giá trị ở `valueCol` của dòng mà `labelCol` == label (undefined nếu không có). */
function valueForLabel(s: Sheet, label: string, labelCol: number, valueCol: number): any {
  const cd = s.data.cellData ?? {};
  for (const r of Object.keys(cd)) {
    if (cd[r]?.[String(labelCol)]?.v === label) return cd[r]?.[String(valueCol)]?.v;
  }
  return undefined;
}

const CS: CostSummary = {
  directMaterial: 100, directLabor: 0, directMachine: 0, directTotal: 100,
  overhead: 6, profit: 5, preTax: 111, vat: 11, contingency: 2, total: 124,
};
const VAL: ValidationReport = { status: 'reasonable', score: 88, findings: [], consistency: [] };

function baseInput(over: Partial<ComposeInput> = {}): ComposeInput {
  return {
    name: 'Nhà A',
    projectInfo: { location: 'Hà Nội' },
    takeoff: [],
    costSummary: CS,
    validation: VAL,
    drawings: [],
    typeCounts: [],
    doors: [],
    ...over,
  };
}

const tk = (o: Partial<TakeoffItem>): TakeoffItem => ({
  id: 't1', code: '', name: 'X', unit: 'm3', quantity: 1, ...o,
});

describe('drawingIdOfTakeoff', () => {
  it('bóc drawingId 24hex từ id convention', () => {
    expect(drawingIdOfTakeoff('tk_engine_6a5cc34894422e04aedacf9c_wall')).toBe('6a5cc34894422e04aedacf9c');
    expect(drawingIdOfTakeoff('tk_engine_6a5cc34894422e04aedacf9c_ab12cd34_wall')).toBe('6a5cc34894422e04aedacf9c');
  });
  it('trả null cho id không theo convention', () => {
    expect(drawingIdOfTakeoff('manual_row_1')).toBeNull();
  });
});

describe('composeAll — contract', () => {
  it('sinh đúng 7 sheet, MỌI sheet tag origin=genspec + read-only', () => {
    const sheets = composeAll(baseInput());
    expect(sheets).toHaveLength(7);
    for (const s of sheets) {
      expect(s.metadata?.origin).toBe('genspec');
      expect(s.metadata?.readOnly).toBe(true);
      expect(s.metadata?.group).toBe('GenSpec AI');
    }
  });

  it('takeoff rỗng → không crash, các sheet chỉ có header/title', () => {
    expect(() => composeAll(baseInput())).not.toThrow();
  });
});

describe('composeDashboard', () => {
  it('phản ánh costSummary.total (mutation: đổi total → ô đổi)', () => {
    const s1 = composeDashboard(baseInput());
    const s2 = composeDashboard(baseInput({ costSummary: { ...CS, total: 999 } }));
    const tot1 = col(s1, 1).find((v) => String(v).includes('124'));
    const tot2 = col(s2, 1).find((v) => String(v).includes('999'));
    expect(tot1).toBeDefined();
    expect(tot2).toBeDefined();
    expect(tot1).not.toEqual(tot2);
  });

  it('đếm đúng số dòng estimated (mutation-check)', () => {
    const s = composeDashboard(
      baseInput({ takeoff: [tk({ estimated: true }), tk({ id: 't2' }), tk({ id: 't3', estimated: true })] }),
    );
    expect(valueForLabel(s, 'Đơn giá ước lượng (cần kiểm chứng)', 0, 1)).toBe(2);
  });
});

describe('composeBoqSummary — KHÔNG bịa', () => {
  it('mã trống giữ trống, KHÔNG bịa mã', () => {
    const s = composeBoqSummary(baseInput({ takeoff: [tk({ code: '', name: 'Xây tường', unitPrice: 100 })] }));
    // header ở row0, data row1; cột 1 = Mã hiệu
    expect(cell(s, 1, 1)).toBe('');
  });

  it('thiếu giá → trạng thái "Thiếu giá — cần QS", ô thành tiền TRỐNG (không phải 0)', () => {
    const s = composeBoqSummary(baseInput({ takeoff: [tk({ name: 'Ống', unit: 'm', quantity: 10 })] }));
    expect(cell(s, 1, 13)).toContain('Thiếu giá');
    expect(cell(s, 1, 12)).toBe(''); // thành tiền trống, không bịa 0
  });

  it('có giá → thành tiền = đơn giá × KL', () => {
    const s = composeBoqSummary(baseInput({ takeoff: [tk({ unitPrice: 200, quantity: 3, code: 'AE.1' })] }));
    expect(cell(s, 1, 12)).toBe(600);
    expect(cell(s, 1, 13)).toBe('OK');
  });

  it('gắn đúng bản vẽ theo drawingId trong id', () => {
    const s = composeBoqSummary(
      baseInput({
        takeoff: [tk({ id: 'tk_engine_6a5cc34894422e04aedacf9c_w', unitPrice: 1 })],
        drawings: [{ id: '6a5cc34894422e04aedacf9c', name: 'KT-01', discipline: 'KT' }],
      }),
    );
    expect(String(cell(s, 1, 7))).toContain('KT');
  });
});

describe('composeAiFindings — derived, không hardcode', () => {
  it('đếm đúng dòng thiếu mã / thiếu giá / ước lượng', () => {
    const s = composeAiFindings(
      baseInput({
        takeoff: [
          tk({ id: 'a', code: '', unitPrice: 100 }), // thiếu mã
          tk({ id: 'b', code: 'X', unitPrice: 0 }), // thiếu giá
          tk({ id: 'c', code: 'Y', unitPrice: 50, estimated: true }), // ước lượng
        ],
      }),
    );
    expect(valueForLabel(s, 'Chưa chốt mã hiệu', 0, 1)).toBe(1); // chỉ dòng a rỗng mã
    expect(valueForLabel(s, 'Chưa có đơn giá', 0, 1)).toBe(1); // chỉ dòng b (unitPrice 0)
    expect(valueForLabel(s, 'Đơn giá ước lượng', 0, 1)).toBe(1); // chỉ dòng c
  });

  it('không có vấn đề → 1 dòng "Không phát hiện thiếu sót"', () => {
    const s = composeAiFindings(baseInput({ takeoff: [tk({ code: 'X', unitPrice: 100 })] }));
    expect(col(s, 0)).toContain('—');
  });
});

describe('composeDoorSchedule', () => {
  it('title chứa số cửa thật, dùng bbox thật', () => {
    const s = composeDoorSchedule(
      baseInput({
        doors: [
          { drawingId: 'd1', type: 'door', layer: 'CUA', w: 900, h: 2200 },
          { drawingId: 'd1', type: 'window', layer: 'WIN', w: 1200, h: 1400 },
        ],
        drawings: [{ id: 'd1', name: 'KT', discipline: 'KT' }],
      }),
    );
    expect(cell(s, 0, 0)).toContain('2 cửa');
    expect(cell(s, 3, 4)).toBe(900); // title(0-1)+header(2)+data row3, cột 4 = Rộng
  });
});

describe('composeCostSummary', () => {
  it('bậc A→F lấy đúng từ costSummary', () => {
    const s = composeCostSummary(baseInput({ takeoff: [tk({ unitPrice: 100, quantity: 1, group: 'Thô' })] }));
    const vals = col(s, 2);
    expect(vals).toContain('124'); // F total
    expect(vals).toContain('11'); // D vat
  });
});
