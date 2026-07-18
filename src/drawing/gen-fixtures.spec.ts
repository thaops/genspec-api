import { DwgParserService } from './parsers/dwg-parser.service';
import { expandInsertEntities } from './services/dwg-insert-expand';
import { DrawingNormalizerService } from './services/drawing-normalizer.service';
import { DrawingDetectorService } from './services/drawing-detector.service';
import { inferUnitFactor } from './services/drawing-unit';
import * as fs from 'fs';
import * as path from 'path';

// Sinh FIXTURE (detected objects compact) cho benchmark regression. Chạy 1 lần khi có
// DWGDIR; kết quả commit vào __fixtures__ để CI so trước/sau KHÔNG cần file DWG.
const DIR = process.env.DWGDIR;
const FILES: [string, string][] = [
  ['KT', 'F550-BENH XA LD - Thdinh.dwg'],
  ['KC', 'KC BENH XA LU550-V3-Thdinh.dwg'],
  ['DIEN', 'DIEN BENH XA LU DOAN 550-Thdinh.dwg'],
  ['NUOC', 'NƯỚC- BENH XA LU 550 - Thdinh.dwg'],
];

(DIR ? describe : describe.skip)('generate benchmark fixtures', () => {
  jest.setTimeout(600_000);
  it('detect 4 bản → __fixtures__/*.json', async () => {
    const outDir = path.join(__dirname, '__fixtures__');
    fs.mkdirSync(outDir, { recursive: true });
    for (const [disc, fname] of FILES) {
      const parser = new DwgParserService();
      let result: any = await parser.parse(`${DIR}/${fname}`);
      const blocks = (result.metadata?.blocks ?? {}) as any;
      result = { ...result, pages: result.pages.map((p: any) => ({ ...p, entities: expandInsertEntities(p.entities, blocks) })) };
      const raw = new DrawingNormalizerService().fromPages('probe', result.pages);
      const uf = inferUnitFactor(result);
      const det = new DrawingDetectorService().detect(raw, [], uf, disc);
      // Compact: chỉ field engine cần (đủ chạy takeoff pure functions).
      const compact = det.map((o: any) => ({
        type: o.objectType,
        rawType: o.rawType,
        ambiguous: o.detection?.ambiguous ?? false,
        boundingBox: {
          x: Math.round(o.boundingBox.x), y: Math.round(o.boundingBox.y),
          w: Math.round(o.boundingBox.w), h: Math.round(o.boundingBox.h),
        },
        geometry: (o.geometry ?? []).map((p: number[]) => [Math.round(p[0]), Math.round(p[1])]),
      }));
      fs.writeFileSync(path.join(outDir, `${disc}.json`), JSON.stringify({ discipline: disc, unitFactor: uf ?? null, objects: compact }));
      console.log(`${disc}: ${compact.length} objects → __fixtures__/${disc}.json`);
    }
  });
});
