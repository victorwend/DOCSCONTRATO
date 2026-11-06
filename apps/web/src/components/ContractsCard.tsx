'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '@/lib/api';
import { fmtBytes, fmtDateTime } from '@/lib/format';
import { can, useUser } from '@/components/session';
import { Alert, Badge, Button, Card, Checkbox, Field, Input, Modal, Select, Spinner, Textarea, useToast } from '@/components/ui';

type FieldDef = { key: string; label: string; type: string; required: boolean; group?: string | null; help?: string | null; source?: string | null; format?: string | null };

type Contract = {
  id: string;
  template_id: string;
  template_name: string;
  values: Record<string, unknown>;
  status: 'RASCUNHO' | 'CONFIRMADO' | 'GERADO';
  confirmed_by_name: string | null;
  confirmed_at: string | null;
  generated_file_id: string | null;
  generated_at: string | null;
  file_name: string | null;
  file_size: number | null;
  fields: FieldDef[];
  missing: string[];
  stale: boolean;
};

type ListResponse = {
  contracts: Contract[];
  templates: Array<{ id: string; name: string; suggested: boolean }>;
  canGenerate: boolean;
  generateBlockedReason: string | null;
};

const STATUS: Record<Contract['status'], { label: string; cls: string }> = {
  RASCUNHO: { label: 'Rascunho', cls: 'bg-amber-50 text-amber-800 ring-amber-200' },
  CONFIRMADO: { label: 'Dados confirmados', cls: 'bg-sky-50 text-sky-800 ring-sky-200' },
  GERADO: { label: 'Gerado', cls: 'bg-emerald-50 text-emerald-800 ring-emerald-200' },
};

/** Contratos da solicitação: escolher modelo → conferir/confirmar dados → gerar o .docx preenchido. */
export function ContractsCard({ requestId, onChanged }: { requestId: string; onChanged?: () => void }) {
  const user = useUser();
  const toast = useToast();
  const [data, setData] = useState<ListResponse | null>(null);
  const [templateId, setTemplateId] = useState('');
  const [editing, setEditing] = useState<Contract | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const canManage = can(user, 'requests.manage');
  const canConfirm = canManage || can(user, 'documents.review');
  const canGenerate = can(user, 'pdf.generate');

  const load = useCallback(async () => {
    try {
      const r = await api<ListResponse>(`/requests/${requestId}/contracts`);
      setData(r);
      setTemplateId((cur) => cur || r.templates.find((t) => t.suggested)?.id || r.templates[0]?.id || '');
      return r;
    } catch (e) {
      toast('error', (e as Error).message);
      return null;
    }
  }, [requestId, toast]);

  useEffect(() => {
    load();
  }, [load]);

  async function run(key: string, fn: () => Promise<unknown>, ok?: string) {
    setBusy(key);
    try {
      await fn();
      if (ok) toast('success', ok);
      await load();
      onChanged?.();
    } catch (e) {
      toast('error', (e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function download(c: Contract) {
    try {
      const { url } = await api(`/files/${c.generated_file_id}/url?disposition=attachment`);
      window.location.href = url;
    } catch (e) {
      toast('error', (e as Error).message);
    }
  }

  async function start() {
    setBusy('new');
    try {
      const r = await api<{ id: string }>(`/requests/${requestId}/contracts`, { body: { templateId } });
      const list = await load();
      const c = list?.contracts.find((x) => x.id === r.id);
      if (c) setEditing(c);
      onChanged?.();
    } catch (e) {
      toast('error', (e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  if (!data) {
    return (
      <Card title="Contrato">
        <Spinner />
      </Card>
    );
  }

  return (
    <Card title="Contrato">
      <div className="space-y-3">
        {data.contracts.length === 0 && <p className="text-sm text-neutral-500">Nenhum contrato iniciado.</p>}
        {data.contracts.map((c) => (
          <div key={c.id} className="rounded-md p-3 ring-1 ring-neutral-200">
            <div className="flex items-start justify-between gap-2">
              <p className="text-sm font-semibold">{c.template_name}</p>
              <Badge className={STATUS[c.status].cls}>{STATUS[c.status].label}</Badge>
            </div>
            {c.confirmed_at && c.status !== 'RASCUNHO' && (
              <p className="mt-1 text-xs text-neutral-500">
                Conferido por {c.confirmed_by_name ?? '—'} em {fmtDateTime(c.confirmed_at)}
              </p>
            )}
            {c.missing.length > 0 && <p className="mt-1 text-xs text-amber-700">Faltam {c.missing.length} campo(s) obrigatório(s).</p>}
            {c.generated_file_id && (
              <p className="mt-1 text-xs text-neutral-500">
                {c.file_name} · {fmtBytes(c.file_size ?? 0)} · {fmtDateTime(c.generated_at)}
              </p>
            )}
            <div className="mt-2 flex flex-wrap gap-2">
              <Button size="sm" variant={c.status === 'RASCUNHO' ? 'dark' : 'secondary'} onClick={() => setEditing(c)}>
                {c.status === 'RASCUNHO' ? 'Conferir dados' : 'Ver dados'}
              </Button>
              {canGenerate && c.status !== 'RASCUNHO' && (
                <Button
                  size="sm"
                  variant="primary"
                  disabled={!data.canGenerate}
                  loading={busy === `gen-${c.id}`}
                  onClick={() =>
                    run(`gen-${c.id}`, async () => {
                      const r = await api(`/requests/${requestId}/contracts/${c.id}/generate`, { method: 'POST' });
                      toast('success', `Contrato gerado: ${r.filled} campo(s) preenchido(s).`);
                    })
                  }
                >
                  {c.generated_file_id ? 'Gerar novamente' : 'Gerar contrato'}
                </Button>
              )}
              {c.generated_file_id && (
                <Button size="sm" onClick={() => download(c)}>
                  Baixar .docx
                </Button>
              )}
              {canManage && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    if (confirm('Remover este contrato? O arquivo já gerado continua no histórico.'))
                      run(`del-${c.id}`, () => api(`/requests/${requestId}/contracts/${c.id}`, { method: 'DELETE' }), 'Contrato removido.');
                  }}
                >
                  Remover
                </Button>
              )}
            </div>
          </div>
        ))}

        {data.contracts.some((c) => c.status !== 'RASCUNHO') && !data.canGenerate && data.generateBlockedReason && (
          <p className="text-xs text-neutral-600">⏳ {data.generateBlockedReason}</p>
        )}

        {canManage &&
          (data.templates.length ? (
            <div className="space-y-2 border-t pt-3">
              <Select value={templateId} onChange={(e) => setTemplateId(e.target.value)} aria-label="Modelo de contrato">
                {data.templates.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                    {t.suggested ? ' (deste processo)' : ''}
                  </option>
                ))}
              </Select>
              <Button className="w-full" variant="dark" disabled={!templateId} loading={busy === 'new'} onClick={start}>
                Preencher contrato
              </Button>
              <p className="text-xs text-neutral-500">Os dados da solicitação são sugeridos automaticamente. Você confere, corrige e confirma antes de gerar.</p>
            </div>
          ) : (
            <p className="border-t pt-3 text-xs text-neutral-500">
              Nenhum modelo de contrato ativo.{' '}
              {can(user, 'models.manage') && (
                <Link href="/contratos" className="underline">
                  Cadastrar modelo
                </Link>
              )}
            </p>
          ))}
      </div>

      {editing && (
        <ContractForm
          key={editing.id}
          requestId={requestId}
          contract={editing}
          readOnly={!canManage}
          canConfirm={canConfirm}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            const list = await load();
            const c = list?.contracts.find((x) => x.id === editing.id);
            if (c) setEditing(c);
            onChanged?.();
          }}
        />
      )}
    </Card>
  );
}

function groupFields(fields: FieldDef[]) {
  const groups = new Map<string, FieldDef[]>();
  for (const f of fields) {
    const g = f.group?.trim() || 'Dados do contrato';
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g)!.push(f);
  }
  return [...groups.entries()];
}

function ContractForm(props: {
  requestId: string;
  contract: Contract;
  readOnly: boolean;
  canConfirm: boolean;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const { requestId, contract: c, readOnly, canConfirm, onClose, onSaved } = props;
  const toast = useToast();
  const [values, setValues] = useState<Record<string, unknown>>(c.values ?? {});
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const dirty = useMemo(() => JSON.stringify(values) !== JSON.stringify(c.values ?? {}), [values, c.values]);
  const groups = useMemo(() => groupFields(c.fields), [c.fields]);
  const missing = c.fields.filter((f) => f.required && f.type !== 'CHECK' && !String(values[f.key] ?? '').trim());

  const set = (k: string, v: unknown) => setValues((cur) => ({ ...cur, [k]: v }));

  async function act(key: string, fn: () => Promise<unknown>, ok?: string): Promise<boolean> {
    setBusy(key);
    try {
      await fn();
      if (ok) toast('success', ok);
      await onSaved();
      return true;
    } catch (e) {
      toast('error', (e as Error).message);
      return false;
    } finally {
      setBusy(null);
    }
  }

  const save = () => api(`/requests/${requestId}/contracts/${c.id}`, { method: 'PUT', body: { values } });

  return (
    <Modal
      open
      wide
      onClose={() => {
        if (!dirty || confirm('Descartar as alterações não salvas?')) onClose();
      }}
      title={`Conferir dados – ${c.template_name}`}
      footer={
        readOnly ? (
          <Button onClick={onClose}>Fechar</Button>
        ) : (
          <>
            <Button variant="ghost" loading={busy === 'refill'} onClick={() => act('refill', () => api(`/requests/${requestId}/contracts/${c.id}/refill`, { method: 'POST' }).then((r: any) => !r.changed && toast('info', 'Nada novo para preencher.')))}>
              Buscar dados da solicitação
            </Button>
            <Button disabled={!dirty} loading={busy === 'save'} onClick={() => act('save', save, 'Dados salvos.')}>
              Salvar rascunho
            </Button>
            {canConfirm && (
              <Button
                variant="success"
                disabled={!checked || missing.length > 0}
                loading={busy === 'confirm'}
                onClick={() =>
                  act(
                    'confirm',
                    async () => {
                      if (dirty) await save();
                      await api(`/requests/${requestId}/contracts/${c.id}/confirm`, { method: 'POST' });
                    },
                    'Dados confirmados. O contrato já pode ser gerado.',
                  ).then((done) => done && onClose())
                }
              >
                Confirmar dados
              </Button>
            )}
          </>
        )
      }
    >
      <div className="space-y-5">
        {c.status !== 'RASCUNHO' && !dirty && (
          <Alert kind="success">
            Dados confirmados{c.confirmed_by_name ? ` por ${c.confirmed_by_name}` : ''}. Qualquer alteração volta o contrato para rascunho e exige nova confirmação.
          </Alert>
        )}
        <Alert kind="info">
          Confira cada dado com os documentos aprovados. Campo deixado em branco mantém o marcador original do contrato (ex.: “XXXX”). O texto fixo do
          contrato nunca é alterado.
        </Alert>
        {c.fields.length === 0 && <Alert kind="warning">Este modelo ainda não tem campos ligados ao arquivo. Configure em Contratos.</Alert>}
        {groups.map(([group, fields]) => (
          <section key={group}>
            <h4 className="mb-2 text-xs font-bold uppercase tracking-wide text-neutral-600">{group}</h4>
            <div className="grid gap-3 sm:grid-cols-2">
              {fields.map((f) => (
                <FieldInput key={f.key} f={f} value={values[f.key]} onChange={(v) => set(f.key, v)} disabled={readOnly} />
              ))}
            </div>
          </section>
        ))}
        {!readOnly && canConfirm && (
          <div className="rounded-md bg-neutral-50 p-3 ring-1 ring-neutral-200">
            {missing.length > 0 && <p className="mb-2 text-xs text-amber-700">Obrigatórios sem valor: {missing.map((f) => f.label).join(', ')}.</p>}
            <Checkbox checked={checked} onChange={setChecked} label="Conferi todos os dados com os documentos enviados e aprovados." />
          </div>
        )}
      </div>
    </Modal>
  );
}

function FieldInput({ f, value, onChange, disabled }: { f: FieldDef; value: unknown; onChange: (v: unknown) => void; disabled?: boolean }) {
  if (f.type === 'CHECK') {
    return (
      <div className="flex items-center rounded-md px-3 py-2 ring-1 ring-inset ring-neutral-200">
        <Checkbox checked={value === true} onChange={onChange} disabled={disabled} label={<span>Marcar “{f.label}”</span>} />
      </div>
    );
  }
  const v = value === undefined || value === null ? '' : String(value);
  return (
    <Field label={f.label} required={f.required} hint={f.help ?? undefined}>
      {f.type === 'LONGTEXT' ? (
        <Textarea value={v} onChange={(e) => onChange(e.target.value)} disabled={disabled} />
      ) : (
        <Input
          type={f.type === 'DATE' ? 'date' : 'text'}
          inputMode={f.type === 'MONEY' || f.type === 'NUMBER' ? 'decimal' : undefined}
          placeholder={f.type === 'MONEY' ? 'Ex.: 1.500,00' : undefined}
          value={f.type === 'DATE' ? toIsoDate(v) : v}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
        />
      )}
    </Field>
  );
}

function toIsoDate(v: string) {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(v);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : v.slice(0, 10);
}
