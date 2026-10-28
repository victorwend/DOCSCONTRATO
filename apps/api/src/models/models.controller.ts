import { Body, Controller, Get, Param, Patch, Post, Put, Query, Req } from '@nestjs/common';
import { z } from 'zod';
import { assertUuid, AuthedRequest, parse, RequirePermission } from '../common/http';
import { modelSchema } from './models.schema';
import { ModelsService } from './models.service';

@Controller('models')
export class ModelsController {
  constructor(private readonly models: ModelsService) {}

  @Get()
  @RequirePermission('models.read', 'requests.create')
  list(@Query('active') active?: string) {
    return this.models.list(active === 'true');
  }

  @Get(':id')
  @RequirePermission('models.read', 'requests.create')
  get(@Param('id') id: string) {
    assertUuid(id);
    return this.models.get(id);
  }

  @Post()
  @RequirePermission('models.manage')
  async create(@Body() body: unknown, @Req() req: AuthedRequest) {
    const id = await this.models.create(parse(modelSchema, body), req.user!.id);
    return { id };
  }

  @Put(':id')
  @RequirePermission('models.manage')
  async update(@Param('id') id: string, @Body() body: unknown) {
    assertUuid(id);
    await this.models.update(id, parse(modelSchema, body));
    return { id };
  }

  @Post(':id/duplicate')
  @RequirePermission('models.manage')
  async duplicate(@Param('id') id: string, @Req() req: AuthedRequest) {
    assertUuid(id);
    return { id: await this.models.duplicate(id, req.user!.id) };
  }

  @Patch(':id/active')
  @RequirePermission('models.manage')
  async setActive(@Param('id') id: string, @Body() body: unknown) {
    assertUuid(id);
    const { active } = parse(z.object({ active: z.boolean() }), body);
    await this.models.setActive(id, active);
    return { ok: true };
  }
}
