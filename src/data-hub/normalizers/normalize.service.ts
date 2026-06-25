import { Injectable } from '@nestjs/common';

const UNIT_MAP: Record<string, string> = {
  'm3': 'm³', 'm³': 'm³', '100m3': '100m³', '100m³': '100m³',
  'm2': 'm²', 'm²': 'm²', '100m2': '100m²',
  'km': 'km', 'km2': 'km²',
  'tan': 'tấn', 't': 'tấn',
  'kg': 'kg',
  'cai': 'cái',
  'bo': 'bộ',
  'lit': 'lít', 'l': 'lít',
  'vnd': 'đồng', 'vnđ': 'đồng',
};

const MATERIAL_MAP: Record<string, string> = {
  'xi mang pcb40': 'xi_mang_pcb40',
  'xi mang pcb 40': 'xi_mang_pcb40',
  'ximang pcb40': 'xi_mang_pcb40',
  'thep ct3': 'thep_ct3',
  'thep phi 6': 'thep_phi6',
  'cat vang': 'cat_vang',
  'da dam 1x2': 'da_dam_1x2',
  'gach the xay': 'gach_xay',
  'gach xay 220': 'gach_xay_220',
};

@Injectable()
export class NormalizeService {
  stripAccents(s: string): string {
    return s
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/đ/g, 'd')
      .replace(/Đ/g, 'D');
  }

  toSearchKey(s: string): string {
    return this.stripAccents(s).toLowerCase().replace(/\s+/g, ' ').trim();
  }

  normalizeUnit(raw: string): string {
    const k = raw.trim().toLowerCase();
    const stripped = this.stripAccents(k);
    // Check Vietnamese form first, then stripped
    return UNIT_MAP[k] ?? UNIT_MAP[stripped] ?? raw.trim();
  }

  toMaterialId(raw: string): string | null {
    const key = this.toSearchKey(raw);
    return MATERIAL_MAP[key] ?? null;
  }

  normalizeNameForMatch(name: string): string {
    return this.toSearchKey(name)
      .replace(/\s+/g, '_')
      .replace(/[^a-z0-9_]/g, '')
      .slice(0, 80);
  }

  parsePrice(raw: string): number {
    const cleaned = raw
      .replace(/[^\d,.]/g, '')
      .replace(/\.(?=\d{3}(?:[,.]|$))/g, '')
      .replace(',', '.');
    return parseFloat(cleaned) || 0;
  }
}
