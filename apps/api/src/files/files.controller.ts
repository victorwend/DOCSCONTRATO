import { Controller, ForbiddenException, Get, Inject, NotFoundException, Param, Query, Req, Res } from '@nestjs/common';
import type { Response } from 'express';
import { ENV, Env } from '../config/env';
import { AuditService } from '../audit/audit.service';
import { assertUuid, AuthedRequest, clientIp, Public, RequirePermission } from '../common/http';
import { verifyFileUrl } from '../storage/storage';
import { Db } from '../db/pool';
import { FilesService } from './files.service';

function contentDisposition(disp: 'inline' | 'attachment', name: string) {
  const ascii = name.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '');
  return `${disp}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

@Controller('files')
export class FilesController {
  constructor(
    private readonly files: FilesService,
    private readonly audit: AuditService,
    private readonly db: Db,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /** Gera URL temporária (expira em SIGNED_URL_TTL_SECONDS) para visualizar/baixar um arquivo. */
  @Get(':id/url')
  @RequirePermission('files.read')
  async url(@Param('id') id: string, @Query('disposition') disposition: string, @Req() req: AuthedRequest) {
    assertUuid(id);
    const f = await this.files.getFile(id);
    const disp = disposition === 'attachment' ? 'attachment' : 'inline';
    await this.audit.log(
      { type: 'USER', userId: req.user!.id, name: req.user!.name, ip: clientIp(req), userAgent: req.headers['user-agent'] ?? null },
      disp === 'attachment' ? 'FILE_DOWNLOADED' : 'FILE_VIEWED',
      { requestId: f.request_id, entityType: 'file', entityId: f.id, details: { name: f.original_name, kind: f.kind } },
    );
    return { url: await this.files.temporaryUrl(f, disp, req.user!.id) };
  }

  /** Entrega o arquivo a partir de uma URL assinada (HMAC + expiração). */
  @Public()
  @Get('signed/:token')
  async signed(@Param('token') token: string, @Res() res: Response) {
    const claims = verifyFileUrl(this.env.FILE_URL_SECRET, token);
    if (!claims) throw new ForbiddenException('Link expirado ou inválido. Abra o arquivo novamente pelo painel.');
    const user = await this.db.maybe('select 1 from users where id = $1 and active', [claims.uid]);
    if (!user) throw new ForbiddenException('Usuário inativo.');
    const f = await this.files.getFile(claims.fid).catch(() => null);
    if (!f) throw new NotFoundException('Arquivo não encontrado');
    const data = await this.files.read(f);
    res.setHeader('Content-Type', f.mime_type);
    res.setHeader('Content-Length', String(data.length));
    res.setHeader('Content-Disposition', contentDisposition(claims.disp, claims.n ?? f.original_name));
    res.setHeader('Cache-Control', 'private, no-store, max-age=0');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // imagens são servidas em sandbox (sem scripts). PDFs não: o visualizador do Chrome não abre PDF em sandbox;
    // eles são exibidos pelo visualizador nativo do navegador, que não executa JavaScript do documento.
    if (f.mime_type !== 'application/pdf') {
      res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'");
    } else {
      res.removeHeader('Content-Security-Policy'); // object-src 'none' (helmet) impede o visualizador de PDF do Chrome
    }
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.end(data);
  }
}
