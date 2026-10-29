-- PAVIDEZ DOCS — dados iniciais (idempotente: pode ser executado mais de uma vez).
-- Modelos baseados exclusivamente nos materiais fornecidos pela Pavidez:
--   * lista de documentos para contratação (imagem)
--   * Checklist_Documentos_Transportador_PJ.pdf
--   * especificação do projeto (carreteiro e locação de equipamentos)

-- ---------------------------------------------------------------------
-- Papéis
-- ---------------------------------------------------------------------
insert into roles (code, name, description, permissions) values
  ('ADMIN', 'Administrador', 'Acesso total ao sistema', array['*']),
  ('RH', 'RH', 'Cria modelos e solicitações e confere documentos',
     array['requests.read','requests.create','requests.manage','documents.review','files.read','models.read','models.manage','pdf.generate','email.send']),
  ('CONFERENTE', 'Conferente', 'Visualiza e confere documentos',
     array['requests.read','documents.review','files.read','models.read'])
on conflict (code) do update set name = excluded.name, description = excluded.description, permissions = excluded.permissions;

-- ---------------------------------------------------------------------
-- Funções auxiliares de seed
-- ---------------------------------------------------------------------
create or replace function pd_seed_admin(p_email text, p_name text, p_password text) returns uuid
language plpgsql set search_path = public, extensions as $$
declare v_id uuid;
begin
  select id into v_id from users where email = p_email;
  if v_id is null then
    insert into users (name, email, password_hash, role_id)
    values (p_name, p_email,
            case when p_password is null or p_password = '' then null else crypt(p_password, gen_salt('bf', 10)) end,
            (select id from roles where code = 'ADMIN'))
    returning id into v_id;
  end if;
  return v_id;
end $$;

create or replace function pd_seed_model(p_slug text, p_name text, p_description text, p_category text,
  p_portal_title text, p_message text, p_deadline int, p_mode text, p_pattern text) returns uuid
language plpgsql set search_path = public as $$
declare v_id uuid;
begin
  insert into document_models (slug, name, description, category, portal_title, default_message,
                               default_deadline_days, submission_mode, output_file_pattern)
  values (p_slug, p_name, p_description, p_category, p_portal_title, p_message, p_deadline, p_mode, p_pattern)
  returning id into v_id;
  return v_id;
end $$;

create or replace function pd_seed_item(p_model uuid, p_section text, p_pos int, p_name text, p_description text,
  p_kind text default 'FILE', p_required boolean default true, p_multiple boolean default false,
  p_both_sides boolean default false) returns uuid
language plpgsql set search_path = public as $$
declare v_id uuid;
begin
  insert into document_model_items (model_id, section, position, name, description, kind, required,
                                    allow_multiple, both_sides, max_files)
  values (p_model, p_section, p_pos, p_name, p_description, p_kind, p_required,
          p_multiple or p_both_sides, p_both_sides, case when p_both_sides then 2 else 10 end)
  returning id into v_id;
  return v_id;
end $$;

create or replace function pd_seed_question(p_model uuid, p_section text, p_pos int, p_key text, p_label text,
  p_type text, p_answered_by text, p_required boolean default false, p_help text default null,
  p_options jsonb default '[]'::jsonb, p_maps_to text default null) returns uuid
language plpgsql set search_path = public as $$
declare v_id uuid;
begin
  insert into document_model_questions (model_id, section, position, key, label, type, answered_by, required,
                                        help_text, options, maps_to)
  values (p_model, p_section, p_pos, p_key, p_label, p_type, p_answered_by, p_required, p_help, p_options, p_maps_to)
  returning id into v_id;
  return v_id;
end $$;

create or replace function pd_seed_rule(p_model uuid, p_question uuid, p_value jsonb, p_item uuid,
  p_action text default 'SHOW_ITEM', p_operator text default 'EQUALS') returns void
language sql set search_path = public as $$
  insert into document_model_rules (model_id, question_id, operator, value, action, target_item_id)
  values (p_model, p_question, p_operator, p_value, p_action, p_item);
$$;

-- ---------------------------------------------------------------------
-- 1. ADMISSÃO
-- ---------------------------------------------------------------------
do $$
declare m uuid;
begin
  if exists (select 1 from document_models where slug = 'admissao') then return; end if;
  m := pd_seed_model('admissao',
    'Admissão de colaborador',
    'DOCUMENTOS PARA CONTRATAÇÃO – PAVIDEZ ENGENHARIA',
    'ADMISSAO',
    'DOCUMENTAÇÃO PARA CONTRATAÇÃO',
$msg$Olá!

Para darmos andamento à sua contratação com a Pavidez Engenharia, precisamos receber os documentos solicitados.

Envie TODOS OS DOCUMENTOS EM UM ÚNICO PDF.

Os documentos devem estar completos, nítidos e legíveis. Não envie fotos cortadas ou escuras.

CONTA BRADESCO

Não tem conta Bradesco? Abra pelo aplicativo:

1. Clique em 'Abra sua conta'.
2. Informe seu CPF e seus dados.
3. Quando pedir os dados da empresa, informe:

CNPJ: 01.744.153/0001-06
CONVÊNIO: 070801756

4. Siga as instruções do aplicativo e finalize a abertura.

EXAME ADMISSIONAL

Após receber e conferir os documentos, será feito o agendamento.

Local: BRASILÂNDIA DE MINAS

Fique atento ao celular para receber data, horário e local do exame.

Envie tudo corretamente para não atrasar sua contratação.$msg$,
    7, 'SINGLE_FILE', 'DOCS_[NOME]');

  perform pd_seed_item(m, null, 1,  'Currículo', null);
  perform pd_seed_item(m, null, 2,  'CTPS – Carteira de Trabalho', null, 'FILE', true, true);
  perform pd_seed_item(m, null, 3,  'Comprovante do PIS atualizado', 'Solicitar na Caixa ou pelo aplicativo.');
  perform pd_seed_item(m, null, 4,  'RG', 'Frente e verso.', 'FILE', true, false, true);
  perform pd_seed_item(m, null, 5,  'CPF', null);
  perform pd_seed_item(m, null, 6,  'Título de eleitor', null);
  perform pd_seed_item(m, null, 7,  'Reservista militar', null);
  perform pd_seed_item(m, null, 8,  'CNH', 'Frente e verso.', 'FILE', true, false, true);
  perform pd_seed_item(m, null, 9,  'Certificado do MOPP', 'Para cargas inflamáveis.', 'FILE', false);
  perform pd_seed_item(m, null, 10, 'Cartão do SUS', null);
  perform pd_seed_item(m, null, 11, 'Atestado de antecedentes criminais', null);
  perform pd_seed_item(m, null, 12, 'Comprovante de escolaridade / histórico escolar', null);
  perform pd_seed_item(m, null, 13, 'Comprovante de residência', null);
  perform pd_seed_item(m, null, 14, 'Conta bancária Bradesco', 'Banco Bradesco.');
  perform pd_seed_item(m, null, 15, 'Certidão de nascimento / certidão de casamento', null);
  perform pd_seed_item(m, null, 16, 'Certidão de nascimento dos filhos', 'Filhos menores de 14 anos.', 'FILE', false, true);
  perform pd_seed_item(m, null, 17, 'CPF dos filhos', 'Filhos até 21 anos.', 'FILE', false, true);
  perform pd_seed_item(m, null, 18, 'Carteira de vacinação dos filhos', 'Filhos até 5 anos.', 'FILE', false, true);
  perform pd_seed_item(m, null, 19, 'Declaração escolar dos filhos', 'Filhos maiores de 7 anos.', 'FILE', false, true);
  perform pd_seed_item(m, null, 20, 'Telefone para contato', 'Informe um telefone com DDD.', 'TEXT', true);
end $$;

-- ---------------------------------------------------------------------
-- 2. CONTRATO DE CARRETEIRO
-- ---------------------------------------------------------------------
do $$
declare m uuid;
begin
  if exists (select 1 from document_models where slug = 'contrato-carreteiro') then return; end if;
  m := pd_seed_model('contrato-carreteiro',
    'Contrato de carreteiro',
    'Documentos e dados do carreteiro e do veículo.',
    'TRANSPORTE',
    'DOCUMENTAÇÃO PARA CONTRATO',
$msg$Olá, [NOME].

Para dar continuidade ao processo com a Pavidez Engenharia, precisamos dos documentos abaixo.

Envie arquivos completos, nítidos e legíveis.$msg$,
    7, 'SEPARATE', 'DOCS_[NOME]');

  perform pd_seed_item(m, null, 1, 'RG', 'Frente e verso.', 'FILE', true, false, true);
  perform pd_seed_item(m, null, 2, 'CPF', null);
  perform pd_seed_item(m, null, 3, 'CNH', 'Frente e verso.', 'FILE', true, false, true);
  perform pd_seed_item(m, null, 4, 'Comprovante de residência', null);
  perform pd_seed_item(m, null, 5, 'PIS/NIT', null);
  perform pd_seed_item(m, null, 6, 'CRLV', null);
  perform pd_seed_item(m, null, 7, 'RNTRC/ANTT', null);
  perform pd_seed_item(m, null, 8, 'Comprovante bancário', 'Não envie senha, saldo ou movimentações.');

  perform pd_seed_question(m, 'Dados do contratado', 1, 'nome_completo', 'Nome completo', 'TEXT', 'APPLICANT', true, null, '[]', 'driver.name');
  perform pd_seed_question(m, 'Dados do contratado', 2, 'cpf', 'CPF', 'TEXT', 'APPLICANT', true, null, '[]', 'driver.cpf');
  perform pd_seed_question(m, 'Dados do contratado', 3, 'telefone', 'Telefone', 'TEXT', 'APPLICANT', true, 'Com DDD.', '[]', 'driver.phone');
  perform pd_seed_question(m, 'Dados do contratado', 4, 'email', 'E-mail', 'TEXT', 'APPLICANT', false, null, '[]', 'driver.email');
  perform pd_seed_question(m, 'Dados do contratado', 5, 'endereco', 'Endereço', 'TEXT', 'APPLICANT', true, 'Rua, número, bairro, cidade, estado e CEP.', '[]', 'driver.address');
  perform pd_seed_question(m, 'Dados do veículo', 6, 'placa', 'Placa', 'TEXT', 'APPLICANT', true, null, '[]', 'vehicle.plate');
  perform pd_seed_question(m, 'Dados do veículo', 7, 'renavam', 'Renavam', 'TEXT', 'APPLICANT', true, null, '[]', 'vehicle.renavam');
  perform pd_seed_question(m, 'Dados do veículo', 8, 'marca_modelo', 'Marca/modelo', 'TEXT', 'APPLICANT', true, null, '[]', 'vehicle.brand_model');
  perform pd_seed_question(m, 'Dados do veículo', 9, 'ano', 'Ano', 'TEXT', 'APPLICANT', true, null, '[]', 'vehicle.year');
  perform pd_seed_question(m, 'Dados do veículo', 10, 'tipo_carroceria', 'Tipo de carroceria', 'TEXT', 'APPLICANT', true, null, '[]', 'vehicle.body_type');
  perform pd_seed_question(m, 'Dados do veículo', 11, 'capacidade_carga', 'Capacidade de carga', 'TEXT', 'APPLICANT', true, null, '[]', 'vehicle.load_capacity');
end $$;

-- ---------------------------------------------------------------------
-- 3. TRANSPORTADOR PJ (base: Checklist_Documentos_Transportador_PJ.pdf)
-- ---------------------------------------------------------------------
do $$
declare
  m uuid;
  s1 text := '1. Empresa e pessoa que assinará o contrato';
  s2 text := '2. Registro do transportador e recebimento do frete';
  s3 text := '3. Caminhão e reboques';
  s4 text := '4. Pessoa que dirigirá o caminhão';
  s5 text := '5. Conferência interna';
  yn jsonb := '[{"value":true,"label":"Sim"},{"value":false,"label":"Não"}]';
  q uuid; i uuid;
begin
  if exists (select 1 from document_models where slug = 'transportador-pj') then return; end if;
  m := pd_seed_model('transportador-pj',
    'Contrato de prestação de serviços de transporte',
    'Transportador pessoa jurídica — base: checklist de documentos da Pavidez (contrato e Anexo II).',
    'TRANSPORTE',
    'DOCUMENTAÇÃO PARA CONTRATO',
$msg$Olá, [NOME].

Para darmos andamento ao contrato de prestação de serviços de transporte com a Pavidez Engenharia, precisamos dos documentos abaixo.

Envie fotos ou PDFs completos e legíveis, sem cortar números, nomes ou datas.

Se algum item não se aplicar, informe N/A.$msg$,
    7, 'SEPARATE', 'DOCS_[NOME]');

  -- Seção 1
  perform pd_seed_item(m, s1, 1, 'Cartão CNPJ', 'Comprovante de inscrição da empresa na Receita Federal. Deve mostrar razão social, CNPJ, endereço e situação cadastral.');
  perform pd_seed_item(m, s1, 2, 'Contrato social e alterações ou versão consolidada', 'Contrato social atualizado com as alterações, ou a versão consolidada. Permite identificar os sócios e quem pode assinar pela empresa.', 'FILE', true, true);
  perform pd_seed_item(m, s1, 3, 'CCMEI', 'Somente se a empresa for MEI.', 'FILE', false);
  perform pd_seed_item(m, s1, 4, 'Inscrição estadual', 'Comprovante com o número da inscrição estadual. Se a empresa não possuir, informe: "Não possui inscrição estadual".', 'FILE', false);
  perform pd_seed_item(m, s1, 5, 'Comprovante de endereço da empresa', 'Informe também rua/rodovia, número ou km, complemento, bairro, cidade, estado e CEP. Avise se o endereço atual for diferente do cartão CNPJ.');
  perform pd_seed_item(m, s1, 6, 'RG do representante', 'RG de quem assinará pela empresa. Deve permitir ler órgão expedidor e data de emissão.', 'FILE', true, false, true);
  perform pd_seed_item(m, s1, 7, 'CPF do representante', null);
  perform pd_seed_item(m, s1, 8, 'Endereço do representante', 'Endereço completo do representante legal. Informe o nome completo, sem abreviações.', 'TEXT', true);
  perform pd_seed_item(m, s1, 9, 'Procuração', 'Somente se quem assinar não tiver autorização no contrato social: procuração com poderes para assinar este contrato e documentos pessoais do procurador.', 'FILE', false, true);
  perform pd_seed_item(m, s1, 10, 'Telefone', 'Telefone da empresa com DDD.', 'TEXT', true);
  perform pd_seed_item(m, s1, 11, 'E-mail', 'E-mail da empresa para contato.', 'TEXT', true);
  perform pd_seed_question(m, s1, 1, 'responsavel_documentos', 'Nome da pessoa responsável por responder sobre documentos e pagamentos', 'TEXT', 'APPLICANT', true);

  -- Seção 2
  perform pd_seed_item(m, s2, 12, 'RNTRC/ANTT', 'Comprovante ou carteirinha do RNTRC da empresa. Não basta enviar apenas o número.');
  perform pd_seed_item(m, s2, 13, 'Conta bancária em nome da empresa', 'Comprovante do banco com nome da empresa, CNPJ, banco, agência e conta com dígito. Pode ser documento ou tela do aplicativo. Não envie senha, saldo ou movimentações.');
  perform pd_seed_question(m, s2, 2, 'categoria_transportador', 'Categoria do transportador', 'SELECT', 'INTERNAL', false,
    'Conferir no RNTRC e na frota. Não marcar TAC pessoa física quando o contrato for firmado pelo CNPJ.',
    '[{"value":"TAC_EQUIPARADO","label":"TAC equiparado"},{"value":"ETC","label":"ETC"}]');
  perform pd_seed_question(m, s2, 3, 'rntrc_conferido', 'RNTRC consultado: está ativo e o caminhão está vinculado ao cadastro?', 'BOOLEAN', 'INTERNAL', false, null, yn);

  -- Seção 3
  perform pd_seed_item(m, s3, 14, 'CRLV do caminhão', 'Documento completo e legível do caminhão. Conferir placa, Renavam, proprietário e licenciamento.');
  perform pd_seed_item(m, s3, 15, 'CRLV de reboques/carreta', 'Se houver carreta ou reboques, envie o CRLV de cada um.', 'FILE', false, true);
  i := pd_seed_item(m, s3, 16, 'Contrato de locação, arrendamento ou comodato do veículo', 'Contrato que autorize o uso do veículo pela empresa contratada.');
  q := pd_seed_question(m, s3, 4, 'veiculo_terceiro', 'O veículo está em nome de outra pessoa ou empresa?', 'BOOLEAN', 'APPLICANT', true,
    'Se o CRLV estiver em nome da própria empresa contratada, responda Não.', yn);
  perform pd_seed_rule(m, q, 'true', i);
  perform pd_seed_item(m, s3, 17, 'Seguros previstos no contrato', 'Apólices ou comprovantes com identificação do segurado, vigência, número da apólice e cobertura.', 'FILE', true, true);
  perform pd_seed_item(m, s3, 18, 'TAG de pedágio', 'Somente se houver pedágio na rota: comprovante ou tela que identifique a operadora e a placa vinculada à TAG. Não substitui o vale-pedágio da viagem.', 'FILE', false);
  perform pd_seed_question(m, s3, 5,  'placa', 'Placa do caminhão', 'TEXT', 'APPLICANT', true, null, '[]', 'vehicle.plate');
  perform pd_seed_question(m, s3, 6,  'renavam', 'Renavam', 'TEXT', 'APPLICANT', true, null, '[]', 'vehicle.renavam');
  perform pd_seed_question(m, s3, 7,  'marca_modelo', 'Marca/modelo', 'TEXT', 'APPLICANT', true, 'Use os documentos do veículo; não estime valores.', '[]', 'vehicle.brand_model');
  perform pd_seed_question(m, s3, 8,  'ano', 'Ano', 'TEXT', 'APPLICANT', true, null, '[]', 'vehicle.year');
  perform pd_seed_question(m, s3, 9,  'cor', 'Cor', 'TEXT', 'APPLICANT', true, null, '[]', 'vehicle.color');
  perform pd_seed_question(m, s3, 10, 'tipo_carroceria', 'Tipo de carroceria (ex.: basculante)', 'TEXT', 'APPLICANT', true, null, '[]', 'vehicle.body_type');
  perform pd_seed_question(m, s3, 11, 'eixos', 'Quantidade de eixos', 'TEXT', 'APPLICANT', true, null, '[]', 'vehicle.axles');
  perform pd_seed_question(m, s3, 12, 'capacidade_carga', 'Capacidade de carga', 'TEXT', 'APPLICANT', true, null, '[]', 'vehicle.load_capacity');
  perform pd_seed_question(m, s3, 13, 'pbt_pbtc', 'PBT/PBTC (quando aplicável)', 'TEXT', 'APPLICANT', false, null, '[]', 'vehicle.pbt');

  -- Seção 4
  perform pd_seed_item(m, s4, 19, 'RG do motorista', 'Do motorista que realmente fará as viagens.', 'FILE', true, false, true);
  perform pd_seed_item(m, s4, 20, 'CPF do motorista', null);
  perform pd_seed_item(m, s4, 21, 'CNH do motorista', 'CNH válida, mostrando número, categoria, UF e validade. Se houver troca de motorista, comunique para novo cadastro.', 'FILE', true, false, true);
  perform pd_seed_item(m, s4, 22, 'Comprovante de residência do motorista', null);
  perform pd_seed_item(m, s4, 23, 'PIS/NIT do motorista', null);
  perform pd_seed_item(m, s4, 24, 'Telefone do motorista', 'Com DDD.', 'TEXT', true);
  perform pd_seed_item(m, s4, 25, 'E-mail do motorista', null, 'TEXT', true);

  i := pd_seed_item(m, s4, 26, 'Documentação societária do motorista', 'Contrato social ou documento de constituição em que o nome do motorista apareça.', 'FILE', true, true);
  q := pd_seed_question(m, s4, 14, 'motorista_socio', 'O motorista é sócio da empresa?', 'BOOLEAN', 'APPLICANT', true, null, yn);
  perform pd_seed_rule(m, q, 'true', i);

  q := pd_seed_question(m, s4, 15, 'motorista_empregado', 'O motorista é empregado registrado da empresa?', 'BOOLEAN', 'APPLICANT', true, null, yn);
  i := pd_seed_item(m, s4, 27, 'CTPS do motorista com o vínculo', null, 'FILE', true, true);
  perform pd_seed_rule(m, q, 'true', i);
  i := pd_seed_item(m, s4, 28, 'Ficha de registro do motorista', null);
  perform pd_seed_rule(m, q, 'true', i);
  i := pd_seed_item(m, s4, 29, 'Contrato de trabalho do motorista', null, 'FILE', true, true);
  perform pd_seed_rule(m, q, 'true', i);
  i := pd_seed_item(m, s4, 30, 'ASO válido do motorista', null);
  perform pd_seed_rule(m, q, 'true', i);

  q := pd_seed_question(m, s4, 16, 'motorista_subcontratado', 'O motorista é prestador de serviços subcontratado?', 'BOOLEAN', 'APPLICANT', true, null, yn);
  i := pd_seed_item(m, s4, 31, 'Contrato de prestação de serviços entre a empresa e o motorista', null, 'FILE', true, true);
  perform pd_seed_rule(m, q, 'true', i);

  q := pd_seed_question(m, s4, 17, 'motorista_cooperado', 'O motorista é cooperado de uma cooperativa?', 'BOOLEAN', 'APPLICANT', true,
    'Se nenhuma situação identificar o motorista, esclareça o vínculo com a Pavidez.', yn);
  i := pd_seed_item(m, s4, 32, 'Declaração da cooperativa', 'Declaração que comprove o vínculo do motorista com a cooperativa.');
  perform pd_seed_rule(m, q, 'true', i);

  -- Seção 5 — conferência interna (somente RH)
  perform pd_seed_question(m, s5, 18, 'numero_contrato_obra', 'Número do contrato/obra', 'TEXT', 'INTERNAL');
  perform pd_seed_question(m, s5, 19, 'prazo_contrato', 'Prazo', 'TEXT', 'INTERNAL');
  perform pd_seed_question(m, s5, 20, 'valor_por_viagem', 'Valor por viagem', 'TEXT', 'INTERNAL');
  perform pd_seed_question(m, s5, 21, 'condicoes_pagamento', 'Condições de pagamento', 'TEXT', 'INTERNAL');
  perform pd_seed_question(m, s5, 22, 'endereco_pedreira', 'Endereço da pedreira', 'TEXT', 'INTERNAL');
  perform pd_seed_question(m, s5, 23, 'endereco_entrega', 'Endereço da entrega', 'TEXT', 'INTERNAL');
  perform pd_seed_question(m, s5, 24, 'tratamento_pedagio', 'Tratamento do pedágio', 'TEXT', 'INTERNAL');
  perform pd_seed_question(m, s5, 25, 'contratacao_por_viagem', 'Contratação por viagem/lotação confirmada?', 'BOOLEAN', 'INTERNAL', false, null, yn);
  perform pd_seed_question(m, s5, 26, 'cadastro_crti', 'Dados da empresa encaminhados à contabilidade para cadastro no CRTI?', 'BOOLEAN', 'INTERNAL', false, null, yn);
  perform pd_seed_question(m, s5, 27, 'cadastro_transportes', 'Dados do veículo encaminhados ao setor de transportes?', 'BOOLEAN', 'INTERNAL', false, null, yn);
  perform pd_seed_question(m, s5, 28, 'conferencia_ndd_erp', 'Empresa, motorista, veículo e conta conferidos no NDD/ERP?', 'BOOLEAN', 'INTERNAL', false, null, yn);
end $$;

-- ---------------------------------------------------------------------
-- 4. LOCAÇÃO DE EQUIPAMENTOS
-- ---------------------------------------------------------------------
do $$
declare m uuid; q uuid; i uuid;
begin
  if exists (select 1 from document_models where slug = 'locacao-equipamentos') then return; end if;
  m := pd_seed_model('locacao-equipamentos',
    'Contrato de locação de equipamentos',
    'Modelo genérico para locação de equipamentos e veículos.',
    'LOCACAO',
    'DOCUMENTAÇÃO PARA CONTRATO',
$msg$Olá, tudo bem?

Aqui é o Victor, da Pavidez Engenharia (CNPJ 01.744.153/0001-06). Estou entrando em contato sobre a locação do [EQUIPAMENTO].

Para darmos andamento ao contrato, precisamos dos seguintes documentos:

1. CRLV dos veículos / nota fiscal do equipamento
2. Cartão CNPJ
3. Dados da conta bancária
4. Comprovante de residência do locador
5. CNH do locador
6. Proposta formal com valor e dados da empresa

Por favor, envie fotos ou PDFs completos e legíveis.

Se algum item não se aplicar à sua situação, informe.$msg$,
    7, 'SEPARATE', 'DOCS_[NOME]');

  q := pd_seed_question(m, 'Locação', 1, 'tipo_pessoa', 'Tipo de locador', 'SELECT', 'INTERNAL', true, null,
    '[{"value":"PF","label":"Pessoa física"},{"value":"PJ","label":"Pessoa jurídica"}]', 'request.person_type');
  perform pd_seed_question(m, 'Locação', 2, 'equipamento', 'Equipamento', 'TEXT', 'INTERNAL', true, 'Escolha uma sugestão ou digite outro.',
    '["Caminhão-pipa","Escavadeira","Retroescavadeira","Motoniveladora","Pá carregadeira","Rolo compactador","Caminhão","Gerador","Betoneira","Outro"]');
  perform pd_seed_question(m, 'Locação', 3, 'descricao_equipamento', 'Descrição do equipamento', 'TEXT', 'INTERNAL');
  perform pd_seed_question(m, 'Locação', 4, 'valor_locacao', 'Valor da locação', 'TEXT', 'INTERNAL');
  perform pd_seed_question(m, 'Locação', 5, 'periodo_locacao', 'Período', 'TEXT', 'INTERNAL');

  perform pd_seed_item(m, null, 1, 'CRLV dos veículos / nota fiscal do equipamento', null, 'FILE', true, true);
  i := pd_seed_item(m, null, 2, 'Cartão CNPJ', null);
  perform pd_seed_rule(m, q, '"PJ"', i);  -- PF/PJ: Cartão CNPJ apenas para pessoa jurídica
  perform pd_seed_item(m, null, 3, 'Dados da conta bancária', 'Não envie senha, saldo ou movimentações.');
  perform pd_seed_item(m, null, 4, 'Comprovante de residência do locador', null);
  perform pd_seed_item(m, null, 5, 'CNH do locador', 'Frente e verso.', 'FILE', true, false, true);
  perform pd_seed_item(m, null, 6, 'Proposta formal com valor e dados da empresa', null);
end $$;

-- ---------------------------------------------------------------------
-- 5. PRESTADOR DE SERVIÇOS e 6. MODELO PERSONALIZADO
-- (checklists não fornecidos nos materiais — criados vazios para o RH configurar)
-- ---------------------------------------------------------------------
do $$
declare m uuid;
begin
  if not exists (select 1 from document_models where slug = 'prestador-servicos') then
    m := pd_seed_model('prestador-servicos',
      'Prestador de serviços',
      'Checklist ainda não definido. Edite o modelo para cadastrar os documentos ou adicione-os ao criar a solicitação.',
      'PRESTADOR', 'DOCUMENTAÇÃO PARA CONTRATO',
      E'Olá, [NOME].\n\nPara dar continuidade ao processo com a Pavidez Engenharia, precisamos dos documentos abaixo.\n\nEnvie arquivos completos, nítidos e legíveis.',
      7, 'SEPARATE', 'DOCS_[NOME]');
    perform pd_seed_question(m, null, 1, 'tipo_pessoa', 'Tipo de prestador', 'SELECT', 'INTERNAL', true, null,
      '[{"value":"PF","label":"Pessoa física"},{"value":"PJ","label":"Pessoa jurídica"}]', 'request.person_type');
  end if;
  if not exists (select 1 from document_models where slug = 'personalizado') then
    perform pd_seed_model('personalizado',
      'Modelo personalizado',
      'Solicitação livre: monte o checklist na criação da solicitação.',
      'OUTRO', 'DOCUMENTAÇÃO',
      E'Olá, [NOME].\n\nPara dar continuidade ao processo com a Pavidez Engenharia, precisamos dos documentos abaixo.\n\nEnvie arquivos completos, nítidos e legíveis.',
      7, 'SEPARATE', 'DOCS_[NOME]');
  end if;
end $$;
