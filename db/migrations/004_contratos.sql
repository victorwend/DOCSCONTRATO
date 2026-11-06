-- Contratos: modelos .docx (arquivo original da Pavidez) e contratos preenchidos por solicitação.
--
-- contract_templates.fields  = campos do contrato  [{key,label,type,required,group,help,source,format}]
-- contract_templates.slots   = onde cada campo entra [{id,action:'FIELD'|'KEEP'|'CLEAR',field}]
--   (o id do slot aponta para um trecho do arquivo original: parte:parágrafo:posição)
-- O arquivo original nunca é alterado: cada contrato gerado é uma cópia com os campos substituídos.

create table contract_templates (
  id              uuid primary key default gen_random_uuid(),
  name            text not null,
  description     text,
  model_id        uuid references document_models(id) on delete set null,
  storage_key     text not null unique,
  original_name   text not null,
  size_bytes      bigint not null check (size_bytes > 0),
  sha256          text not null,
  marking         text,                                   -- destaque predominante detectado (ex.: highlight:yellow)
  fields          jsonb not null default '[]'::jsonb,
  slots           jsonb not null default '[]'::jsonb,
  remove_marking  boolean not null default false,         -- tirar o destaque dos campos preenchidos
  output_pattern  text not null default 'CONTRATO_[NOME]',
  active          boolean not null default true,
  created_by      uuid references users(id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index contract_templates_model_idx on contract_templates(model_id);
create trigger contract_templates_updated_at before update on contract_templates for each row execute function pd_set_updated_at();

create table request_contracts (
  id               uuid primary key default gen_random_uuid(),
  request_id       uuid not null references requests(id) on delete cascade,
  template_id      uuid not null references contract_templates(id),
  template_name    text not null,
  "values"         jsonb not null default '{}'::jsonb,
  status           text not null default 'RASCUNHO' check (status in ('RASCUNHO','CONFIRMADO','GERADO')),
  confirmed_by     uuid references users(id) on delete set null,
  confirmed_at     timestamptz,
  values_hash      text,                                  -- hash dos valores confirmados (edição posterior invalida)
  generated_file_id uuid references files(id) on delete set null,
  generated_at     timestamptz,
  created_by       uuid references users(id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index request_contracts_request_idx on request_contracts(request_id);
create trigger request_contracts_updated_at before update on request_contracts for each row execute function pd_set_updated_at();

-- contrato gerado fica junto dos arquivos da solicitação (storage privado, URLs assinadas)
alter table files drop constraint if exists files_kind_check;
alter table files add constraint files_kind_check check (kind in ('ORIGINAL','PROCESSED','FINAL','CONTRACT'));

alter table contract_templates enable row level security;
alter table request_contracts enable row level security;
