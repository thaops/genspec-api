import { Injectable, Logger } from '@nestjs/common';
import * as fs from 'fs';
import type {
  DrawingParserInterface,
  DrawingParseResult,
  ParsedPage,
  RawEntity,
} from './drawing-parser.interface';

@Injectable()
export class DxfParserService implements DrawingParserInterface {
  readonly supportedExtensions = ['dxf'];
  private readonly logger = new Logger(DxfParserService.name);

  async parse(filePath: string): Promise<DrawingParseResult> {
    const raw = fs.readFileSync(filePath);
    // Detect binary DWG mistakenly routed to DXF parser
    if (raw.length >= 4 && raw.toString('ascii', 0, 4) === 'AC10') {
      throw new Error(`File is a binary DWG (${raw.toString('ascii', 0, 6)}), not DXF. Upload as .dwg or re-export as ASCII DXF from AutoCAD.`);
    }
    const content = raw.toString('utf-8');
    const lines   = content.split(/\r?\n/);

    const layers: Array<{ name: string; color?: number }> = [];
    const entities: RawEntity[] = [];
    let extMin = { x: 0, y: 0 };
    let extMax = { x: 1000, y: 1000 };

    let i = 0;
    let inEntities = false;
    let inTables   = false;

    while (i < lines.length) {
      const code  = lines[i]?.trim();
      const value = lines[i + 1]?.trim() ?? '';
      i += 2;

      if (code === '0' && value === 'SECTION') {
        const sectionName = lines[i + 1]?.trim() ?? '';
        inEntities = sectionName === 'ENTITIES';
        inTables   = sectionName === 'TABLES';
        continue;
      }
      if (code === '0' && value === 'ENDSEC') { inEntities = false; inTables = false; continue; }

      if (code === '9' && value === '$EXTMIN') {
        extMin = { x: parseFloat(lines[i + 1]?.trim() ?? '0'), y: parseFloat(lines[i + 3]?.trim() ?? '0') };
        i += 6; continue;
      }
      if (code === '9' && value === '$EXTMAX') {
        extMax = { x: parseFloat(lines[i + 1]?.trim() ?? '1000'), y: parseFloat(lines[i + 3]?.trim() ?? '1000') };
        i += 6; continue;
      }

      if (inTables && code === '0' && value === 'LAYER') {
        const { data, consumed } = this.readGroup(lines, i);
        i += consumed;
        layers.push({ name: data['2'] ?? '0', color: data['62'] ? parseInt(data['62'], 10) : undefined });
        continue;
      }

      if (inEntities && code === '0') {
        const supported = new Set([
          'LINE','LWPOLYLINE','POLYLINE','CIRCLE','ARC',
          'TEXT','MTEXT','DIMENSION','LEADER','MULTILEADER',
          'INSERT','HATCH','VIEWPORT','SPLINE',
        ]);
        if (supported.has(value)) {
          const { data, consumed } = this.readGroup(lines, i);
          i += consumed;
          entities.push(this.groupToEntity(value, data));
        }
      }
    }

    const page: ParsedPage = {
      pageNumber: 1,
      width:  extMax.x - extMin.x,
      height: extMax.y - extMin.y,
      text: entities.filter((e) => e.text).map((e) => e.text).join(' '),
      entities,
    };

    this.logger.log(`DXF parsed: ${layers.length} layers, ${entities.length} entities`);
    return {
      pages: [page],
      layers,
      extMin,
      extMax,
      metadata: {},
      parserVersion: 'dxf-ascii@1',
    };
  }

  private readGroup(lines: string[], start: number): { data: Record<string, string>; consumed: number } {
    const data: Record<string, string> = {};
    let j = start;
    while (j < lines.length) {
      const c = lines[j]?.trim();
      if (c === '0') break;
      if (c !== undefined) data[c] = lines[j + 1]?.trim() ?? '';
      j += 2;
    }
    return { data, consumed: j - start };
  }

  private groupToEntity(type: string, g: Record<string, string>): RawEntity {
    return {
      type,
      layer:     g['8'] ?? '0',
      x:         parseFloat(g['10'] ?? '0'),
      y:         parseFloat(g['20'] ?? '0'),
      x2:        g['11'] !== undefined ? parseFloat(g['11']) : undefined,
      y2:        g['21'] !== undefined ? parseFloat(g['21']) : undefined,
      radius:    g['40'] !== undefined ? parseFloat(g['40']) : undefined,
      text:      g['1'] ?? g['3'],
      blockName: g['2'],
      properties: {
        handle: g['5'] ?? '',
        color:  g['62'] ?? '',
      },
    };
  }
}
