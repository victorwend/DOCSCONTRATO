# Decisões técnicas e de interpretação

Registro das escolhas feitas onde a especificação não definia o detalhe. Nenhum requisito de negócio
foi alterado silenciosamente — quando algo foi interpretado, está aqui.

## Arquitetura

| # | Decisão | Motivo |
|---|---|---|
| A1 | Monorepo npm workspaces: `apps/api` (NestJS) + `apps/web` (Next.js). | Separação clara UI × domínio × serviços; um só `npm install`. |
| A2 | Banco com **SQL puro** (`db/migrations/*.sql`) e driver `pg`, sem ORM. | Funciona igual no Postgres local e no Supabase (inclusive pelo SQL Editor); nenhuma etapa de geração de cliente. |
| A3 | Regras de negócio puras em `apps/api/src/domain` (status, motor de regras, PDF, validação, tokens). | Testáveis sem banco/HTTP; reutilizadas por todos os serviços. |
| A4 | O Next.js repassa `/api/*` para a API (rewrite). | Mesma origem → cookie httpOnly `SameSite=Lax`, sem CORS e sem token no JavaScript. |
| A5 | Sessão própria (JWT em cookie) mesmo com Supabase Auth. | Papéis/permissões ficam na tabela `users`; a API não depende do SDK no navegador. Supabase Auth valida a senha quando `AUTH_PROVIDER=supabase`. |
| A6 | Drivers de storage `local` e `supabase` atrás da mesma interface. | Desenvolvimento sem nuvem; produção no Supabase Storage. |
| A7 | E-mail com driver `log` (grava `.eml`) e `smtp`. | Testar templates/anexos sem servidor SMTP. |
| A8 | Perguntas e regras são **congeladas** na solicitação (`requests.questions`, `requests.rules`). | Editar um modelo não altera processos em andamento. |
| A9 | Status da solicitação é **derivado** (função `computeRequestStatus`) e recalculado após cada alteração. | Evita estados inconsistentes. |
| A10 | Tarefas periódicas (expiração, retenção) com `setInterval` na própria API. | Sem dependência extra; idempotentes. Em várias instâncias, apenas repetem trabalho sem efeito colateral. |

## Interpretações de requisitos

| # | Tema | Decisão |
|---|---|---|
| R1 | Destino do PDF final | Campo **“E-mail para receber o PDF final”** na solicitação (padrão `DEFAULT_NOTIFY_EMAIL`), separado do e-mail do solicitante. O exemplo de mensagem (“…de [NOME] foi recebida e conferida”) é dirigido à equipe interna; enviar o dossiê com documentos pessoais ao próprio solicitante não parecia a intenção. |
| R2 | Admissão “PDF único” × separados | Modo por modelo **e** por solicitação. No modo PDF único, os itens de arquivo viram um único item “Documentação completa (PDF único)” cuja descrição lista o checklist na ordem; itens de texto (telefone) continuam separados. O seed da Admissão usa “PDF único”, como na mensagem original. |
| R3 | Obrigatoriedade na Admissão | Os materiais não indicam obrigatórios. Marcados como **opcionais** apenas os itens que a própria lista condiciona: MOPP (“para cargas inflamáveis”) e os quatro documentos dos filhos. Os demais são obrigatórios; o solicitante pode informar “não se aplica” com justificativa (ex.: reservista) e o RH aprova. A lista da imagem repete “Comprovante de residência” — mantido uma vez. |
| R4 | “Telefone”, “E-mail”, “Endereço do representante” | Itens do tipo **TEXTO** (informação digitada, conferida como os documentos). |
| R5 | “Também solicitar dados” (carreteiro) e “Características do caminhão” (PJ) | **Perguntas** respondidas pelo solicitante, gravadas também em `drivers`/`vehicles` via `maps_to`. E-mail do carreteiro é opcional; PBT/PBTC é opcional (“quando aplicável” no checklist). |
| R6 | Seção 5 do Transportador (“Conferência interna”) e “Categoria do transportador” | **Perguntas internas** (só o RH vê/responde), não documentos do solicitante; não bloqueiam o PDF. |
| R7 | Perguntas condicionais do Transportador | Respondidas pelo solicitante no portal (o RH pode pré-responder na criação). Enquanto não respondidas, os documentos dependentes aparecem como “aguardando resposta”; com “Não”, ficam **N/A** (registrado no PDF final). |
| R8 | Documento “se houver/quando aplicável” no checklist PJ (CCMEI, inscrição estadual, procuração, CRLV de reboques, TAG de pedágio) | Opcionais (o checklist não traz pergunta para eles). |
| R9 | PF/PJ | Implementado como pergunta configurável com `maps_to = request.person_type` + regras do modelo. Na Locação, “Cartão CNPJ” só é solicitado para locador PJ (aplicação direta do requisito 20). |
| R10 | Locação — 6º documento | A imagem lista 5; a especificação acrescenta “Proposta formal com valor e dados da empresa”. Seguida a especificação (6). |
| R11 | Prestador de serviços / Modelo personalizado | Os materiais não trazem checklist: modelos criados **vazios** para o RH configurar (não inventamos documentos). |
| R12 | “Não se aplica” informado pelo solicitante | Fica como RECEBIDO com justificativa; o RH aprova (conta como aprovado, aparece como N/A no PDF) ou rejeita. Também existe “Marcar como N/A” pelo RH. |
| R13 | Opcionais | Opcional não enviado não bloqueia o PDF. Opcional **enviado** precisa ser conferido antes do PDF (para não consolidar documento não conferido). |
| R14 | EM_ANALISE | Atribuído automaticamente quando o conferente abre o documento para visualizar. |
| R15 | Reenvio | Ao rejeitar, os arquivos saem do envio atual mas permanecem no histórico (`files.is_current = false`) e continuam visíveis no painel em “Envios anteriores”. |
| R16 | Expiração do link | Padrão: `LINK_DEFAULT_EXPIRATION_DAYS` após a geração, nunca antes do fim do dia do prazo. Editável por solicitação; regenerar mantém a expiração. |
| R17 | Token do link | 32 caracteres base64url (192 bits). O exemplo `8FJ29KX` é curto demais para ser seguro. |
| R18 | Nome do PDF final | `DOCS_[NOME]` em todos os modelos (pedido do RH), configurável por modelo com variáveis como `[EQUIPAMENTO]`; acentos removidos para compatibilidade (ex.: `DOSSIE_` em vez de `DOSSIÊ_`). |
| R19 | Conteúdo do PDF final | Capa (logo, empresa, tipo, nome, CPF/CNPJ, data, protocolo) + índice com páginas e N/A + “Dados informados” (respostas e itens de texto) + documentos na ordem do checklist; frente e verso juntos; todas as páginas de PDFs enviados preservadas; fotos com rotação EXIF corrigida. |
| R20 | Finalização | Gerar PDF → armazenar → enviar e-mail → FINALIZADO. Se o e-mail falhar, o processo fica APROVADO com o PDF salvo, o erro é registrado e o RH pode reenviar ou “Finalizar sem enviar e-mail”. |
| R21 | WhatsApp | Botões “Copiar link”, “Copiar mensagem”, “Compartilhar” (Web Share API) e “WhatsApp” via `wa.me` (link oficial de clique-para-conversar), sem API não oficial. |
| R22 | Notificação ao RH | Quando o solicitante toca “Finalizar envio”, o responsável (ou `DEFAULT_NOTIFY_EMAIL`) recebe o template “documentação completa”. |
| R23 | OCR/IA | Não implementado no MVP; ponto de extensão `AnalysisService` + tabela `document_analyses`. Resultado sempre assistivo, nunca aprova sozinho. |
| R24 | PDFs com JavaScript | Não recusados (comprovantes bancários às vezes têm formulários); são sinalizados ao conferente e o PDF final é montado copiando apenas as páginas. |
| R25 | Remover documento do checklist | Só sem envios; com envios, “Marcar como N/A” preserva o histórico. |
