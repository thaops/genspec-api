import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Res,
  UploadedFile,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor, FilesInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { CatalogService } from '../catalog/catalog.service';
import { CurrentUser } from '../common/current-user.decorator';
import { JwtAuthGuard } from '../common/jwt-auth.guard';
import { CopilotService } from './copilot.service';
import { ActionsDto, CopilotDto, CreateEstimateDto, RepriceDto, TakeoffEngineDto, TakeoffEngineBatchDto } from './dto';
import { EstimateService } from './estimate.service';
import { RepriceService } from './reprice.service';
import { TakeoffEngineService } from './takeoff-engine.service';
import { ExportF1Service } from './export-f1.service';
import { ExportThdtService } from './export-thdt.service';
import { ExportTmdtService } from './export-tmdt.service';

@UseGuards(JwtAuthGuard)
@Controller()
export class EstimateController {
  constructor(
    private readonly estimates: EstimateService,
    private readonly copilot: CopilotService,
    private readonly exporter: ExportF1Service,
    private readonly thdtExporter: ExportThdtService,
    private readonly tmdtExporter: ExportTmdtService,
    private readonly catalog: CatalogService,
    private readonly takeoffEngine: TakeoffEngineService,
    private readonly reprice: RepriceService,
  ) {}

  @Get('catalog')
  searchCatalog(@Query('q') q?: string, @Query('province') province?: string) {
    return this.catalog.search(q, 20, province);
  }

  @Post('estimates')
  create(@CurrentUser('userId') userId: string, @Body() dto: CreateEstimateDto) {
    return this.estimates.create(userId, dto.name);
  }

  @Get('estimates')
  list(@CurrentUser('userId') userId: string) {
    return this.estimates.list(userId);
  }

  @Get('home/feed')
  getHomeFeed(@CurrentUser('userId') _userId: string) {
    return this.copilot.fetchOfficialFeed();
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

  /** Deterministic takeoff: khối lượng tính bằng code từ hình học bản vẽ (KHÔNG LLM, KHÔNG apply — trả proposal). */
  @Post('estimates/:id/takeoff-engine')
  takeoffEngineRun(
    @CurrentUser('userId') userId: string,
    @Param('id') id: string,
    @Body() dto: TakeoffEngineDto,
  ) {
    // ⚡ là hành động chỉnh sửa (chỉ trả proposal, không tự apply) → bật fallback mã phổ thông mặc định trừ khi FE tắt.
    return this.takeoffEngine.run(userId, id, { ...dto, editPermission: dto.editPermission ?? true });
  }

  /** Bóc NHIỀU vùng cùng bản 1 call — BE loop + APPLY tuần tự (cộng dồn theo vùng). */
  @Post('estimates/:id/takeoff-engine/batch')
  takeoffEngineBatch(
    @CurrentUser('userId') userId: string,
    @Param('id') id: string,
    @Body() dto: TakeoffEngineBatchDto,
  ) {
    return this.takeoffEngine.runRegions(userId, id, dto);
  }

  /** Áp đơn giá tỉnh vào giá VL/NC/máy — trả proposal + coverage (KHÔNG tự apply). */
  @Post('estimates/:id/reprice')
  repriceToProvince(
    @CurrentUser('userId') userId: string,
    @Param('id') id: string,
    @Body() dto: RepriceDto,
  ) {
    return this.reprice.plan(userId, id, dto.province);
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
      'Surrogate-Control': 'no-store',
    });
    // Disable Nagle's algorithm so each res.write() is sent immediately as a TCP packet
    (res.socket as any)?.setNoDelay?.(true);
    res.flushHeaders?.();
    try {
      for await (const ev of this.copilot.streamChat(userId, id, dto.message ?? '', files ?? [], dto.activeSheetId, dto.selectedRange, dto.editPermission ?? false, dto.drawingId, dto.objectId, dto.drawingContext, dto.calibrationFactor, dto.chatSessionId)) {
        res.write(`event: ${ev.event}\ndata: ${JSON.stringify(ev.data)}\n\n`);
        (res as any).flush?.();
      }
    } catch (err) {
      res.write(`event: error\ndata: ${JSON.stringify({ message: (err as Error).message })}\n\n`);
    } finally {
      res.end();
    }
  }

  @Post('estimates/:id/import-excel')
  @UseInterceptors(FileInterceptor('file'))
  importExcel(
    @CurrentUser('userId') userId: string,
    @Param('id') id: string,
    @UploadedFile() file: Express.Multer.File,
  ) {
    return this.estimates.importExcel(userId, id, file.buffer);
  }

  @Post('estimates/:id/rollback')
  rollback(
    @CurrentUser('userId') userId: string,
    @Param('id') id: string,
    @Body('patchId') patchId: string,
  ) {
    return this.estimates.rollback(userId, id, patchId);
  }

  @Get('estimates/:id/insights')
  getInsights(@CurrentUser('userId') userId: string, @Param('id') id: string) {
    return this.copilot.generateInsights(userId, id);
  }

  // ── Chat sessions (phiên chat độc lập) ──────────────────────────────────
  @Get('estimates/:id/chat-sessions')
  listChatSessions(@CurrentUser('userId') userId: string, @Param('id') id: string) {
    return this.estimates.listChatSessions(userId, id);
  }

  @Post('estimates/:id/chat-sessions')
  createChatSession(@CurrentUser('userId') userId: string, @Param('id') id: string) {
    return this.estimates.createChatSession(userId, id);
  }

  @Get('estimates/:id/chat-sessions/:sid')
  getChatSession(
    @CurrentUser('userId') userId: string,
    @Param('id') id: string,
    @Param('sid') sid: string,
  ) {
    return this.estimates.getChatSession(userId, id, sid);
  }

  @Put('estimates/:id/chat-sessions/:sid')
  saveChatSession(
    @CurrentUser('userId') userId: string,
    @Param('id') id: string,
    @Param('sid') sid: string,
    @Body('messages') messages: any[],
  ) {
    return this.estimates.saveChatSession(userId, id, sid, messages ?? []);
  }

  @Delete('estimates/:id/chat-sessions/:sid')
  deleteChatSession(
    @CurrentUser('userId') userId: string,
    @Param('id') id: string,
    @Param('sid') sid: string,
  ) {
    return this.estimates.deleteChatSession(userId, id, sid);
  }

  // Endpoint cũ — proxy sang session mới nhất (FE cũ không vỡ)
  @Get('estimates/:id/conversation')
  getConversation(@CurrentUser('userId') userId: string, @Param('id') id: string) {
    return this.estimates.getConversation(userId, id);
  }

  @Post('estimates/:id/conversation')
  saveConversation(
    @CurrentUser('userId') userId: string,
    @Param('id') id: string,
    @Body('messages') messages: any[],
  ) {
    return this.estimates.saveConversation(userId, id, messages ?? []);
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

  @Get('estimates/:id/export-thdt')
  async exportThdt(@CurrentUser('userId') userId: string, @Param('id') id: string, @Res() res: Response) {
    const estimate = await this.estimates.getOne(userId, id);
    const buffer = await this.thdtExporter.build(estimate);
    const safe = estimate.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'du-toan';
    res.set({
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="${safe}-thdt.xlsx"`,
    });
    res.send(buffer);
  }

  @Get('estimates/:id/export-tmdt')
  async exportTmdt(@CurrentUser('userId') userId: string, @Param('id') id: string, @Res() res: Response) {
    const estimate = await this.estimates.getOne(userId, id);
    const buffer = await this.tmdtExporter.build(estimate);
    const safe = estimate.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'du-toan';
    res.set({
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="${safe}-tmdt.xlsx"`,
    });
    res.send(buffer);
  }
}
