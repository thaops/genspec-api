/**
 * Unified parser contract — all file-type parsers implement this.
 *
 * Adding IfcParser / ImageParser / DwgParser:
 *   1. Implement DrawingParserInterface
 *   2. Register in DrawingParserFactory
 *   3. Pipeline (DrawingParserService) does not change
 */

export interface RawEntity {
  type: string;          // entity type from source format (LINE, TEXT, IFC_BEAM, etc.)
  layer: string;
  x: number;
  y: number;
  x2?: number;
  y2?: number;
  radius?: number;
  text?: string;
  blockName?: string;
  page?: number;
  vertices?: number[][];  // multi-vertex entities (LWPOLYLINE, SPLINE, POLYLINE)
  attribs?: RawEntity[];  // INSERT attribute texts — coordinates already in WORLD space
  properties: Record<string, string | number>;
}

export interface ParsedPage {
  pageNumber: number;
  label?: string;
  width: number;
  height: number;
  text: string;        // full-text content of the page
  entities: RawEntity[];
}

export interface DrawingParseResult {
  pages: ParsedPage[];
  layers: Array<{ name: string; color?: number; visible?: boolean }>;
  extMin: { x: number; y: number };
  extMax: { x: number; y: number };
  metadata: Record<string, unknown>;
  parserVersion: string;
}

export interface DrawingParserInterface {
  readonly supportedExtensions: string[];
  parse(filePath: string): Promise<DrawingParseResult>;
}
