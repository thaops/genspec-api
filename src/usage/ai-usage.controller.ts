import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../common/jwt-auth.guard';
import { RolesGuard } from '../common/roles.guard';
import { Roles } from '../common/roles.decorator';
import { AiUsageService } from './ai-usage.service';

@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('admin')
@Controller('admin/ai-usage')
export class AiUsageController {
  constructor(private readonly usage: AiUsageService) {}

  @Get()
  list(
    @Query('userId') userId?: string,
    @Query('estimateId') estimateId?: string,
    @Query('model') model?: string,
    @Query('source') source?: string,
    @Query('mode') mode?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.usage.list(
      { userId, estimateId, model, source, mode, from, to },
      parseInt(page ?? '1', 10) || 1,
      Math.min(parseInt(limit ?? '50', 10) || 50, 200),
    );
  }

  @Get('summary')
  summary(
    @Query('userId') userId?: string,
    @Query('estimateId') estimateId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.usage.summary({ userId, estimateId, from, to });
  }
}
