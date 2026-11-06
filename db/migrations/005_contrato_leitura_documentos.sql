-- Leitura dos documentos aprovados (IA assistiva) para preencher o contrato.
-- suggestions = { "<campo>": { value, document, evidence, confidence } }
alter table request_contracts add column if not exists suggestions jsonb not null default '{}'::jsonb;
alter table request_contracts add column if not exists extraction_notes jsonb not null default '[]'::jsonb;
alter table request_contracts add column if not exists extracted_at timestamptz;
alter table request_contracts add column if not exists extraction_error text;
