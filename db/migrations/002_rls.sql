-- Habilita Row Level Security em todas as tabelas, sem políticas.
-- Efeito no Supabase: as chaves anon/authenticated (PostgREST) NÃO conseguem ler nem gravar
-- nenhuma tabela. Todo acesso passa pela API (NestJS), que conecta como dono das tabelas
-- e aplica autenticação/autorização própria.
do $$
declare t text;
begin
  foreach t in array array[
    'roles','users','document_models','document_model_items','document_model_questions',
    'document_model_rules','applicants','companies','requests','request_documents',
    'request_answers','vehicles','drivers','files','document_analyses','audit_logs','email_logs'
  ] loop
    execute format('alter table %I enable row level security', t);
  end loop;
end $$;
