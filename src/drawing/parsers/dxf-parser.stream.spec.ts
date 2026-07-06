import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DxfParserService } from './dxf-parser.service';

// DXF is code/value line pairs. Build one covering every construct the streaming
// parser must handle: HEADER units, TABLES layer, a BLOCK with a LINE, then an
// ENTITIES section exercising LINE/CIRCLE/LWPOLYLINE/POLYLINE+VERTEX+SEQEND, an
// INSERT that expands the block, and a DIMENSION (extra).
function pairs(...tokens: (string | number)[]): string {
  return tokens.join('\n');
}

const DXF = pairs(
  0, 'SECTION', 2, 'HEADER',
  9, '$INSUNITS', 70, 4,
  0, 'ENDSEC',
  0, 'SECTION', 2, 'TABLES',
  0, 'LAYER', 2, 'WALL', 62, 5,
  0, 'ENDSEC',
  0, 'SECTION', 2, 'BLOCKS',
  0, 'BLOCK', 2, 'DETAIL', 10, 0, 20, 0,
  0, 'LINE', 8, '0', 10, 0, 20, 0, 11, 1, 21, 1,
  0, 'ENDBLK',
  0, 'ENDSEC',
  0, 'SECTION', 2, 'ENTITIES',
  0, 'LINE', 8, 'WALL', 10, 0, 20, 0, 11, 10, 21, 0,
  0, 'CIRCLE', 8, 'WALL', 10, 5, 20, 5, 40, 2,
  0, 'LWPOLYLINE', 8, 'WALL', 90, 3, 70, 0, 10, 0, 20, 0, 10, 4, 20, 0, 10, 4, 20, 3,
  0, 'POLYLINE', 8, 'WALL',
  0, 'VERTEX', 10, 0, 20, 0,
  0, 'VERTEX', 10, 2, 20, 2,
  0, 'SEQEND',
  0, 'INSERT', 2, 'DETAIL', 8, 'WALL', 10, 100, 20, 100,
  0, 'DIMENSION', 8, 'WALL',
  0, 'ENDSEC',
  0, 'EOF',
);

describe('DxfParserService — streaming parity', () => {
  const svc = new DxfParserService();

  it('parseFileStreaming produces the same document as parseContent', async () => {
    const tmp = path.join(os.tmpdir(), `parity-${process.pid}.dxf`);
    fs.writeFileSync(tmp, DXF, 'utf-8');
    try {
      const sync = svc.parseContent(DXF);
      const streamed = await svc.parseFileStreaming(tmp);

      expect(streamed.units).toBe(sync.units);
      expect(streamed.layers).toEqual(sync.layers);
      // Entities identical (kind, geometry, transforms — incl. expanded INSERT)
      expect(JSON.stringify(streamed.entities)).toBe(JSON.stringify(sync.entities));
      expect(streamed.extras.length).toBe(sync.extras.length);

      // Sanity: the constructs actually landed
      expect(streamed.units).toBe('mm');
      expect(streamed.layers.map((l) => l.name)).toContain('WALL');
      expect(streamed.entities.length).toBe(sync.entities.length);
      expect(streamed.entities.length).toBeGreaterThanOrEqual(5); // line, circle, 2×pline, expanded insert line
      expect(streamed.extras.length).toBe(1); // DIMENSION
    } finally {
      fs.unlinkSync(tmp);
    }
  });
});
