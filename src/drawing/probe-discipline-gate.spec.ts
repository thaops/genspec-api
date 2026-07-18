import { DwgParserService } from './parsers/dwg-parser.service';
import { expandInsertEntities } from './services/dwg-insert-expand';
import { DrawingNormalizerService } from './services/drawing-normalizer.service';
import { DrawingDetectorService } from './services/drawing-detector.service';
import { inferUnitFactor } from './services/drawing-unit';

// DWGDIR = thư mục chứa 4 bản; chạy: DWGDIR="C:/.../THUC HANH 2 (NHA)" npx jest probe-discipline-gate
const DIR = process.env.DWGDIR;
const FILES: [string, string][] = [
  ['KT', 'F550-BENH XA LD - Thdinh.dwg'],
  ['KC', 'KC BENH XA LU550-V3-Thdinh.dwg'],
  ['DIEN', 'DIEN BENH XA LU DOAN 550-Thdinh.dwg'],
  ['NUOC', 'NƯỚC- BENH XA LU 550 - Thdinh.dwg'],
];
const STRUCT = ['wall', 'column', 'beam', 'footing', 'pile', 'slab', 'door', 'window'];
const MEP = ['pipe', 'valve', 'sanitary', 'light', 'socket', 'switch', 'conduit', 'cable_tray'];

(DIR ? describe : describe.skip)('discipline gate — 4 bản', () => {
  jest.setTimeout(600_000);
  for (const [disc, fname] of FILES) {
    it(`${disc}: type ngoài bộ môn bị gate`, async () => {
      const parser = new DwgParserService();
      let result: any = await parser.parse(`${DIR}/${fname}`);
      const blocks = (result.metadata?.blocks ?? {}) as any;
      result = { ...result, pages: result.pages.map((p: any) => ({ ...p, entities: expandInsertEntities(p.entities, blocks) })) };
      const raw = new DrawingNormalizerService().fromPages('probe', result.pages);
      const uf = inferUnitFactor(result);
      const det = new DrawingDetectorService();

      const before = det.detect(raw, [], uf);            // KHÔNG gate
      const after = det.detect(raw, [], uf, disc);       // CÓ gate

      const count = (list: any[], types: string[]) => {
        const m: Record<string, number> = {};
        for (const o of list) if (types.includes(o.objectType)) m[o.objectType] = (m[o.objectType] ?? 0) + 1;
        return m;
      };
      const isMEP = disc === 'DIEN' || disc === 'NUOC';
      const foreign = isMEP ? STRUCT : MEP;
      console.log(`\n### ${disc} (${fname})`);
      console.log(`  BEFORE ngoài-bộ-môn:`, JSON.stringify(count(before, foreign)));
      console.log(`  AFTER  ngoài-bộ-môn:`, JSON.stringify(count(after, foreign)));
      console.log(`  AFTER  đúng-bộ-môn :`, JSON.stringify(count(after, isMEP ? MEP : STRUCT)));

      // Kỳ vọng: sau gate, KHÔNG còn type ngoài bộ môn.
      const foreignAfter = count(after, foreign);
      expect(Object.keys(foreignAfter)).toHaveLength(0);
    });
  }
});
