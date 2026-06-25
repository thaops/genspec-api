import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../common/jwt-auth.guard';
import { SourceRegistryService } from '../sources/source-registry.service';
import { CrawlerRunnerService } from '../crawlers/crawler-runner.service';
import { ReviewAgentService } from '../agents/review-agent.service';
import { PriceAgentService } from '../agents/price-agent.service';
import { LegalAgentService } from '../agents/legal-agent.service';

@UseGuards(JwtAuthGuard)
@Controller('data-hub')
export class DataHubAdminController {
  constructor(
    private readonly sources: SourceRegistryService,
    private readonly runner: CrawlerRunnerService,
    private readonly reviewAgent: ReviewAgentService,
    private readonly priceAgent: PriceAgentService,
    private readonly legalAgent: LegalAgentService,
  ) {}

  /** GET /data-hub/sources */
  @Get('sources')
  async listSources() {
    return this.sources.all();
  }

  /** POST /data-hub/sources/:sourceId/crawl */
  @Post('sources/:sourceId/crawl')
  async triggerCrawl(@Param('sourceId') sourceId: string) {
    const jobId = await this.runner.runSource(sourceId, 'manual');
    return { jobId, sourceId, status: 'running' };
  }

  /** GET /data-hub/jobs */
  @Get('jobs')
  async listJobs(
    @Query('sourceId') sourceId?: string,
    @Query('limit') limit?: string,
  ) {
    return this.runner.listJobs(sourceId, parseInt(limit ?? '20', 10) || 20);
  }

  /**
   * POST /data-hub/agents/review
   * Body: { rows: [...], province?: string }
   */
  @Post('agents/review')
  async runReview(@Body() body: {
    rows: Array<{ code?: string; name: string; unit: string; quantity: number; unitPrice: number; formula?: string }>;
    province?: string;
  }) {
    return this.reviewAgent.review(body.rows, body.province);
  }

  /**
   * POST /data-hub/agents/price
   * Body: { rows: [...], province?: string }
   */
  @Post('agents/price')
  async runPriceUpdate(@Body() body: {
    rows: Array<{ name: string; unit: string; currentPrice: number; rowIndex: number }>;
    province?: string;
  }) {
    return this.priceAgent.generatePriceProposals(body.rows, body.province);
  }

  /**
   * GET /data-hub/agents/legal?q=thong+tu+13&province=HCM
   */
  @Get('agents/legal')
  async runLegal(
    @Query('q') q: string,
    @Query('province') province?: string,
  ) {
    return this.legalAgent.search(q, province);
  }
}
