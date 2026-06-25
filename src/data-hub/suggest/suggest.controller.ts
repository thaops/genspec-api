import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../common/jwt-auth.guard';
import { CatalogDbService } from '../catalog/catalog-db.service';

@UseGuards(JwtAuthGuard)
@Controller('suggest')
export class SuggestController {
  constructor(private readonly catalog: CatalogDbService) {}

  /**
   * GET /suggest?q=AB.25&limit=10
   * Returns top matches — code prefix first, then full-text
   */
  @Get()
  async suggest(
    @Query('q') q: string,
    @Query('limit') limit?: string,
  ) {
    const n = Math.min(parseInt(limit ?? '10', 10) || 10, 50);
    const items = await this.catalog.suggest(q ?? '', n);
    return {
      q,
      count: items.length,
      items: items.map((c: any) => ({
        code: c.code,
        name: c.name,
        unit: c.unit,
        group: c.group,
        material: c.material,
        labor: c.labor,
        machine: c.machine,
        trust: c.trust,
        sourceId: c.sourceId,
      })),
    };
  }
}
