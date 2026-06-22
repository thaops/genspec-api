import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Res,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { CatalogService } from '../catalog/catalog.service';
import { CurrentUser } from '../common/current-user.decorator';
import { JwtAuthGuard } from '../common/jwt-auth.guard';
import { CopilotService } from './copilot.service';
import { ActionsDto, CopilotDto, CreateEstimateDto } from './dto';
import { EstimateService } from './estimate.service';
import { ExportF1Service } from './export-f1.service';

@UseGuards(JwtAuthGuard)
@Controller()
export class EstimateController {
  constructor(
    private readonly estimates: EstimateService,
    private readonly copilot: CopilotService,
    private readonly exporter: ExportF1Service,
    private readonly catalog: CatalogService,
  ) {}

  @Get('catalog')
  searchCatalog(@Query('q') q?: string) {
    return this.catalog.search(q);
  }

  @Post('estimates')
  create(@CurrentUser('userId') userId: string, @Body() dto: CreateEstimateDto) {
    return this.estimates.create(userId, dto.name);
  }

  @Get('estimates')
  list(@CurrentUser('userId') userId: string) {
    return this.estimates.list(userId);
  }

  @Get('estimates/:id')
  getOne(@CurrentUser('userId') userId: string, @Param('id') id: string) {
    return this.estimates.getOne(userId, id);
  }

  @Patch('estimates/:id')
  rename(@CurrentUser('userId') userId: string, @Param('id') id: string, @Body() dto: CreateEstimateDto) {
    return this.estimates.rename(userId, id, dto.name);
  }

  @Delete('estimates/:id')
  remove(@CurrentUser('userId') userId: string, @Param('id') id: string) {
    return this.estimates.remove(userId, id);
  }

  /** Single mutation path: manual edits AND AI-confirmed proposals (FE sends Action[]). */
  @Post('estimates/:id/actions')
  apply(@CurrentUser('userId') userId: string, @Param('id') id: string, @Body() dto: ActionsDto) {
    return this.estimates.applyActions(userId, id, dto.actions ?? [], dto.source ?? 'manual');
  }

  /** Streaming copilot (SSE): live `step` events then a `proposal` (NOT applied). */
  @Post('estimates/:id/copilot/stream')
  @UseInterceptors(FilesInterceptor('files', 14))
  async copilotStream(
    @CurrentUser('userId') userId: string,
    @Param('id') id: string,
    @Body() dto: CopilotDto,
    @Res() res: Response,
    @UploadedFiles() files?: Express.Multer.File[],
  ) {
    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders?.();
    try {
      for await (const ev of this.copilot.streamChat(userId, id, dto.message ?? '', files ?? [])) {
        res.write(`event: ${ev.event}\ndata: ${JSON.stringify(ev.data)}\n\n`);
      }
    } catch (err) {
      res.write(`event: error\ndata: ${JSON.stringify({ message: (err as Error).message })}\n\n`);
    } finally {
      res.end();
    }
  }

  @Get('estimates/:id/export-f1')
  async exportF1(@CurrentUser('userId') userId: string, @Param('id') id: string, @Res() res: Response) {
    const estimate = await this.estimates.getOne(userId, id);
    const buffer = await this.exporter.build(estimate);
    const safe = estimate.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'du-toan';
    res.set({
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="${safe}.xlsx"`,
    });
    res.send(buffer);
  }
}
