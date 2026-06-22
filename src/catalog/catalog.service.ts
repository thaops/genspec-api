import { Injectable } from '@nestjs/common';
import { CATALOG } from './catalog.seed';
import { CatalogItem } from './catalog.types';

@Injectable()
export class CatalogService {
  private readonly items: CatalogItem[] = CATALOG;

  all(): CatalogItem[] {
    return this.items;
  }

  search(q?: string, limit = 20): CatalogItem[] {
    if (!q || !q.trim()) return this.items.slice(0, limit);
    const needle = this.normalize(q);
    return this.items
      .filter(
        (it) =>
          this.normalize(it.code).includes(needle) ||
          this.normalize(it.name).includes(needle) ||
          this.normalize(it.group).includes(needle),
      )
      .slice(0, limit);
  }

  findByCode(code: string): CatalogItem | undefined {
    return this.items.find((it) => it.code.toLowerCase() === code.toLowerCase());
  }

  private normalize(s: string): string {
    return s
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/đ/g, 'd');
  }
}
