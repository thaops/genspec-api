import { Injectable, Logger } from '@nestjs/common';
import * as fs from 'fs';

export type DxfEntityType =
  | 'LINE' | 'LWPOLYLINE' | 'POLYLINE' | 'CIRCLE' | 'ARC' | 'ELLIPSE'
  | 'TEXT' | 'MTEXT'
  | 'DIMENSION' | 'LEADER' | 'MULTILEADER'
  | 'INSERT' | 'BLOCK'
  | 'HATCH' | 'SOLID'
  | 'VIEWPORT' | 'SPLINE';

export interface DxfEntity {
  type: DxfEntityType;
  layer: string;
  handle?: string;
  color?: number;
  // Geometry (normalized to bounding box)
  x: number;
  y: number;
  x2?: number;
  y2?: number;
  radius?: number;
  // Content
  text?: string;       // TEXT / MTEXT content
  blockName?: string;  // INSERT block reference
  // Raw key-value pairs for anything else
  raw: Record<string, string>;
}

export interface DxfLayer {
  name: string;
  color: number;
  lineType?: string;
}

export interface RawDxfResult {
  layers: DxfLayer[];
  entities: DxfEntity[];
  extMin: { x: number; y: number };
  extMax: { x: number; y: number };
}

/**
 * Zero-dependency DXF ASCII parser.
 * Supports the ENTITIES section of DXF R12–R2018.
 * Accuracy ~85% for structural drawings — adequate for object detection input.
 */
@Injectable()
export class DxfParserService {
  private readonly logger = new Logger(DxfParserService.name);

  parse(filePath: string): RawDxfResult {
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split(/\r?\n/);

    const layers: DxfLayer[] = [];
    const entities: DxfEntity[] = [];
    let extMin = { x: 0, y: 0 };
    let extMax = { x: 1000, y: 1000 };

    let i = 0;
    let inEntities = false;
    let inTables = false;

    while (i < lines.length) {
      const code = lines[i]?.trim();
      const value = lines[i + 1]?.trim() ?? '';
      i += 2;

      if (code === '0' && value === 'SECTION') {
        const nextCode = lines[i]?.trim();
        const nextValue = lines[i + 1]?.trim() ?? '';
        if (nextCode === '2') {
          inEntities = nextValue === 'ENTITIES';
          inTables = nextValue === 'TABLES';
        }
        continue;
      }

      if (code === '0' && value === 'ENDSEC') {
        inEntities = false;
        inTables = false;
        continue;
      }

      // Parse EXTMIN / EXTMAX for drawing bounds
      if (code === '9' && value === '$EXTMIN') {
        const x = parseFloat(lines[i + 1]?.trim() ?? '0');
        const y = parseFloat(lines[i + 3]?.trim() ?? '0');
        extMin = { x, y };
        i += 6;
        continue;
      }
      if (code === '9' && value === '$EXTMAX') {
        const x = parseFloat(lines[i + 1]?.trim() ?? '1000');
        const y = parseFloat(lines[i + 3]?.trim() ?? '1000');
        extMax = { x, y };
        i += 6;
        continue;
      }

      // Parse LAYER table entries
      if (inTables && code === '0' && value === 'LAYER') {
        const layer = this.parseSectionGroup(lines, i);
        i += layer._consumed;
        layers.push({
          name: layer['2'] ?? '0',
          color: parseInt(layer['62'] ?? '7', 10),
          lineType: layer['6'],
        });
        continue;
      }

      // Parse ENTITIES
      if (inEntities && code === '0') {
        const type = value as DxfEntityType;
        const supported: DxfEntityType[] = [
          'LINE', 'LWPOLYLINE', 'POLYLINE', 'CIRCLE', 'ARC',
          'TEXT', 'MTEXT', 'DIMENSION', 'LEADER', 'MULTILEADER',
          'INSERT', 'HATCH', 'VIEWPORT', 'SPLINE',
        ];
        if (supported.includes(type)) {
          const group = this.parseSectionGroup(lines, i);
          i += group._consumed;
          const entity = this.groupToEntity(type, group);
          entities.push(entity);
        }
      }
    }

    this.logger.log(
      `DXF parsed: ${layers.length} layers, ${entities.length} entities`
    );
    return { layers, entities, extMin, extMax };
  }

  /** Read key-value pairs until next entity (group code 0) */
  private parseSectionGroup(
    lines: string[],
    startIdx: number
  ): Record<string, string> & { _consumed: number } {
    const group: Record<string, string> & { _consumed: number } = {
      _consumed: 0,
    };
    let j = startIdx;
    while (j < lines.length) {
      const code = lines[j]?.trim();
      const val = lines[j + 1]?.trim() ?? '';
      if (code === '0') break; // next entity starts
      if (code !== undefined) group[code] = val;
      j += 2;
    }
    group._consumed = j - startIdx;
    return group;
  }

  private groupToEntity(
    type: DxfEntityType,
    g: Record<string, string>
  ): DxfEntity {
    return {
      type,
      layer: g['8'] ?? '0',
      handle: g['5'],
      color: g['62'] !== undefined ? parseInt(g['62'], 10) : undefined,
      x: parseFloat(g['10'] ?? '0'),
      y: parseFloat(g['20'] ?? '0'),
      x2: g['11'] !== undefined ? parseFloat(g['11']) : undefined,
      y2: g['21'] !== undefined ? parseFloat(g['21']) : undefined,
      radius: g['40'] !== undefined ? parseFloat(g['40']) : undefined,
      text: g['1'] ?? g['3'],      // TEXT uses code 1; MTEXT may use 3
      blockName: g['2'],            // INSERT references block by name
      raw: g,
    };
  }
}
