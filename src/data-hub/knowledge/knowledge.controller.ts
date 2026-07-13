import { Controller, Get, Query } from '@nestjs/common';
import { KnowledgeGraphService } from './knowledge-graph.service';

@Controller('data-hub/knowledge')
export class KnowledgeController {
  constructor(private readonly svc: KnowledgeGraphService) {}

  /** Tri thức 1 vật tư → ?name=xi măng&province=TP.HCM */
  @Get('material')
  material(@Query('name') name: string, @Query('province') province?: string) {
    return this.svc.material(name, province);
  }

  /** "Đổi Holcim → Hà Tiên?" → ?from=Holcim&to=Hà Tiên&quantity=100&province= */
  @Get('swap')
  swap(
    @Query('from') from: string,
    @Query('to') to: string,
    @Query('quantity') quantity?: string,
    @Query('province') province?: string,
  ) {
    return this.svc.swap(from, to, quantity ? Number(quantity) : 1, province);
  }
}
