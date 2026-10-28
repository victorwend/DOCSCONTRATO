import { Inject, Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { ENV, Env } from '../config/env';
import { Db } from '../db/pool';
import { AuditService } from '../audit/audit.service';
import { STORAGE } from '../core/tokens';
import { StorageDriver } from '../storage/storage';
import { RequestsService } from '../requests/requests.service';

/**
 * Rotinas periódicas:
 *  - expiração de links (a cada 10 min)
 *  - política de retenção (diária, somente se RETENTION_AUTO_PURGE=true e RETENTION_DAYS>0):
 *    remove os ARQUIVOS de processos finalizados/cancelados há mais de N dias. Metadados,
 *    histórico e auditoria são mantidos.
 */
@Injectable()
export class JobsService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(JobsService.name);
  private timers: NodeJS.Timeout[] = [];

  constructor(
    private readonly db: Db,
    private readonly requests: RequestsService,
    private readonly audit: AuditService,
    @Inject(STORAGE) private readonly storage: StorageDriver,
    @Inject(ENV) private readonly env: Env,
  ) {}

  onApplicationBootstrap() {
    if (this.env.NODE_ENV === 'test') return;
    const safe = (fn: () => Promise<unknown>, name: string) => () => fn().catch((e) => this.logger.error(`${name}: ${(e as Error).message}`));
    setTimeout(safe(() => this.expireLinks(), 'expiração'), 5_000).unref();
    this.timers.push(setInterval(safe(() => this.expireLinks(), 'expiração'), 10 * 60_000));
    if (this.env.RETENTION_AUTO_PURGE && this.env.RETENTION_DAYS > 0) {
      this.timers.push(setInterval(safe(() => this.purge(), 'retenção'), 24 * 3600_000));
    }
    this.timers.forEach((t) => t.unref());
  }

  onModuleDestroy() {
    this.timers.forEach(clearInterval);
  }

  async expireLinks() {
    const rows = await this.db.many<{ id: string }>(
      `select id from requests where status in ('AGUARDANDO_DOCUMENTOS','EM_CONFERENCIA','PENDENCIA') and link_expires_at < now()`,
    );
    for (const r of rows) await this.requests.recalc(r.id, { type: 'SYSTEM' });
    if (rows.length) this.logger.log(`${rows.length} solicitação(ões) marcadas como expiradas.`);
  }

  async purge(dryRun = false) {
    const rows = await this.db.many<{ id: string }>(
      `select id from requests where purged_at is null and status in ('FINALIZADO','CANCELADO')
          and coalesce(finalized_at, cancelled_at) < now() - make_interval(days => $1)`,
      [this.env.RETENTION_DAYS],
    );
    if (dryRun) return rows.map((r) => r.id);
    for (const r of rows) {
      const files = await this.db.many<{ id: string; storage_key: string }>('select id, storage_key from files where request_id = $1 and purged_at is null', [r.id]);
      for (const f of files) {
        await this.storage.remove(f.storage_key).catch((e) => this.logger.warn(`retenção: ${f.storage_key}: ${e.message}`));
        await this.db.exec('update files set purged_at = now() where id = $1', [f.id]);
      }
      await this.db.exec('update requests set purged_at = now() where id = $1', [r.id]);
      await this.audit.log({ type: 'SYSTEM' }, 'FILES_PURGED', { requestId: r.id, details: { files: files.length, retentionDays: this.env.RETENTION_DAYS } });
    }
    return rows.map((r) => r.id);
  }
}
