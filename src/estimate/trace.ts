import { Computed } from './boq.engine';
import {
  EstimateState,
  PriceSource,
  ResourceKind,
  TraceItem,
} from './estimate.types';

/** Resolve a resource ref to its price, name, unit AND source (for citation). */
function resolveResource(
  state: EstimateState,
  kind: ResourceKind,
  ref: string,
): { price: number; name: string; unit: string; source?: PriceSource } {
  const key = (ref ?? '').toLowerCase();
  if (kind === 'material') {
    const m = state.materials.find((r) => r.code.toLowerCase() === key || r.name.toLowerCase() === key);
    return { price: m?.price ?? 0, name: m?.name ?? ref, unit: m?.unit ?? '', source: m?.source };
  }
  if (kind === 'labor') {
    const l = state.labor.find((r) => r.grade.toLowerCase() === key || r.name.toLowerCase() === key);
    return { price: l?.dayRate ?? 0, name: l?.name ?? `Nhân công ${ref}`, unit: 'công', source: l?.source };
  }
  const e = state.equipment.find((r) => r.code.toLowerCase() === key || r.name.toLowerCase() === key);
  return { price: e?.shiftRate ?? 0, name: e?.name ?? ref, unit: e?.unit ?? 'ca', source: e?.source };
}

/**
 * Build the audit trail for every BOQ line — the same numbers the BOQ engine
 * produced, but exploded into Source → Assumption → Formula → Quantity →
 * Unit price → Cost so any figure is traceable. Computed (DTO-only).
 */
export function buildTrace(state: EstimateState, computed: Computed): TraceItem[] {
  const analysisByCode = new Map(state.analyses.map((a) => [a.code.toLowerCase(), a]));

  return computed.boq.map((row) => {
    const key = row.code.toLowerCase();
    const lines = state.takeoff.filter((t) => t.code.toLowerCase() === key);
    const analysis = analysisByCode.get(key);

    const quantityTrace = lines.map((t) => ({
      takeoffId: t.id,
      note: t.note,
      group: t.group,
      formula: t.formula,
      dims:
        t.length != null || t.width != null || t.height != null || t.count != null
          ? { length: t.length, width: t.width, height: t.height, count: t.count }
          : undefined,
      quantity: t.quantity,
    }));

    const components = (analysis?.components ?? []).map((c) => {
      const r = resolveResource(state, c.kind, c.ref);
      return {
        kind: c.kind,
        ref: c.ref,
        name: c.name || r.name,
        unit: c.unit || r.unit,
        norm: c.norm,
        price: r.price,
        amount: Math.round(c.norm * r.price),
        source: r.source,
      };
    });

    const assumptions = [...new Set(lines.map((t) => t.note?.trim()).filter((n): n is string => !!n))];

    return {
      code: row.code,
      name: row.name,
      unit: row.unit,
      quantity: row.quantity,
      unitPrice: row.unitPrice,
      material: row.material,
      labor: row.labor,
      machine: row.machine,
      total: row.total,
      assumptions,
      quantityTrace,
      components,
    };
  });
}
