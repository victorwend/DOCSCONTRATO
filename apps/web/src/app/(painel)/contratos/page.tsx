'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { api, upload } from '@/lib/api';
import { fmtBytes, fmtDateTime, markingLabel } from '@/lib/format';
import { can, useUser } from '@/components/session';
import { Alert, Badge, Button, Card, EmptyState, Field, Input, Modal, Select, Spinner, Textarea, useToast } from '@/components/ui';

export default function ContractTemplatesPage() {
  const user = useUser();
  const toast = useToast();
  const router = useRouter();
  const manage = can(user, 'models.manage');
  const [list, setList] = useState<any[] | null>(null);
  const [models, setModels] = useState<any[]>([]);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ name: '', description: '', modelId: '' });
  const [file, setFile] = useState<File | null>(null);
  const [pct, setPct] = useState<number | null>(null);

  const load = () => api('/contract-templates').then(setList).catch((e) => toast('error', e.message));
  useEffect(() => {
    load();
    api('/models').then(setModels).catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function create() {
    if (!file) return toast('error', 'Escolha o arquivo .docx do contrato.');
    if (!/\.docx$/i.test(file.name)) {
      return toast('error', /\.doc$/i.test(file.name) ? 'Arquivo .doc antigo: abra no Word e salve como .docx.' : 'Envie um arquivo .docx.');
    }
    const fd = new FormData();
    fd.append('name', form.name.trim() || file.name.replace(/\.docx$/i, ''));
    fd.append('description', form.description);
    fd.append('modelId', form.modelId);
    fd.append('file', file);
    setPct(0);
    try {
      const r = await upload<{ id: string; fields: number }>('/contract-templates', fd, setPct);
      toast('success', `Modelo cadastrado: ${r.fields} campo(s) encontrados. Revise o mapeamento.`);
      router.push(`/contratos/${r.id}`);
    } catch (e) {
      toast('error', (e as Error).message);
    } finally {
      setPct(null);
    }
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Modelos de contrato</h1>
          <p className="text-sm text-neutral-500">
            Envie o contrato original da Pavidez em Word. O sistema encontra os campos destacados (XXXX, xxx, ( ), textos em cor) e preenche só eles, sem
            alterar o restante do arquivo.
          </p>
        </div>
        {manage && (
          <Button variant="primary" onClick={() => setOpen(true)}>
            + Novo modelo de contrato
          </Button>
        )}
      </div>

      {!list ? (
        <Spinner />
      ) : list.length === 0 ? (
        <EmptyState title="Nenhum modelo de contrato cadastrado">Cadastre o contrato de locação, transporte ou prestação de serviços para preencher automaticamente.</EmptyState>
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {list.map((t) => (
            <Card key={t.id}>
              <div className="flex items-start justify-between gap-3">
                <div>
                  <Link href={`/contratos/${t.id}`} className="font-bold hover:underline">
                    {t.name}
                  </Link>
                  {t.description && <p className="mt-0.5 text-xs text-neutral-500">{t.description}</p>}
                </div>
                <Badge className={t.active ? 'bg-emerald-50 text-emerald-800 ring-emerald-200' : 'bg-neutral-100 text-neutral-500 ring-neutral-300'}>{t.active ? 'Ativo' : 'Inativo'}</Badge>
              </div>
              <div className="mt-3 flex flex-wrap gap-2 text-xs text-neutral-600">
                <span>{t.field_count} campos</span>·<span>{t.mapped_slots} trechos preenchidos</span>·<span>{markingLabel(t.marking)}</span>·<span>{t.usage_count} uso(s)</span>
              </div>
              <p className="mt-1 text-[11px] text-neutral-400">
                {t.model_name ? `Processo: ${t.model_name} · ` : ''}
                {t.original_name} ({fmtBytes(t.size_bytes)}) · atualizado em {fmtDateTime(t.updated_at)}
              </p>
              <div className="mt-3">
                <Link href={`/contratos/${t.id}`}>
                  <Button size="sm" variant="dark">
                    {manage ? 'Configurar campos' : 'Ver'}
                  </Button>
                </Link>
              </div>
            </Card>
          ))}
        </div>
      )}

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Novo modelo de contrato"
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancelar
            </Button>
            <Button variant="primary" loading={pct !== null} onClick={create}>
              {pct !== null ? `Enviando ${pct}%` : 'Enviar e analisar'}
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <Field label="Arquivo do contrato (.docx)" required hint="Arquivos .doc antigos: abra no Word e use Salvar como → Documento do Word (.docx).">
            <Input type="file" accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          </Field>
          <Field label="Nome" hint="Ex.: Contrato de locação de equipamentos (rev. 03)">
            <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder={file?.name.replace(/\.docx$/i, '') ?? ''} />
          </Field>
          <Field label="Processo (modelo de documentação)" hint="O contrato será sugerido nas solicitações deste processo e poderá usar as respostas dele.">
            <Select value={form.modelId} onChange={(e) => setForm({ ...form, modelId: e.target.value })}>
              <option value="">— Nenhum —</option>
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Descrição">
            <Textarea value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
          </Field>
          <Alert kind="info">O arquivo original fica guardado sem alteração. Cada contrato gerado é uma cópia com os campos preenchidos.</Alert>
        </div>
      </Modal>
    </div>
  );
}
