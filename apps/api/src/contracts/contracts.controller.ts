import { Body, Controller, Delete, Get, Param, Post, Put, Query, Req, Res, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import type { Response } from 'express';
import { assertUuid, AuthedRequest, parse, RequirePermission, userActor } from '../common/http';
import { createContractSchema, templateMetaSchema, templateUpdateSchema, valuesSchema } from './contracts.schema';
import { ContractsService, DOCX_MIME } from './contracts.service';
import type { Actor } from '../audit/audit.service';
import type { IncomingFile } from '../files/files.service';

const actor = (req: AuthedRequest) => userActor(req) as Actor & { type: 'USER' };

function sendDocx(res: Response, buffer: Buffer, name: string) {
  const ascii = name.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '');
  res.setHeader('Content-Type', DOCX_MIME);
  res.setHeader('Content-Length', String(buffer.length));
  res.setHeader('Content-Disposition', `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`);
  res.setHeader('Cache-Control', 'private, no-store, max-age=0');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.end(buffer);
}

const emptyToNull = (v: unknown) => (v === '' || v === 'null' || v === undefined ? null : v);

@Controller('contract-templates')
export class ContractTemplatesController {
  constructor(private readonly contracts: ContractsService) {}

  @Get()
  @RequirePermission('models.read', 'requests.manage')
  list(@Query('active') active?: string) {
    return this.contracts.listTemplates(active === 'true');
  }

  @Post()
  @RequirePermission('models.manage')
  @UseInterceptors(FileInterceptor('file', { storage: memoryStorage(), limits: { fileSize: 15 * 1024 * 1024, files: 1, fields: 10 } }))
  create(@UploadedFile() file: IncomingFile | undefined, @Body() body: Record<string, unknown>, @Req() req: AuthedRequest) {
    const meta = parse(templateMetaSchema, { name: body.name, description: emptyToNull(body.description), modelId: emptyToNull(body.modelId) });
    return this.contracts.createTemplate(file, meta, actor(req));
  }

  @Get(':id')
  @RequirePermission('models.read')
  get(@Param('id') id: string) {
    assertUuid(id);
    return this.contracts.getTemplate(id);
  }

  @Put(':id')
  @RequirePermission('models.manage')
  async update(@Param('id') id: string, @Body() body: unknown, @Req() req: AuthedRequest) {
    assertUuid(id);
    await this.contracts.updateTemplate(id, parse(templateUpdateSchema, body), actor(req));
    return { ok: true };
  }

  @Get(':id/original')
  @RequirePermission('models.read')
  async original(@Param('id') id: string, @Res() res: Response) {
    assertUuid(id);
    const f = await this.contracts.templateOriginal(id);
    sendDocx(res, f.buffer, f.name);
  }

  @Get(':id/preview')
  @RequirePermission('models.read')
  async preview(@Param('id') id: string, @Res() res: Response) {
    assertUuid(id);
    const f = await this.contracts.templatePreview(id);
    sendDocx(res, f.buffer, f.name);
  }
}

@Controller('requests/:requestId/contracts')
export class RequestContractsController {
  constructor(private readonly contracts: ContractsService) {}

  @Get()
  @RequirePermission('requests.read')
  list(@Param('requestId') requestId: string) {
    assertUuid(requestId);
    return this.contracts.listForRequest(requestId);
  }

  @Post()
  @RequirePermission('requests.manage')
  create(@Param('requestId') requestId: string, @Body() body: unknown, @Req() req: AuthedRequest) {
    assertUuid(requestId);
    return this.contracts.createForRequest(requestId, parse(createContractSchema, body).templateId, actor(req));
  }

  @Put(':id')
  @RequirePermission('requests.manage')
  save(@Param('requestId') requestId: string, @Param('id') id: string, @Body() body: unknown, @Req() req: AuthedRequest) {
    assertUuid(requestId);
    assertUuid(id);
    return this.contracts.saveValues(requestId, id, parse(valuesSchema, body).values, actor(req));
  }

  @Post(':id/refill')
  @RequirePermission('requests.manage')
  refill(@Param('requestId') requestId: string, @Param('id') id: string, @Req() req: AuthedRequest) {
    assertUuid(requestId);
    assertUuid(id);
    return this.contracts.refill(requestId, id, actor(req));
  }

  @Post(':id/extract')
  @RequirePermission('requests.manage')
  extract(@Param('requestId') requestId: string, @Param('id') id: string, @Body() body: { overwrite?: boolean } | undefined, @Req() req: AuthedRequest) {
    assertUuid(requestId);
    assertUuid(id);
    return this.contracts.extract(requestId, id, actor(req), { overwrite: body?.overwrite === true });
  }

  @Post(':id/confirm')
  @RequirePermission('documents.review', 'requests.manage')
  async confirm(@Param('requestId') requestId: string, @Param('id') id: string, @Req() req: AuthedRequest) {
    assertUuid(requestId);
    assertUuid(id);
    await this.contracts.confirm(requestId, id, actor(req));
    return { ok: true };
  }

  @Post(':id/generate')
  @RequirePermission('pdf.generate')
  generate(@Param('requestId') requestId: string, @Param('id') id: string, @Req() req: AuthedRequest) {
    assertUuid(requestId);
    assertUuid(id);
    return this.contracts.generate(requestId, id, actor(req));
  }

  @Delete(':id')
  @RequirePermission('requests.manage')
  async remove(@Param('requestId') requestId: string, @Param('id') id: string, @Req() req: AuthedRequest) {
    assertUuid(requestId);
    assertUuid(id);
    await this.contracts.remove(requestId, id, actor(req));
    return { ok: true };
  }
}
