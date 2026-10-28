import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  UploadedFiles,
  UseInterceptors,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { z } from 'zod';
import { assertUuid, AuthedRequest, parse, RequirePermission, userActor } from '../common/http';
import { FilesService, IncomingFile } from '../files/files.service';
import { FinalPdfService } from '../pdf/final-pdf.service';
import { RequestsService } from './requests.service';
import { ReviewService } from './review.service';
import {
  addDocumentSchema,
  answersSchema,
  approveSchema,
  cancelSchema,
  createRequestSchema,
  listQuerySchema,
  previewSchema,
  rejectSchema,
  reorderSchema,
  updateDocumentSchema,
  updateRequestSchema,
} from './requests.schema';

export const UPLOAD_LIMITS = {
  fileSize: Number(process.env.MAX_UPLOAD_MB ?? 20) * 1024 * 1024,
  files: Number(process.env.MAX_FILES_PER_UPLOAD ?? 10),
  fields: 20,
  fieldSize: 64 * 1024,
};

export function parseSides(raw: unknown): Array<'FRONT' | 'BACK' | null> {
  if (raw === undefined || raw === null || raw === '') return [];
  try {
    const arr = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!Array.isArray(arr)) return [];
    return arr.map((s) => (s === 'FRONT' || s === 'BACK' ? s : null));
  } catch {
    throw new BadRequestException('Campo "sides" inválido');
  }
}

@Controller('requests')
export class RequestsController {
  constructor(
    private readonly requests: RequestsService,
    private readonly review: ReviewService,
    private readonly files: FilesService,
    private readonly finalPdf: FinalPdfService,
  ) {}

  // ---- consulta ----------------------------------------------------------
  @Get()
  @RequirePermission('requests.read')
  list(@Query() query: unknown) {
    return this.requests.list(parse(listQuerySchema, query));
  }

  @Get('stats')
  @RequirePermission('requests.read')
  stats() {
    return this.requests.stats();
  }

  @Post('preview')
  @HttpCode(200)
  @RequirePermission('requests.create')
  preview(@Body() body: unknown) {
    const dto = parse(previewSchema, body);
    return this.requests.preview(dto.modelId, dto.answers);
  }

  @Get(':id')
  @RequirePermission('requests.read')
  detail(@Param('id') id: string) {
    assertUuid(id);
    return this.requests.detail(id);
  }

  // ---- criação / edição --------------------------------------------------
  @Post()
  @RequirePermission('requests.create')
  create(@Body() body: unknown, @Req() req: AuthedRequest) {
    return this.requests.create(parse(createRequestSchema, body), userActor(req) as any);
  }

  @Patch(':id')
  @RequirePermission('requests.manage')
  async update(@Param('id') id: string, @Body() body: unknown, @Req() req: AuthedRequest) {
    assertUuid(id);
    await this.requests.update(id, parse(updateRequestSchema, body), userActor(req));
    return { ok: true };
  }

  @Put(':id/answers')
  @RequirePermission('requests.manage', 'documents.review')
  async answers(@Param('id') id: string, @Body() body: unknown, @Req() req: AuthedRequest) {
    assertUuid(id);
    await this.requests.setAnswers(id, parse(answersSchema, body).answers, 'INTERNAL', userActor(req));
    return { ok: true };
  }

  @Post(':id/cancel')
  @HttpCode(200)
  @RequirePermission('requests.manage')
  async cancel(@Param('id') id: string, @Body() body: unknown, @Req() req: AuthedRequest) {
    assertUuid(id);
    await this.requests.cancel(id, parse(cancelSchema, body ?? {}).reason, userActor(req));
    return { ok: true };
  }

  @Post(':id/reopen')
  @HttpCode(200)
  @RequirePermission('requests.manage')
  async reopen(@Param('id') id: string, @Req() req: AuthedRequest) {
    assertUuid(id);
    await this.requests.reopen(id, userActor(req));
    return { ok: true };
  }

  // ---- link --------------------------------------------------------------
  @Post(':id/link')
  @HttpCode(200)
  @RequirePermission('requests.create', 'requests.manage')
  link(@Param('id') id: string, @Body() body: unknown, @Req() req: AuthedRequest) {
    assertUuid(id);
    const { regenerate } = parse(z.object({ regenerate: z.boolean().default(false) }), body ?? {});
    return this.requests.generateLink(id, userActor(req), regenerate);
  }

  @Post(':id/link/active')
  @HttpCode(200)
  @RequirePermission('requests.manage')
  async linkActive(@Param('id') id: string, @Body() body: unknown, @Req() req: AuthedRequest) {
    assertUuid(id);
    await this.requests.setLinkActive(id, parse(z.object({ active: z.boolean() }), body).active, userActor(req));
    return { ok: true };
  }

  @Post(':id/link/sent')
  @HttpCode(200)
  @RequirePermission('requests.create', 'requests.manage')
  async linkSent(@Param('id') id: string, @Body() body: unknown, @Req() req: AuthedRequest) {
    assertUuid(id);
    const { channel } = parse(z.object({ channel: z.enum(['copy', 'share', 'whatsapp', 'email']).default('copy') }), body ?? {});
    await this.requests.markLinkSent(id, channel, userActor(req));
    return { ok: true };
  }

  @Post(':id/link/email')
  @HttpCode(200)
  @RequirePermission('requests.create', 'requests.manage')
  async linkEmail(@Param('id') id: string, @Req() req: AuthedRequest) {
    assertUuid(id);
    const res = await this.requests.sendLinkEmail(id, null, userActor(req));
    if (!res.ok) throw new BadRequestException(`Falha no envio do e-mail: ${res.error}`);
    return { ok: true };
  }

  // ---- checklist ---------------------------------------------------------
  @Post(':id/documents')
  @RequirePermission('requests.manage')
  addDocument(@Param('id') id: string, @Body() body: unknown, @Req() req: AuthedRequest) {
    assertUuid(id);
    return this.requests.addDocument(id, parse(addDocumentSchema, body), userActor(req));
  }

  @Put(':id/documents/order')
  @RequirePermission('requests.manage')
  async reorder(@Param('id') id: string, @Body() body: unknown, @Req() req: AuthedRequest) {
    assertUuid(id);
    await this.requests.reorderDocuments(id, parse(reorderSchema, body).order, userActor(req));
    return { ok: true };
  }

  @Patch(':id/documents/:docId')
  @RequirePermission('requests.manage')
  async updateDocument(@Param('id') id: string, @Param('docId') docId: string, @Body() body: unknown, @Req() req: AuthedRequest) {
    assertUuid(id);
    assertUuid(docId);
    await this.requests.updateDocument(id, docId, parse(updateDocumentSchema, body), userActor(req));
    return { ok: true };
  }

  @Delete(':id/documents/:docId')
  @RequirePermission('requests.manage')
  async removeDocument(@Param('id') id: string, @Param('docId') docId: string, @Req() req: AuthedRequest) {
    assertUuid(id);
    assertUuid(docId);
    await this.requests.removeDocument(id, docId, userActor(req));
    return { ok: true };
  }

  // ---- conferência -------------------------------------------------------
  @Post(':id/documents/:docId/review/start')
  @HttpCode(200)
  @RequirePermission('documents.review')
  startReview(@Param('id') id: string, @Param('docId') docId: string, @Req() req: AuthedRequest) {
    assertUuid(id);
    assertUuid(docId);
    return this.review.startReview(id, docId, userActor(req));
  }

  @Post(':id/documents/:docId/approve')
  @HttpCode(200)
  @RequirePermission('documents.review')
  async approve(@Param('id') id: string, @Param('docId') docId: string, @Body() body: unknown, @Req() req: AuthedRequest) {
    assertUuid(id);
    assertUuid(docId);
    await this.review.approve(id, docId, parse(approveSchema, body ?? {}).note, userActor(req) as any);
    return { ok: true };
  }

  @Post(':id/documents/:docId/reject')
  @HttpCode(200)
  @RequirePermission('documents.review')
  async reject(@Param('id') id: string, @Param('docId') docId: string, @Body() body: unknown, @Req() req: AuthedRequest) {
    assertUuid(id);
    assertUuid(docId);
    const dto = parse(rejectSchema, body);
    await this.review.reject(id, docId, dto.reason, dto.note, dto.notifyApplicant, userActor(req) as any);
    return { ok: true };
  }

  /** Upload interno (ex.: documento recebido por outro canal). */
  @Post(':id/documents/:docId/files')
  @RequirePermission('requests.manage')
  @UseInterceptors(FilesInterceptor('files', UPLOAD_LIMITS.files, { storage: memoryStorage(), limits: UPLOAD_LIMITS }))
  async upload(
    @Param('id') id: string,
    @Param('docId') docId: string,
    @UploadedFiles() files: IncomingFile[],
    @Body() body: Record<string, unknown>,
    @Req() req: AuthedRequest,
  ) {
    assertUuid(id);
    assertUuid(docId);
    await this.requests.getRow(id);
    return this.files.uploadToDocument(id, docId, files ?? [], parseSides(body?.sides), userActor(req), { byApplicant: false });
  }

  @Post(':id/documents/:docId/text')
  @HttpCode(200)
  @RequirePermission('requests.manage')
  async text(@Param('id') id: string, @Param('docId') docId: string, @Body() body: unknown, @Req() req: AuthedRequest) {
    assertUuid(id);
    assertUuid(docId);
    const { value } = parse(z.object({ value: z.string().max(2000) }), body);
    await this.review.submitText(id, docId, value, userActor(req), false);
    return { ok: true };
  }

  /** PDF do documento (frente + verso / várias páginas) já consolidado — ex.: RG.pdf */
  @Get(':id/documents/:docId/pdf')
  @RequirePermission('files.read')
  async documentPdf(@Param('id') id: string, @Param('docId') docId: string, @Query('disposition') disp: string, @Req() req: AuthedRequest) {
    assertUuid(id);
    assertUuid(docId);
    const doc = (await this.requests.detail(id)).documents.find((d) => d.id === docId);
    if (!doc) throw new NotFoundException('Documento não encontrado');
    const f = await this.files.processedFile(id, docId);
    if (!f) throw new NotFoundException('O documento não possui arquivos.');
    const name = `${doc.name.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '').toUpperCase()}.pdf`;
    return { url: await this.files.temporaryUrl(f, disp === 'attachment' ? 'attachment' : 'inline', req.user!.id, name) };
  }

  // ---- PDF final / e-mail ------------------------------------------------
  @Post(':id/final-pdf')
  @HttpCode(200)
  @RequirePermission('pdf.generate')
  generate(@Param('id') id: string, @Body() body: unknown, @Req() req: AuthedRequest) {
    assertUuid(id);
    const { sendEmail } = parse(z.object({ sendEmail: z.boolean().default(true) }), body ?? {});
    return this.finalPdf.generate(id, userActor(req) as any, { sendEmail });
  }

  @Post(':id/final-pdf/email')
  @HttpCode(200)
  @RequirePermission('email.send')
  async resend(@Param('id') id: string, @Req() req: AuthedRequest) {
    assertUuid(id);
    const res = await this.finalPdf.sendFinalEmail(id, userActor(req));
    if (!res.ok) throw new BadRequestException(`Falha no envio do e-mail: ${res.error}`);
    const r = await this.requests.getRow(id);
    if (r.status === 'APROVADO') await this.finalPdf.finalize(id, userActor(req));
    return { ok: true };
  }

  @Post(':id/finalize')
  @HttpCode(200)
  @RequirePermission('pdf.generate')
  async finalize(@Param('id') id: string, @Req() req: AuthedRequest) {
    assertUuid(id);
    await this.finalPdf.finalize(id, userActor(req));
    return { ok: true };
  }
}
