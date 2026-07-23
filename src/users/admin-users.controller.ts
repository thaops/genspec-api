import { Body, Controller, Get, Param, Patch, Delete, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../common/jwt-auth.guard';
import { RolesGuard } from '../common/roles.guard';
import { Roles } from '../common/roles.decorator';
import { CurrentUser } from '../common/current-user.decorator';
import type { AuthUser } from '../common/current-user.decorator';
import { AuditLogService } from '../audit/audit-log.service';
import { UsersService } from './users.service';
import type { UserStatus } from './users.service';

@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('admin')
@Controller('admin/users')
export class AdminUsersController {
  constructor(
    private readonly users: UsersService,
    private readonly audit: AuditLogService,
  ) {}

  @Get()
  list(
    @Query('role') role?: string,
    @Query('status') status?: string,
    @Query('email') email?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.users.findAll(
      { role, status, email },
      parseInt(page ?? '1', 10) || 1,
      Math.min(parseInt(limit ?? '20', 10) || 20, 100),
    );
  }

  @Get(':id')
  async detail(@Param('id') id: string) {
    const doc = await this.users.findById(id);
    return doc ? { id: doc._id.toString(), name: doc.name, email: doc.email, role: doc.role, status: doc.status, lastLoginAt: doc.lastLoginAt } : null;
  }

  @Patch(':id/status')
  async updateStatus(
    @Param('id') id: string,
    @Body('status') status: UserStatus,
    @CurrentUser() actor: AuthUser,
  ) {
    const updated = await this.users.updateStatus(id, status);
    this.audit.record({
      actorId: actor.userId,
      actorEmail: actor.email,
      action: 'user.status_change',
      targetType: 'user',
      targetId: id,
      meta: { status },
    });
    return updated;
  }

  @Patch(':id/role')
  async updateRole(
    @Param('id') id: string,
    @Body('role') role: 'admin' | 'user',
    @CurrentUser() actor: AuthUser,
  ) {
    const updated = await this.users.updateRole(id, role);
    this.audit.record({
      actorId: actor.userId,
      actorEmail: actor.email,
      action: 'user.role_change',
      targetType: 'user',
      targetId: id,
      meta: { role },
    });
    return updated;
  }

  @Delete(':id')
  async remove(@Param('id') id: string, @CurrentUser() actor: AuthUser) {
    const updated = await this.users.softDelete(id);
    this.audit.record({
      actorId: actor.userId,
      actorEmail: actor.email,
      action: 'user.delete',
      targetType: 'user',
      targetId: id,
    });
    return updated;
  }
}
