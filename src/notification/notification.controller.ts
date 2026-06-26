import { Controller, Get, Param, Patch } from '@nestjs/common';

@Controller('notifications')
export class NotificationController {
  @Get()
  list() {
    return [];
  }

  @Patch(':id/read')
  markRead(@Param('id') _id: string) {
    return { ok: true };
  }
}
