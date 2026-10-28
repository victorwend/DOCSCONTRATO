'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { fmtDateTime } from '@/lib/format';
import { useUser } from '@/components/session';
import { Alert, Badge, Button, Card, Field, Input, Modal, Select, Spinner, useToast } from '@/components/ui';

export default function UsersPage() {
  const me = useUser();
  const toast = useToast();
  const [users, setUsers] = useState<any[] | null>(null);
  const [roles, setRoles] = useState<any[]>([]);
  const [edit, setEdit] = useState<any | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = () => {
    api('/users').then(setUsers).catch((e) => toast('error', e.message));
  };
  useEffect(() => {
    load();
    api('/users/roles').then(setRoles).catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function save() {
    setError(null);
    try {
      if (edit.id) {
        await api(`/users/${edit.id}`, { method: 'PATCH', body: { name: edit.name, role: edit.role, active: edit.active, ...(edit.password ? { password: edit.password } : {}) } });
      } else {
        await api('/users', { body: { name: edit.name, email: edit.email, role: edit.role, password: edit.password } });
      }
      toast('success', 'Usuário salvo.');
      setEdit(null);
      load();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Usuários</h1>
          <p className="text-sm text-neutral-500">Administrador: acesso total · RH: cria modelos e solicitações e confere · Conferente: visualiza e confere documentos.</p>
        </div>
        <Button variant="primary" onClick={() => { setError(null); setEdit({ name: '', email: '', role: 'RH', password: '', active: true }); }}>
          + Novo usuário
        </Button>
      </div>
      <Card bodyClass="p-0">
        {!users ? (
          <div className="p-6"><Spinner /></div>
        ) : (
          <table className="min-w-full text-sm">
            <thead className="bg-neutral-50 text-left text-xs uppercase text-neutral-500">
              <tr>
                <th className="px-4 py-2">Nome</th>
                <th className="px-4 py-2">E-mail</th>
                <th className="px-4 py-2">Papel</th>
                <th className="px-4 py-2">Último acesso</th>
                <th className="px-4 py-2">Status</th>
                <th />
              </tr>
            </thead>
            <tbody className="divide-y">
              {users.map((u) => (
                <tr key={u.id}>
                  <td className="px-4 py-2 font-medium">{u.name}</td>
                  <td className="px-4 py-2">{u.email}</td>
                  <td className="px-4 py-2">{u.role_name}</td>
                  <td className="px-4 py-2">{fmtDateTime(u.last_login_at)}</td>
                  <td className="px-4 py-2">
                    <Badge className={u.active ? 'bg-emerald-50 text-emerald-800 ring-emerald-200' : 'bg-neutral-100 text-neutral-500 ring-neutral-300'}>{u.active ? 'Ativo' : 'Inativo'}</Badge>
                  </td>
                  <td className="px-4 py-2 text-right">
                    <Button size="sm" onClick={() => { setError(null); setEdit({ ...u, password: '' }); }}>
                      Editar
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <Modal
        open={!!edit}
        onClose={() => setEdit(null)}
        title={edit?.id ? 'Editar usuário' : 'Novo usuário'}
        footer={
          <>
            <Button onClick={() => setEdit(null)}>Cancelar</Button>
            <Button variant="dark" onClick={save}>Salvar</Button>
          </>
        }
      >
        {edit && (
          <div className="space-y-3">
            {error && <Alert kind="error">{error}</Alert>}
            <Field label="Nome" required>
              <Input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} />
            </Field>
            <Field label="E-mail" required>
              <Input type="email" value={edit.email} disabled={!!edit.id} onChange={(e) => setEdit({ ...edit, email: e.target.value })} />
            </Field>
            <Field label="Papel">
              <Select value={edit.role} disabled={edit.id === me.id} onChange={(e) => setEdit({ ...edit, role: e.target.value })}>
                {roles.map((r) => (
                  <option key={r.code} value={r.code}>
                    {r.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={edit.id ? 'Nova senha (deixe vazio para manter)' : 'Senha'} hint="Mínimo de 8 caracteres, com letras e números." required={!edit.id}>
              <Input type="password" autoComplete="new-password" value={edit.password} onChange={(e) => setEdit({ ...edit, password: e.target.value })} />
            </Field>
            {edit.id && edit.id !== me.id && (
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={edit.active} onChange={(e) => setEdit({ ...edit, active: e.target.checked })} /> Usuário ativo
              </label>
            )}
          </div>
        )}
      </Modal>
    </div>
  );
}
