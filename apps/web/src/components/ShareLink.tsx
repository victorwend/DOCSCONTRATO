'use client';

import { api } from '@/lib/api';
import { Button, useToast } from './ui';

/** Copiar / compartilhar o link exclusivo (sem API não oficial de WhatsApp: usa o compartilhamento do aparelho e o link wa.me). */
export function ShareLink({ requestId, link, message, phone, compact }: { requestId: string; link: string; message?: string; phone?: string | null; compact?: boolean }) {
  const toast = useToast();
  const text = `${message ? `${message}\n\n` : ''}Envie seus documentos pelo link:\n${link}`;

  const mark = (channel: string) => api(`/requests/${requestId}/link/sent`, { body: { channel } }).catch(() => undefined);

  async function copy(value: string, what: string) {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = value;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    toast('success', `${what} copiado.`);
    mark('copy');
  }

  async function share() {
    if (navigator.share) {
      try {
        await navigator.share({ title: 'Documentos — Pavidez Engenharia', text });
        mark('share');
      } catch {
        /* cancelado */
      }
    } else {
      copy(text, 'Mensagem com link');
    }
  }

  function whatsapp() {
    const digits = (phone ?? '').replace(/\D/g, '');
    const to = digits.length >= 10 ? (digits.length <= 11 ? `55${digits}` : digits) : '';
    window.open(`https://wa.me/${to}?text=${encodeURIComponent(text)}`, '_blank', 'noopener,noreferrer');
    mark('whatsapp');
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 rounded-md bg-neutral-50 px-3 py-2 ring-1 ring-neutral-200">
        <code className="flex-1 truncate text-xs" title={link}>
          {link}
        </code>
      </div>
      <div className={compact ? 'flex flex-wrap gap-2' : 'grid grid-cols-2 gap-2 sm:grid-cols-4'}>
        <Button variant="primary" onClick={() => copy(link, 'Link')}>
          Copiar link
        </Button>
        <Button onClick={() => copy(text, 'Mensagem com link')}>Copiar mensagem</Button>
        <Button onClick={share}>Compartilhar</Button>
        <Button variant="success" onClick={whatsapp}>
          WhatsApp
        </Button>
      </div>
    </div>
  );
}
