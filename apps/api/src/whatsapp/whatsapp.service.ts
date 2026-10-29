import { Inject, Injectable, Logger } from '@nestjs/common';
import { ENV, Env } from '../config/env';
import { onlyDigits } from '../domain/text';

/**
 * Avisos pelo WhatsApp usando a API OFICIAL (WhatsApp Cloud API da Meta).
 * Mensagens iniciadas pela empresa exigem um TEMPLATE aprovado pela Meta.
 *
 * Template esperado (categoria "Utilidade", idioma pt_BR), nome em WHATSAPP_TEMPLATE_REJECTED:
 *   Olá, {{1}}. O documento "{{2}}" enviado para a Pavidez Engenharia precisa ser reenviado.
 *   Motivo: {{3}}.
 *   Reenvie pelo link: {{4}}
 *
 * Sem WHATSAPP_TOKEN / WHATSAPP_PHONE_NUMBER_ID o serviço fica desativado e o painel
 * oferece o botão "Avisar pelo WhatsApp" (link oficial wa.me com a mensagem pronta).
 */
export interface RejectionNotice {
  phone: string;
  name: string;
  documentName: string;
  reason: string;
  note: string | null;
  link: string;
}

@Injectable()
export class WhatsappService {
  private readonly logger = new Logger(WhatsappService.name);

  constructor(@Inject(ENV) private readonly env: Env) {}

  get enabled() {
    return !!(this.env.WHATSAPP_TOKEN && this.env.WHATSAPP_PHONE_NUMBER_ID);
  }

  /** Número no formato internacional, só dígitos (Brasil: 55 + DDD + número). */
  static normalizePhone(phone: string | null | undefined): string | null {
    const d = onlyDigits(phone);
    if (d.length === 10 || d.length === 11) return `55${d}`;
    if ((d.length === 12 || d.length === 13) && d.startsWith('55')) return d;
    return null;
  }

  static rejectionText(n: Omit<RejectionNotice, 'phone'>): string {
    const first = n.name.trim().split(/\s+/)[0] ?? n.name;
    return [
      `Olá, ${first}. Aqui é da Pavidez Engenharia.`,
      '',
      `O documento *${n.documentName}* precisa ser enviado novamente.`,
      `Motivo: ${n.reason}${n.note ? ` — ${n.note}` : ''}`,
      '',
      `Reenvie pelo link: ${n.link}`,
    ].join('\n');
  }

  /** Link oficial "clique para conversar" com a mensagem pronta (envio manual pelo RH). */
  static clickToChat(n: RejectionNotice): string | null {
    const to = WhatsappService.normalizePhone(n.phone);
    if (!to) return null;
    return `https://wa.me/${to}?text=${encodeURIComponent(WhatsappService.rejectionText(n))}`;
  }

  async sendRejection(n: RejectionNotice): Promise<{ ok: boolean; error?: string; to?: string }> {
    const to = WhatsappService.normalizePhone(n.phone);
    if (!to) return { ok: false, error: 'Telefone do solicitante inválido para WhatsApp.' };
    if (!this.enabled) return { ok: false, error: 'WhatsApp automático não configurado.' };
    const reason = `${n.reason}${n.note ? ` — ${n.note}` : ''}`.replace(/\s*\n\s*/g, ' ').slice(0, 900);
    const body = {
      messaging_product: 'whatsapp',
      to,
      type: 'template',
      template: {
        name: this.env.WHATSAPP_TEMPLATE_REJECTED,
        language: { code: this.env.WHATSAPP_TEMPLATE_LANG },
        components: [
          {
            type: 'body',
            parameters: [
              { type: 'text', text: n.name.trim().split(/\s+/)[0] ?? n.name },
              { type: 'text', text: n.documentName },
              { type: 'text', text: reason },
              { type: 'text', text: n.link },
            ],
          },
        ],
      },
    };
    try {
      const res = await fetch(`https://graph.facebook.com/${this.env.WHATSAPP_API_VERSION}/${this.env.WHATSAPP_PHONE_NUMBER_ID}/messages`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.env.WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const data: any = await res.json().catch(() => ({}));
        const error = data?.error?.message ?? `HTTP ${res.status}`;
        this.logger.warn(`WhatsApp falhou para ${to}: ${error}`);
        return { ok: false, error, to };
      }
      return { ok: true, to };
    } catch (e) {
      return { ok: false, error: (e as Error).message, to };
    }
  }
}
