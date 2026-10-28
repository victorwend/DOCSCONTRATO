import { Inject, Injectable, Logger } from '@nestjs/common';
import nodemailer, { Transporter } from 'nodemailer';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ENV, Env } from '../config/env';
import { Db } from '../db/pool';
import { renderTemplate, TemplateName, TemplateVars } from './templates';

export interface Attachment {
  filename: string;
  content: Buffer;
  contentType: string;
}

export interface SendResult {
  ok: boolean;
  logId: string;
  error?: string;
}

/**
 * Serviço de e-mail desacoplado.
 *  EMAIL_DRIVER=smtp -> qualquer SMTP (Gmail/Workspace, Microsoft 365, SES, Resend, Brevo...)
 *  EMAIL_DRIVER=log  -> grava .eml em EMAIL_LOG_DIR (desenvolvimento)
 * Todo envio é registrado em email_logs (destinatário, assunto, status, erro).
 */
@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);
  private transporter: Transporter;

  constructor(@Inject(ENV) private readonly env: Env, private readonly db: Db) {
    if (env.EMAIL_DRIVER === 'smtp') {
      this.transporter = nodemailer.createTransport({
        host: env.SMTP_HOST,
        port: env.SMTP_PORT,
        secure: env.SMTP_SECURE,
        auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASSWORD } : undefined,
      });
    } else {
      this.transporter = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: 'unix' });
    }
  }

  async send(
    template: TemplateName,
    to: string,
    vars: Omit<TemplateVars, 'companyName'>,
    opts: { requestId?: string | null; attachments?: Attachment[] } = {},
  ): Promise<SendResult> {
    const rendered = renderTemplate(template, { ...vars, companyName: this.env.COMPANY_NAME });
    const attachMeta = (opts.attachments ?? []).map((a) => ({ filename: a.filename, size: a.content.length, contentType: a.contentType }));
    const log = await this.db.one<{ id: string }>(
      `insert into email_logs (request_id, template, recipient, subject, status, attachments)
       values ($1, $2, $3, $4, 'PENDING', $5) returning id`,
      [opts.requestId ?? null, template, to, rendered.subject, JSON.stringify(attachMeta)],
    );
    try {
      const info = await this.transporter.sendMail({
        from: this.env.EMAIL_FROM,
        to,
        subject: rendered.subject,
        text: rendered.text,
        html: rendered.html,
        attachments: opts.attachments,
      });
      if (this.env.EMAIL_DRIVER === 'log') {
        await mkdir(this.env.EMAIL_LOG_DIR, { recursive: true });
        const file = join(this.env.EMAIL_LOG_DIR, `${new Date().toISOString().replace(/[:.]/g, '-')}_${log.id}.eml`);
        await writeFile(file, info.message as Buffer);
        this.logger.log(`E-mail (driver log) gravado em ${file}`);
      }
      await this.db.exec(`update email_logs set status='SENT', sent_at=now(), message_id=$2 where id=$1`, [log.id, info.messageId ?? null]);
      return { ok: true, logId: log.id };
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      this.logger.error(`Falha ao enviar e-mail para ${to}: ${error}`);
      await this.db.exec(`update email_logs set status='FAILED', error=$2 where id=$1`, [log.id, error.slice(0, 2000)]);
      return { ok: false, logId: log.id, error };
    }
  }
}
