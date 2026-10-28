import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put, Req, UploadedFiles, UseInterceptors } from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import { Throttle } from '@nestjs/throttler';
import { memoryStorage } from 'multer';
import type { Request } from 'express';
import { z } from 'zod';
import { applicantActor, assertUuid, parse, Public } from '../common/http';
import { FilesService, IncomingFile } from '../files/files.service';
import { RequestsService } from '../requests/requests.service';
import { ReviewService } from '../requests/review.service';
import { parseSides, UPLOAD_LIMITS } from '../requests/requests.controller';
import { PortalService } from './portal.service';

/** Rotas públicas acessadas pelo link exclusivo (sem login). Limitadas por IP. */
@Public()
@Throttle({ default: { limit: 120, ttl: 60_000 } })
@Controller('portal/:token')
export class PortalController {
  constructor(
    private readonly portal: PortalService,
    private readonly files: FilesService,
    private readonly review: ReviewService,
    private readonly requests: RequestsService,
  ) {}

  @Get()
  view(@Param('token') token: string, @Req() req: Request) {
    return this.portal.view(token, applicantActor(req));
  }

  @Post('documents/:docId/files')
  @Throttle({ default: { limit: 40, ttl: 60_000 } })
  @UseInterceptors(FilesInterceptor('files', UPLOAD_LIMITS.files, { storage: memoryStorage(), limits: UPLOAD_LIMITS }))
  async upload(
    @Param('token') token: string,
    @Param('docId') docId: string,
    @UploadedFiles() files: IncomingFile[],
    @Body() body: Record<string, unknown>,
    @Req() req: Request,
  ) {
    assertUuid(docId);
    const r = await this.portal.resolve(token, true);
    const note = typeof body?.note === 'string' ? body.note.slice(0, 1000) : null;
    return this.files.uploadToDocument(r.id, docId, files ?? [], parseSides(body?.sides), applicantActor(req, r.applicant_name), {
      byApplicant: true,
      note,
    });
  }

  @Delete('documents/:docId/files/:fileId')
  async removeFile(@Param('token') token: string, @Param('docId') docId: string, @Param('fileId') fileId: string, @Req() req: Request) {
    assertUuid(docId);
    assertUuid(fileId);
    const r = await this.portal.resolve(token, true);
    await this.files.detachFile(r.id, docId, fileId, applicantActor(req, r.applicant_name), true);
    return { ok: true };
  }

  @Post('documents/:docId/text')
  @HttpCode(200)
  async text(@Param('token') token: string, @Param('docId') docId: string, @Body() body: unknown, @Req() req: Request) {
    assertUuid(docId);
    const r = await this.portal.resolve(token, true);
    const { value } = parse(z.object({ value: z.string().max(2000) }), body);
    await this.review.submitText(r.id, docId, value, applicantActor(req, r.applicant_name), true);
    return { ok: true };
  }

  @Post('documents/:docId/not-applicable')
  @HttpCode(200)
  async notApplicable(@Param('token') token: string, @Param('docId') docId: string, @Body() body: unknown, @Req() req: Request) {
    assertUuid(docId);
    const r = await this.portal.resolve(token, true);
    const { justification } = parse(z.object({ justification: z.string().max(1000) }), body);
    await this.review.requestNotApplicable(r.id, docId, justification, applicantActor(req, r.applicant_name));
    return { ok: true };
  }

  @Put('answers')
  async answers(@Param('token') token: string, @Body() body: unknown, @Req() req: Request) {
    const r = await this.portal.resolve(token, true);
    const { answers } = parse(z.object({ answers: z.record(z.unknown()) }), body);
    await this.requests.setAnswers(r.id, answers, 'APPLICANT', applicantActor(req, r.applicant_name));
    return { ok: true };
  }

  @Post('submit')
  @HttpCode(200)
  submit(@Param('token') token: string, @Req() req: Request) {
    return this.portal.resolve(token, true).then((r) => this.portal.submit(token, applicantActor(req, r.applicant_name)));
  }
}
