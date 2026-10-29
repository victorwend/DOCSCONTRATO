-- Formato aceito em cada documento: ANY (foto ou PDF), IMAGE (somente foto JPG/PNG), PDF (somente PDF)
alter table document_model_items add column if not exists accept text not null default 'ANY'
  check (accept in ('ANY','IMAGE','PDF'));
alter table request_documents add column if not exists accept text not null default 'ANY'
  check (accept in ('ANY','IMAGE','PDF'));

-- PDF final passa a se chamar DOCS_<NOME DO FUNCIONÁRIO / SOLICITANTE>
alter table document_models alter column output_file_pattern set default 'DOCS_[NOME]';
update document_models set output_file_pattern = 'DOCS_[NOME]';
update requests set output_file_pattern = 'DOCS_[NOME]' where status not in ('FINALIZADO','CANCELADO');
