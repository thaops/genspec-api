import {
  BoqRow,
  CostSummary,
  Costs,
  EstimateState,
  MaterialSummaryRow,
  ResourceKind,
  UnitPriceAnalysis,
} from './estimate.types';

function num(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** Resolve the unit price of a resource referenced by an analysis component. */
function resourcePrice(state: EstimateState, kind: ResourceKind, ref: string): { price: number; name: string; unit: string } {
  const key = (ref ?? '').toLowerCase();
  if (kind === 'material') {
    const m = state.materials.find((r) => r.code.toLowerCase() === key || r.name.toLowerCase() === key);
    return { price: num(m?.price), name: m?.name ?? ref, unit: m?.unit ?? '' };
  }
  if (kind === 'labor') {
    const l = state.labor.find((r) => r.grade.toLowerCase() === key || r.name.toLowerCase() === key);
    return { price: num(l?.dayRate), name: l?.name ?? `Nhân công ${ref}`, unit: 'công' };
  }
  const e = state.equipment.find((r) => r.code.toLowerCase() === key || r.name.toLowerCase() === key);
  return { price: num(e?.shiftRate), name: e?.name ?? ref, unit: e?.unit ?? 'ca' };
}

/** Compute VL/NC/Máy unit costs of one analysis from its components × resource prices. */
export function analysisUnitPrice(state: EstimateState, analysis: UnitPriceAnalysis) {
  let material = 0;
  let labor = 0;
  let machine = 0;
  for (const c of analysis.components ?? []) {
    const { price } = resourcePrice(state, c.kind, c.ref);
    const cost = price * num(c.norm);
    if (c.kind === 'material') material += cost;
    else if (c.kind === 'labor') labor += cost;
    else machine += cost;
  }
  return {
    material: Math.round(material),
    labor: Math.round(labor),
    machine: Math.round(machine),
    unitPrice: Math.round(material + labor + machine),
  };
}

export interface Computed {
  boq: BoqRow[];
  materialSummary: MaterialSummaryRow[];
  costSummary: CostSummary;
  costs: Costs;
}

export function compute(state: EstimateState): Computed {
  const analysisByCode = new Map<string, UnitPriceAnalysis>();
  for (const a of state.analyses) analysisByCode.set(a.code.toLowerCase(), a);

  // BOQ: aggregate takeoff quantity by code
  const qtyByCode = new Map<string, { name: string; unit: string; quantity: number }>();
  for (const t of state.takeoff) {
    const key = t.code.toLowerCase();
    const prev = qtyByCode.get(key) ?? { name: t.name, unit: t.unit, quantity: 0 };
    prev.quantity += num(t.quantity);
    if (!prev.name) prev.name = t.name;
    if (!prev.unit) prev.unit = t.unit;
    qtyByCode.set(key, prev);
  }

  const boq: BoqRow[] = [];
  let directMaterial = 0;
  let directLabor = 0;
  let directMachine = 0;
  const matAgg = new Map<string, MaterialSummaryRow>();

  for (const [key, info] of qtyByCode) {
    const analysis = analysisByCode.get(key);
    const up = analysis ? analysisUnitPrice(state, analysis) : { material: 0, labor: 0, machine: 0, unitPrice: 0 };
    const qty = info.quantity;
    const total = Math.round(up.unitPrice * qty);
    boq.push({
      code: analysis?.code ?? key,
      name: info.name,
      unit: info.unit,
      quantity: round2(qty),
      material: up.material,
      labor: up.labor,
      machine: up.machine,
      unitPrice: up.unitPrice,
      total,
    });
    directMaterial += up.material * qty;
    directLabor += up.labor * qty;
    directMachine += up.machine * qty;

    // Material/resource summary: consumed = norm × boq quantity
    if (analysis) {
      for (const c of analysis.components ?? []) {
        const { price, name, unit } = resourcePrice(state, c.kind, c.ref);
        const consumed = num(c.norm) * qty;
        const aggKey = `${c.kind}:${c.ref.toLowerCase()}`;
        const prev =
          matAgg.get(aggKey) ??
          { kind: c.kind, ref: c.ref, name: c.name || name, unit: c.unit || unit, quantity: 0, price, amount: 0 };
        prev.quantity += consumed;
        prev.amount += consumed * price;
        matAgg.set(aggKey, prev);
      }
    }
  }

  const materialSummary = [...matAgg.values()]
    .map((r) => ({ ...r, quantity: round2(r.quantity), amount: Math.round(r.amount) }))
    .sort((a, b) => b.amount - a.amount);

  directMaterial = Math.round(directMaterial);
  directLabor = Math.round(directLabor);
  directMachine = Math.round(directMachine);
  const directTotal = directMaterial + directLabor + directMachine;

  const m = state.markups;
  const overhead = Math.round((directTotal * num(m.overheadPct)) / 100);
  const profit = Math.round(((directTotal + overhead) * num(m.profitPct)) / 100);
  const preTax = directTotal + overhead + profit;
  const vat = Math.round((preTax * num(m.vatPct)) / 100);
  const afterTax = preTax + vat;
  const contingency = Math.round((afterTax * num(m.contingencyPct)) / 100);
  const total = afterTax + contingency;

  const costSummary: CostSummary = {
    directMaterial,
    directLabor,
    directMachine,
    directTotal,
    overhead,
    profit,
    preTax,
    vat,
    contingency,
    total,
  };

  return {
    boq: boq.sort((a, b) => a.code.localeCompare(b.code)),
    materialSummary,
    costSummary,
    costs: { material: directMaterial, labor: directLabor, machine: directMachine, total },
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
