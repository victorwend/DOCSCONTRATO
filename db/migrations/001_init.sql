-- PAVIDEZ DOCS — estrutura inicial
-- Compatível com PostgreSQL 14+ e Supabase.

create extension if not exists pgcrypto;
create extension if not exists citext;

-- =====================================================================
-- Funções utilitárias
-- =====================================================================
create or replace function pd_set_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

-- =====================================================================
-- Usuários e papéis
-- =====================================================================
create table roles (
  id           smallserial primary key,
  code         text not null unique check (code ~ '^[A-Z_]+$'),
  name         text not null,
  description  text,
  permissions  text[] not null default '{}',
  created_at   timestamptz not null default now()
);

create table users (
  id             uuid primary key default gen_random_uuid(),
  name           text not null,
  email          citext not null unique,
  password_hash  text,                              -- nulo quando AUTH_PROVIDER=supabase
  role_id        smallint not null references roles(id),
  active         boolean not null default true,
  last_login_at  timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index users_role_idx on users(role_id);
create trigger users_updated_at before update on users for each row execute function pd_set_updated_at();

-- =====================================================================
-- Modelos de documentação (configuração)
-- =====================================================================
create table document_models (
  id                    uuid primary key default gen_random_uuid(),
  name                  text not null,
  slug                  text not null unique check (slug ~ '^[a-z0-9-]+$'),
  description           text,
  category              text not null default 'OUTRO',
  portal_title          text not null default 'DOCUMENTAÇÃO PARA CONTRATAÇÃO',
  default_message       text,
  default_deadline_days integer check (default_deadline_days is null or default_deadline_days between 1 and 365),
  submission_mode       text not null default 'SEPARATE' check (submission_mode in ('SEPARATE','SINGLE_FILE')),
  single_file_label     text not null default 'Documentação completa (PDF único)',
  output_file_pattern   text not null default 'DOCUMENTACAO_[NOME]',
  active                boolean not null default true,
  created_by            uuid references users(id) on delete set null,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);
create index document_models_active_idx on document_models(active);
create trigger document_models_updated_at before update on document_models for each row execute function pd_set_updated_at();

create table document_model_items (
  id             uuid primary key default gen_random_uuid(),
  model_id       uuid not null references document_models(id) on delete cascade,
  section        text,
  name           text not null,
  description    text,
  kind           text not null default 'FILE' check (kind in ('FILE','TEXT')),
  required       boolean not null default true,
  position       integer not null,
  allow_multiple boolean not null default false,
  max_files      integer not null default 10 check (max_files between 1 and 50),
  both_sides     boolean not null default false,        -- frente e verso
  active         boolean not null default true,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index document_model_items_model_idx on document_model_items(model_id, position);
create trigger document_model_items_updated_at before update on document_model_items for each row execute function pd_set_updated_at();

create table document_model_questions (
  id           uuid primary key default gen_random_uuid(),
  model_id     uuid not null references document_models(id) on delete cascade,
  key          text not null check (key ~ '^[a-z][a-z0-9_]*$'),
  label        text not null,
  help_text    text,
  type         text not null default 'BOOLEAN' check (type in ('BOOLEAN','SELECT','TEXT','NUMBER','DATE')),
  options      jsonb not null default '[]'::jsonb,       -- [{"value":"PF","label":"Pessoa física"}] ou sugestões p/ TEXT
  required     boolean not null default false,
  answered_by  text not null default 'INTERNAL' check (answered_by in ('INTERNAL','APPLICANT')),
  section      text,
  position     integer not null,
  maps_to      text,                                      -- ex.: vehicle.plate, driver.cpf
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (model_id, key)
);
create index document_model_questions_model_idx on document_model_questions(model_id, position);
create trigger document_model_questions_updated_at before update on document_model_questions for each row execute function pd_set_updated_at();

-- Regras condicionais:
--   SHOW_ITEM    -> o item só é solicitado quando ao menos uma regra SHOW_ITEM dele for verdadeira
--   HIDE_ITEM    -> se verdadeira, o item não se aplica (prevalece sobre SHOW_ITEM)
--   REQUIRE_ITEM -> se verdadeira, o item passa a ser obrigatório
create table document_model_rules (
  id              uuid primary key default gen_random_uuid(),
  model_id        uuid not null references document_models(id) on delete cascade,
  question_id     uuid not null references document_model_questions(id) on delete cascade,
  operator        text not null default 'EQUALS' check (operator in ('EQUALS','NOT_EQUALS','IN','NOT_IN','ANSWERED')),
  value           jsonb,
  action          text not null default 'SHOW_ITEM' check (action in ('SHOW_ITEM','HIDE_ITEM','REQUIRE_ITEM')),
  target_item_id  uuid not null references document_model_items(id) on delete cascade,
  created_at      timestamptz not null default now()
);
create index document_model_rules_model_idx on document_model_rules(model_id);
create index document_model_rules_target_idx on document_model_rules(target_item_id);

-- =====================================================================
-- Pessoas / empresas / veículos / motoristas
-- =====================================================================
create table applicants (
  id           uuid primary key default gen_random_uuid(),
  person_type  text not null default 'PF' check (person_type in ('PF','PJ')),
  name         text not null,
  document     text,                                      -- CPF/CNPJ somente dígitos
  email        citext,
  phone        text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index applicants_document_idx on applicants(document);
create index applicants_name_idx on applicants(lower(name));
create trigger applicants_updated_at before update on applicants for each row execute function pd_set_updated_at();

create table companies (
  id                 uuid primary key default gen_random_uuid(),
  applicant_id       uuid references applicants(id) on delete set null,
  legal_name         text not null,
  cnpj               text not null unique check (cnpj ~ '^[0-9]{14}$'),
  state_registration text,
  address            text,
  phone              text,
  email              citext,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create trigger companies_updated_at before update on companies for each row execute function pd_set_updated_at();

-- =====================================================================
-- Solicitações
-- =====================================================================
create sequence request_code_seq;

create table requests (
  id                  uuid primary key default gen_random_uuid(),
  code                text not null unique,
  model_id            uuid not null references document_models(id),
  model_name          text not null,                     -- snapshot do nome/tipo do processo
  portal_title        text not null,
  output_file_pattern text not null,
  applicant_id        uuid not null references applicants(id),
  company_id          uuid references companies(id) on delete set null,
  person_type         text not null default 'PF' check (person_type in ('PF','PJ')),
  applicant_name      text not null,
  applicant_document  text,
  applicant_phone     text,
  applicant_email     citext,
  notify_email        citext,                            -- destinatário do PDF final
  notes               text,
  message             text,
  submission_mode     text not null default 'SEPARATE' check (submission_mode in ('SEPARATE','SINGLE_FILE')),
  -- snapshot das perguntas e regras no momento da criação (alterações futuras no modelo
  -- não mudam processos em andamento). Regras apontam para request_documents.id
  questions           jsonb not null default '[]'::jsonb,
  rules               jsonb not null default '[]'::jsonb,
  status              text not null default 'RASCUNHO' check (status in
                       ('RASCUNHO','AGUARDANDO_DOCUMENTOS','EM_CONFERENCIA','PENDENCIA','APROVADO','FINALIZADO','CANCELADO','EXPIRADO')),
  responsible_user_id uuid references users(id) on delete set null,
  created_by          uuid references users(id) on delete set null,
  deadline            date,
  -- link exclusivo: o token nunca é salvo em texto puro
  token_hash          text unique,                       -- sha256 (busca)
  token_encrypted     text,                              -- AES-256-GCM (permite copiar o link novamente)
  link_active         boolean not null default false,
  link_expires_at     timestamptz,
  link_generated_at   timestamptz,
  link_sent_at        timestamptz,
  last_accessed_at    timestamptz,
  submitted_at        timestamptz,
  approved_at         timestamptz,
  finalized_at        timestamptz,
  cancelled_at        timestamptz,
  cancel_reason       text,
  final_file_id       uuid,
  purged_at           timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create index requests_status_idx on requests(status);
create index requests_model_idx on requests(model_id);
create index requests_responsible_idx on requests(responsible_user_id);
create index requests_created_idx on requests(created_at desc);
create index requests_document_idx on requests(applicant_document);
create index requests_name_idx on requests(lower(applicant_name));
create trigger requests_updated_at before update on requests for each row execute function pd_set_updated_at();

create table request_documents (
  id               uuid primary key default gen_random_uuid(),
  request_id       uuid not null references requests(id) on delete cascade,
  model_item_id    uuid references document_model_items(id) on delete set null,
  section          text,
  name             text not null,
  description      text,
  kind             text not null default 'FILE' check (kind in ('FILE','TEXT')),
  base_required    boolean not null default true,         -- definido pelo RH
  required         boolean not null default true,         -- base_required OU regra REQUIRE_ITEM
  position         integer not null,
  allow_multiple   boolean not null default false,
  max_files        integer not null default 10,
  both_sides       boolean not null default false,
  is_custom        boolean not null default false,        -- adicionado manualmente na solicitação
  is_combined      boolean not null default false,        -- slot "PDF único"
  is_applicable    boolean not null default true,         -- false = N/A (regra condicional ou decisão do RH)
  applicability_source text not null default 'DEFAULT' check (applicability_source in ('DEFAULT','RULE','MANUAL')),
  awaiting_answer  boolean not null default false,        -- condicional cuja pergunta ainda não foi respondida
  na_reason        text,
  na_requested     boolean not null default false,        -- solicitante informou "não se aplica"
  status           text not null default 'PENDENTE' check (status in ('PENDENTE','RECEBIDO','EM_ANALISE','APROVADO','REJEITADO')),
  text_value       text,
  applicant_note   text,
  rejection_reason text check (rejection_reason is null or rejection_reason in
                    ('ILEGIVEL','CORTADO','INCOMPLETO','INCORRETO','VENCIDO','OUTRO')),
  rejection_note   text,
  reviewer_note    text,
  submission_count integer not null default 0,
  submitted_at     timestamptz,
  reviewed_at      timestamptz,
  reviewed_by      uuid references users(id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index request_documents_request_idx on request_documents(request_id, position);
create index request_documents_status_idx on request_documents(status);
create trigger request_documents_updated_at before update on request_documents for each row execute function pd_set_updated_at();

create table request_answers (
  id           uuid primary key default gen_random_uuid(),
  request_id   uuid not null references requests(id) on delete cascade,
  question_id  uuid references document_model_questions(id) on delete set null,
  key          text not null,
  label        text not null,
  value        jsonb,
  answered_by  text not null check (answered_by in ('INTERNAL','APPLICANT')),
  answered_by_user uuid references users(id) on delete set null,
  answered_at  timestamptz not null default now(),
  unique (request_id, key)
);
create index request_answers_request_idx on request_answers(request_id);

create table vehicles (
  id            uuid primary key default gen_random_uuid(),
  request_id    uuid not null references requests(id) on delete cascade,
  company_id    uuid references companies(id) on delete set null,
  applicant_id  uuid references applicants(id) on delete set null,
  plate         text,
  renavam       text,
  brand_model   text,
  year          text,
  color         text,
  body_type     text,
  axles         text,
  load_capacity text,
  pbt           text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (request_id)
);
create index vehicles_plate_idx on vehicles(plate);
create trigger vehicles_updated_at before update on vehicles for each row execute function pd_set_updated_at();

create table drivers (
  id            uuid primary key default gen_random_uuid(),
  request_id    uuid not null references requests(id) on delete cascade,
  company_id    uuid references companies(id) on delete set null,
  name          text,
  cpf           text,
  phone         text,
  email         citext,
  address       text,
  relationship  text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (request_id)
);
create index drivers_cpf_idx on drivers(cpf);
create trigger drivers_updated_at before update on drivers for each row execute function pd_set_updated_at();

-- =====================================================================
-- Arquivos (metadados — o conteúdo fica no storage privado)
-- =====================================================================
create table files (
  id                   uuid primary key default gen_random_uuid(),
  request_id           uuid not null references requests(id) on delete cascade,
  request_document_id  uuid references request_documents(id) on delete set null,
  kind                 text not null check (kind in ('ORIGINAL','PROCESSED','FINAL')),
  storage_driver       text not null,
  storage_key          text not null unique,
  original_name        text not null,
  mime_type            text not null,
  size_bytes           bigint not null check (size_bytes > 0),
  sha256               text not null,
  page_count           integer,
  side                 text check (side is null or side in ('FRONT','BACK')),
  submission_number    integer not null default 1,
  is_current           boolean not null default true,     -- false = substituído/rejeitado (mantido no histórico)
  security_flags       text[] not null default '{}',
  uploaded_by_applicant boolean not null default false,
  uploaded_by          uuid references users(id) on delete set null,
  uploader_ip          inet,
  created_at           timestamptz not null default now(),
  purged_at            timestamptz
);
create index files_request_idx on files(request_id);
create index files_document_idx on files(request_document_id, is_current);

alter table requests add constraint requests_final_file_fk foreign key (final_file_id) references files(id) on delete set null;

-- Preparação para OCR/IA (assistivo — nunca aprova automaticamente)
create table document_analyses (
  id          uuid primary key default gen_random_uuid(),
  file_id     uuid not null references files(id) on delete cascade,
  provider    text not null,
  status      text not null default 'PENDING' check (status in ('PENDING','DONE','FAILED','SKIPPED')),
  result      jsonb,
  error       text,
  created_at  timestamptz not null default now(),
  finished_at timestamptz
);
create index document_analyses_file_idx on document_analyses(file_id);

-- =====================================================================
-- Auditoria e e-mails
-- =====================================================================
create table audit_logs (
  id             bigserial primary key,
  request_id     uuid references requests(id) on delete cascade,
  actor_type     text not null check (actor_type in ('USER','APPLICANT','SYSTEM')),
  actor_user_id  uuid references users(id) on delete set null,
  actor_name     text,
  action         text not null,
  entity_type    text,
  entity_id      text,
  details        jsonb not null default '{}'::jsonb,
  ip             inet,
  user_agent     text,
  created_at     timestamptz not null default now()
);
create index audit_logs_request_idx on audit_logs(request_id, created_at);
create index audit_logs_created_idx on audit_logs(created_at desc);
create index audit_logs_action_idx on audit_logs(action);

create table email_logs (
  id           uuid primary key default gen_random_uuid(),
  request_id   uuid references requests(id) on delete cascade,
  template     text not null,
  recipient    text not null,
  subject      text not null,
  status       text not null default 'PENDING' check (status in ('PENDING','SENT','FAILED')),
  error        text,
  message_id   text,
  attachments  jsonb not null default '[]'::jsonb,
  sent_at      timestamptz,
  created_at   timestamptz not null default now()
);
create index email_logs_request_idx on email_logs(request_id, created_at);
