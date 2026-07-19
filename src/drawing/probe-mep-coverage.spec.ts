import { DwgParserService } from './parsers/dwg-parser.service';
import { expandInsertEntities } from './services/dwg-insert-expand';
import { DrawingNormalizerService } from './services/drawing-normalizer.service';
import { DrawingDetectorService } from './services/drawing-detector.service';
import { inferUnitFactor } from './services/drawing-unit';

const DIR = process.env.DWGDIR;
const FILES: [string, string][] = [
  ['DIEN', 'DIEN BENH XA LU DOAN 550-Thdinh.dwg'],
  ['NUOC', 'NƯỚC- BENH XA LU 550 - Thdinh.dwg'],
];

(DIR ? describe : describe.skip)('MEP coverage inventory', () => {
  jest.setTimeout(600_000);
  for (const [disc, fname] of FILES) {
    it(`${disc}: layer + type + coverage`, async () => {
      const parser = new DwgParserService();
      let result: any = await parser.parse(`${DIR}/${fname}`);
      const blocks = (result.metadata?.blocks ?? {}) as any;
      result = { ...result, pages: result.pages.map((p: any) => ({ ...p, entities: expandInsertEntities(p.entities, blocks) })) };
      const raw = new DrawingNormalizerService().fromPages('probe', result.pages);
      const f = inferUnitFactor(result) ?? 0.001;
      const det = new DrawingDetectorService().detect(raw, [], inferUnitFactor(result), disc);

      // 1. Layer inventory: layer → {count, rawTypes, detectedTypes}
      const layers = new Map<string, { n: number; raw: Record<string, number>; types: Record<string, number> }>();
      for (const o of det as any[]) {
        const L = layers.get(o.layer) ?? { n: 0, raw: {}, types: {} };
        L.n++;
        L.raw[o.rawType] = (L.raw[o.rawType] ?? 0) + 1;
        L.types[o.objectType] = (L.types[o.objectType] ?? 0) + 1;
        layers.set(o.layer, L);
      }
      console.log(`\n### ${disc} — ${det.length} objects, ${layers.size} layers`);
      console.log('--- LAYER (top 25 theo count):');
      for (const [name, L] of [...layers.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 25)) {
        const topType = Object.entries(L.types).sort((a, b) => b[1] - a[1])[0];
        console.log(`  ${String(L.n).padStart(5)} ${name.slice(0, 34).padEnd(34)} → ${topType[0]} (${JSON.stringify(L.raw)})`);
      }

      // 2. Type distribution
      const tc: Record<string, number> = {};
      for (const o of det as any[]) tc[o.objectType] = (tc[o.objectType] ?? 0) + 1;
      console.log('--- TYPE distribution:', JSON.stringify(Object.fromEntries(Object.entries(tc).sort((a, b) => b[1] - a[1]))));

      // 3. Layer bị 'symbol'/'unknown' nhiều = coverage MISS (có thể là thiết bị chưa nhận)
      console.log('--- LAYER rơi symbol/unknown (coverage miss, top 15):');
      const miss = [...layers.entries()]
        .filter(([, L]) => (L.types['symbol'] ?? 0) + (L.types['unknown'] ?? 0) > (L.n / 2))
        .sort((a, b) => b[1].n - a[1].n).slice(0, 15);
      for (const [name, L] of miss) console.log(`  ${String(L.n).padStart(5)} ${name.slice(0, 40)}`);

      // 4. NUOC pipe length outliers
      if (disc === 'NUOC') {
        const pipes = (det as any[]).filter((o) => o.objectType === 'pipe');
        const lens = pipes.map((o) => {
          const g = o.geometry ?? []; let len = 0;
          for (let i = 1; i < g.length; i++) len += Math.hypot(g[i][0] - g[i - 1][0], g[i][1] - g[i - 1][1]);
          if (g.length < 2) { const b = o.boundingBox; len = Math.max(b.w, b.h); }
          return len * f;
        }).sort((a, b) => b - a);
        console.log(`--- PIPE ${pipes.length} đoạn, tổng ${Math.round(lens.reduce((s, x) => s + x, 0))}m`);
        console.log(`  top 10 dài nhất (m): ${lens.slice(0, 10).map((x) => Math.round(x)).join(', ')}`);
        console.log(`  median ${Math.round(lens[Math.floor(lens.length / 2)])}m`);
      }
    });
  }
});
