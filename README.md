# PAVIDEZ DOCS — Portal de Documentos da Pavidez Engenharia

Sistema web para **solicitar, receber, conferir e consolidar documentos** de admissões, contratos de
carreteiro, transportadores PJ, locação de equipamentos e prestadores de serviço.

```
MODELO → SOLICITAÇÃO → LINK EXCLUSIVO → DOCUMENTOS → CONFERÊNCIA → PDF FINAL → E-MAIL
```

- **Painel interno** (RH / conferente / administrador): modelos, solicitações, conferência, PDF final.
- **Portal externo** (`/enviar/{token}`): o solicitante abre o link no celular, sem conta, tira foto ou
  envia PDF de cada documento, acompanha pendências e reenvia o que foi rejeitado.

---

## Sumário

1. [Arquitetura](#1-arquitetura)
2. [Instalação e execução local](#2-instalação-e-execução-local)
3. [Configuração do Supabase](#3-configuração-do-supabase)
4. [Configuração do e-mail](#4-configuração-do-e-mail)
5. [Deploy](#5-deploy)
6. [Como usar](#6-como-usar)
7. [Modelos iniciais](#7-modelos-iniciais)
8. [Segurança e LGPD](#8-segurança-e-lgpd)
9. [API](#9-api)
10. [Testes](#10-testes)
11. [Decisões técnicas](#11-decisões-técnicas)

---

## 1. Arquitetura

| Camada | Tecnologia |
|---|---|
| Frontend | Next.js 15 (App Router) · TypeScript · Tailwind CSS |
| Backend | NestJS 11 · TypeScript · Zod (validação) |
| Banco | PostgreSQL 14+ (local ou Supabase) — SQL puro em `db/migrations` |
| Arquivos | Storage **privado**: disco local ou Supabase Storage (bucket privado) |
| Autenticação | Sessão JWT em cookie httpOnly; senhas bcrypt **ou** Supabase Auth |
| PDF | `pdf-lib` (merge/capa) + `sharp` (correção de rotação EXIF, compressão de fotos) |
| E-mail | `nodemailer` — qualquer SMTP/serviço transacional; driver `log` para desenvolvimento |

```
apps/
  api/                      NestJS
    src/
      domain/               regras puras e testáveis (status, regras condicionais, PDF, validação, tokens)
      auth/  users/         login, sessão, RBAC, usuários
      models/               modelos de documentação (itens, perguntas, regras)
      requests/             solicitações, checklist, conferência (aprovar/rejeitar)
      portal/               rotas públicas do link exclusivo
      files/                upload, validação, URLs assinadas, PDF por documento
      pdf/                  PDF consolidado + envio + finalização
      email/                serviço de e-mail desacoplado + templates
      storage/              drivers local / Supabase
      audit/                linha do tempo e auditoria
      analysis/             ponto de extensão para OCR/IA (desativado no MVP)
      jobs/                 expiração de links e política de retenção
    test/                   testes de domínio
  web/                      Next.js
    src/app/(painel)/       dashboard, nova solicitação, processo, modelos, usuários
    src/app/enviar/[token]  portal do solicitante (mobile first)
    src/app/login
db/
  migrations/               001_init.sql (estrutura), 002_rls.sql (RLS p/ Supabase)
  seed/seed.sql             papéis + modelos iniciais (idempotente)
scripts/                    e2e.mjs (critérios de aceite), backup.sh
docs/                       DECISOES.md
```

O navegador só conversa com o Next.js; o Next repassa `/api/*` para a API (mesma origem → cookie
httpOnly com `SameSite=Lax`, sem CORS). Toda regra de negócio fica na API.

### Fluxo de status

| Solicitação | Quando |
|---|---|
| `RASCUNHO` | criada sem gerar link |
| `AGUARDANDO_DOCUMENTOS` | link gerado, faltam documentos obrigatórios |
| `EM_CONFERENCIA` | obrigatórios enviados, aguardando conferência |
| `PENDENCIA` | algum documento rejeitado |
| `APROVADO` | todos os obrigatórios aprovados (+ opcionais enviados conferidos) e perguntas obrigatórias respondidas |
| `FINALIZADO` | PDF gerado e enviado por e-mail (ou finalizado manualmente) |
| `CANCELADO` | cancelada pelo RH (pode ser reaberta) |
| `EXPIRADO` | link venceu antes da conclusão (prorrogar a expiração reabre) |

Documento: `PENDENTE → RECEBIDO → EM_ANALISE (ao abrir para conferir) → APROVADO | REJEITADO → (reenvio) RECEBIDO`.
O status da solicitação é **sempre recalculado no servidor** a partir dos documentos.

---

## 2. Instalação e execução local

Pré-requisitos: **Node.js 20+** e **PostgreSQL 14+** (ou um projeto Supabase).

```bash
# 1. dependências
npm install

# 2. configuração
cp .env.example .env
#   edite DATABASE_URL, JWT_SECRET, TOKEN_ENCRYPTION_KEY, FILE_URL_SECRET, ADMIN_EMAIL, ADMIN_PASSWORD
#   gere segredos com:  openssl rand -base64 48

# 3. banco (cria tabelas, papéis, modelos iniciais e o administrador)
createdb pavidez_docs          # se usar Postgres local
npm run db:setup

# 4. rodar (API em :4000, painel em :3000)
npm run dev
```

Acesse **http://localhost:3000** e entre com `ADMIN_EMAIL` / `ADMIN_PASSWORD`.

> Postgres local rápido com Docker: `docker compose up -d db` (veja `docker-compose.yml`).

Com `EMAIL_DRIVER=log`, os e-mails são gravados em `storage/emails/*.eml` (abra no Outlook/Thunderbird
ou qualquer leitor de .eml). Com `STORAGE_DRIVER=local`, os arquivos ficam em `storage/requests/...`
(pasta fora do diretório público, com permissão 600).

Para testar o portal no celular na mesma rede: `APP_URL=http://SEU_IP:3000` no `.env` e abra o link gerado.

### Scripts

| Comando | O que faz |
|---|---|
| `npm run dev` | API + painel em modo desenvolvimento |
| `npm run build` / `npm start` | build e execução de produção |
| `npm run db:migrate` | aplica migrations pendentes (controle em `schema_migrations`) |
| `npm run db:seed` | papéis, modelos iniciais e administrador (idempotente) |
| `npm test` | testes de domínio (regras, status, validação de upload, PDF) |
| `node scripts/e2e.mjs` | teste ponta a ponta de todos os critérios de aceite (com a aplicação rodando) |

---

## 3. Configuração do Supabase

1. Crie um projeto em https://supabase.com.
2. **Banco**: *Project Settings → Database → Connection string → URI* (use o **Session pooler**).
   ```
   DATABASE_URL=postgresql://postgres.xxxx:SENHA@aws-0-sa-east-1.pooler.supabase.com:5432/postgres
   DATABASE_SSL=true
   ```
   Rode `npm run db:setup`. A migration `002_rls.sql` ativa RLS em todas as tabelas **sem políticas**:
   as chaves `anon`/`authenticated` não leem nada pelo PostgREST — todo acesso passa pela API.
3. **Storage**: *Project Settings → API* — copie `URL`, `anon key` e `service_role key`.
   ```
   STORAGE_DRIVER=supabase
   SUPABASE_URL=https://xxxx.supabase.co
   SUPABASE_SERVICE_ROLE_KEY=...      # somente no servidor
   SUPABASE_STORAGE_BUCKET=pavidez-docs
   ```
   O bucket é criado **privado** automaticamente no primeiro upload (a API recusa operar se ele for
   público). Downloads usam *signed URLs* com validade de `SIGNED_URL_TTL_SECONDS`.
4. **Auth (opcional)**:
   ```
   AUTH_PROVIDER=supabase
   SUPABASE_ANON_KEY=...
   ```
   As senhas passam a ser validadas no Supabase Auth; papéis/permissões continuam na tabela `users`
   (vinculada pelo e-mail). Usuários criados no painel (*Usuários → Novo*) são criados também no
   Supabase Auth. Para o primeiro administrador: crie o usuário em *Authentication → Users* com o
   mesmo `ADMIN_EMAIL` e rode `npm run db:seed`. Desative o cadastro público em
   *Authentication → Providers → Email → "Allow new users to sign up"*.
5. **Backup**: no plano Pro, ative *Point in Time Recovery*. Em qualquer plano, `scripts/backup.sh`
   gera dump do banco (agende no cron). O bucket deve ter cópia periódica (ex.: `supabase storage`
   CLI ou rclone).

---

## 4. Configuração do e-mail

```
EMAIL_DRIVER=smtp
EMAIL_FROM="PAVIDEZ DOCS <docs@pavidez.com.br>"
DEFAULT_NOTIFY_EMAIL=rh@pavidez.com.br      # destino padrão do PDF final e avisos internos
```

| Provedor | SMTP_HOST | SMTP_PORT / SECURE | Usuário / senha |
|---|---|---|---|
| Google Workspace | `smtp.gmail.com` | 465 / `true` | e-mail + **senha de app** |
| Microsoft 365 | `smtp.office365.com` | 587 / `false` | e-mail + senha (SMTP AUTH habilitado) |
| Amazon SES | `email-smtp.sa-east-1.amazonaws.com` | 587 / `false` | credenciais SMTP do SES |
| Resend | `smtp.resend.com` | 465 / `true` | `resend` + API key |
| Brevo | `smtp-relay.brevo.com` | 587 / `false` | login + chave SMTP |

Configure SPF/DKIM do domínio no provedor para evitar spam.

Templates (`apps/api/src/email/templates.ts`): **solicitação criada** (link ao solicitante),
**documento rejeitado** (ao solicitante, com motivo e botão de reenvio), **documentação completa**
(ao responsável quando o solicitante finaliza), **PDF finalizado** (com o PDF anexo) e
**erro no processamento**. Todo envio fica em `email_logs` (destinatário, assunto, data/hora,
status e erro) e aparece na tela do processo; falhas podem ser reenviadas pelo painel.

---

## 5. Deploy

Recomendado: **API + Web em um servidor/serviço Node** (Render, Railway, Fly.io, VPS) + **Supabase**
(banco, storage, auth). Sempre atrás de **HTTPS**.

Variáveis de produção importantes:

```
NODE_ENV=production
APP_URL=https://docs.pavidez.com.br
COOKIE_SECURE=true
TRUST_PROXY_HOPS=2                         # Next.js atrás de um proxy HTTPS
API_INTERNAL_URL=http://localhost:4000     # endereço interno da API visto pelo Next
```

### Opção A — um servidor (VPS) com Docker

```bash
docker compose -f docker-compose.yml --profile app up -d --build
```
`docker-compose.yml` sobe Postgres (opcional), API e Web. Coloque um Nginx/Caddy com HTTPS na frente
da porta 3000 (o Next repassa `/api` para a API). Exemplo Caddy:
```
docs.pavidez.com.br {
  reverse_proxy localhost:3000
  request_body { max_size 25MB }
}
```

### Opção B — serviços gerenciados

- **API** (Render/Railway): build `npm ci && npm run build -w apps/api`, start `npm start -w apps/api`,
  rode `npm run db:migrate && npm run db:seed` como *release command*.
- **Web**: build `npm run build -w apps/web`, start `npm start -w apps/web`, com `API_INTERNAL_URL`
  apontando para a URL da API. (Na Vercel também funciona; o limite de corpo das funções da Vercel é
  4,5 MB — para fotos maiores prefira hospedar o Web como servidor Node.)

Checklist de produção: HTTPS, `COOKIE_SECURE=true`, segredos fortes e exclusivos, bucket privado,
`STORAGE_DRIVER=supabase` (ou volume persistente com backup), SMTP com SPF/DKIM, backup diário,
`RETENTION_DAYS` definido pela política da empresa.

---

## 6. Como usar

**RH**
1. **Nova solicitação** → escolha o modelo (Admissão, Carreteiro, Transportador PJ, Locação…).
2. Informe nome/razão social, CPF/CNPJ, telefone, e-mail, responsável, prazo e dados do processo
   (ex.: equipamento, valor e período na locação).
3. Confira o checklist: incluir/excluir, reordenar, marcar obrigatório/opcional, frente e verso,
   adicionar documentos avulsos, escolher **documentos separados** ou **um único PDF**, editar a mensagem.
4. **GERAR LINK** → **Copiar link**, **Copiar mensagem**, **Compartilhar** (menu do celular) ou
   **WhatsApp** (abre o WhatsApp com a mensagem pronta — sem API não oficial).
5. Acompanhe no painel. Abra o processo, **Visualizar** cada documento (fica *Em análise*),
   **Aprovar** ou **Rejeitar** com motivo e observação. O solicitante é avisado e reenvia.
6. Com tudo aprovado: **GERAR PDF FINAL** → o PDF (capa + índice + dados + documentos na ordem do
   checklist) é armazenado e enviado por e-mail; o processo fica **FINALIZADO**.

**Solicitante** (celular): abre o link → lê as instruções → responde as perguntas (quando houver) →
em cada documento toca **Tirar foto** ou **Enviar** (frente e verso separados quando necessário) →
**FINALIZAR ENVIO**. Documentos rejeitados aparecem com ❌, motivo e botão de reenvio. Pode informar
“não se aplica” com justificativa (o RH confere).

**Criar um novo tipo de processo sem programador**: *Modelos → Novo modelo* → nome, documentos (na
ordem do PDF), perguntas e regras (ex.: *SE “O veículo está em nome de outra pessoa?” = Sim ENTÃO
solicitar “Contrato de locação/comodato”*). Salvou e está ativo → aparece em **Nova solicitação**.

---

## 7. Modelos iniciais

Criados pelo seed **somente a partir dos materiais fornecidos**:

| Modelo | Base | Observações |
|---|---|---|
| **Admissão de colaborador** | imagem “Lista de documentos para contratação” + mensagem do Bradesco/exame admissional | 20 itens; padrão “um único PDF” (como na mensagem original), alterável por solicitação. MOPP e documentos dos filhos são opcionais (a própria lista diz “para cargas inflamáveis”, “menores de 14 anos” etc.). “Telefone para contato” é um campo de texto. |
| **Contrato de carreteiro** | especificação | 8 documentos + 11 dados (pessoais e do veículo), gravados também nas tabelas `drivers` e `vehicles`. |
| **Transportador PJ** | `Checklist_Documentos_Transportador_PJ.pdf` | 5 seções, 32 itens, 5 perguntas condicionais (veículo de terceiro; motorista sócio / empregado / subcontratado / cooperado) implementadas como **regras do modelo**; conferência interna (seção 5) como perguntas internas do RH. |
| **Locação de equipamentos** | especificação + imagem “Documentos para contrato” | genérico (caminhão-pipa, escavadeira, …); mensagem do Victor editável; “Cartão CNPJ” só para locador PJ (regra PF/PJ). |
| **Prestador de serviços** | — | criado **sem documentos** (não houve checklist nos materiais); o RH configura. |
| **Modelo personalizado** | — | checklist montado na própria solicitação. |

---

## 8. Segurança e LGPD

- **Autenticação** com sessão JWT (HS256) em cookie `httpOnly`, `SameSite=Lax`, `Secure` em produção;
  usuário recarregado do banco a cada requisição (desativação imediata). Login com limite de tentativas.
- **Autorização por papel** (RBAC em `roles.permissions`): Administrador (`*`), RH, Conferente.
  O guard é global: toda rota é privada salvo as marcadas como públicas (login, portal, arquivo assinado).
- **Link exclusivo**: 192 bits aleatórios; no banco ficam só o **hash SHA-256** (busca) e o token
  **cifrado com AES-256-GCM** (para recopiar o link). Expiração configurável, ativar/desativar,
  regenerar (invalida o anterior). O portal só enxerga a própria solicitação, não mostra CPF/CNPJ,
  respostas internas nem baixa arquivos.
- **Arquivos privados**: nomes de storage aleatórios (`requests/{uuid}/original/{uuid}.pdf` — nunca
  CPF ou nome), sem URL pública; visualização por **URL temporária assinada** (HMAC, 5 min) ou
  *signed URL* do Supabase; `Cache-Control: no-store`, `nosniff`, imagens em `CSP sandbox`.
- **Upload**: extensão + MIME declarado + assinatura binária real + tamanho + vazio + integridade
  (PDF aberto com pdf-lib, imagem decodificada por completo com sharp), PDF com senha recusado,
  PDFs com JavaScript/ações/anexos sinalizados para o conferente; limite por arquivo e por envio;
  *rate limit* no portal. Os originais são preservados; o PDF final usa cópias reprocessadas (fotos
  recodificadas, sem metadados EXIF/GPS).
- **Auditoria**: `audit_logs` registra quem fez o quê, quando, IP e navegador (criação, link, envios,
  visualizações/downloads de arquivos, aprovações, rejeições, PDF, e-mails, status).
- **Dados bancários**: só o comprovante/dados que a empresa pediu; as instruções orientam a não
  enviar senha, saldo ou movimentações. Nenhuma senha bancária é armazenada.
- **Retenção**: `RETENTION_DAYS` + `RETENTION_AUTO_PURGE` removem os arquivos de processos
  finalizados/cancelados após N dias (metadados e auditoria permanecem).
- **Backup**: `scripts/backup.sh` (pg_dump) + PITR do Supabase + cópia do bucket.
- **Banco no Supabase**: RLS ativo sem políticas (bloqueia acesso direto via chaves públicas).
- Sem credenciais no código: tudo via `.env` validado na inicialização (a API não sobe com segredo fraco).

---

## 9. API

Prefixo `/api`. Autenticadas (cookie de sessão) salvo indicação.

| Método | Rota | Descrição |
|---|---|---|
| POST | `/auth/login` · `/auth/logout` · GET `/auth/me` | sessão (login público) |
| GET/POST/PATCH | `/users`, `/users/roles`, `/users/options` | usuários (admin) |
| GET/POST | `/models` | listar / criar modelo |
| GET/PUT | `/models/:id` | detalhar / salvar (itens, perguntas e regras) |
| POST | `/models/:id/duplicate` · PATCH `/models/:id/active` | duplicar / ativar |
| GET | `/requests` (`status, modelId, responsibleUserId, from, to, q, document, page`) · `/requests/stats` | painel |
| POST | `/requests/preview` | avalia checklist + regras para a tela de criação |
| POST | `/requests` | criar solicitação (checklist personalizado, gera link) |
| GET/PATCH | `/requests/:id` | detalhe completo / editar dados, prazo, mensagem, expiração |
| PUT | `/requests/:id/answers` | respostas internas (reaplica regras) |
| POST | `/requests/:id/link` (`regenerate`) · `/link/active` · `/link/sent` · `/link/email` | link exclusivo |
| POST/PATCH/DELETE | `/requests/:id/documents[/:docId]` · PUT `/documents/order` | checklist da solicitação (N/A, obrigatório, adicionar, remover, ordenar) |
| POST | `/requests/:id/documents/:docId/review/start` · `/approve` · `/reject` | conferência |
| POST | `/requests/:id/documents/:docId/files` · `/text` | anexar pelo RH |
| GET | `/requests/:id/documents/:docId/pdf` | PDF do documento (frente+verso) |
| POST | `/requests/:id/final-pdf` · `/final-pdf/email` · `/finalize` | PDF final, reenvio, finalizar |
| POST | `/requests/:id/cancel` · `/reopen` | cancelar / reabrir |
| GET | `/files/:id/url` → GET `/files/signed/:token` (público, assinado) | visualizar/baixar |
| GET | `/portal/:token` | **público** — dados do link |
| POST/DELETE | `/portal/:token/documents/:docId/files[/:fileId]` | **público** — enviar/remover arquivo |
| POST | `/portal/:token/documents/:docId/text` · `/not-applicable` | **público** |
| PUT/POST | `/portal/:token/answers` · `/portal/:token/submit` | **público** |
| GET | `/health` | saúde (banco) |

---

## 10. Testes

```bash
npm test                         # domínio: regras condicionais, status, CPF/CNPJ, validação de upload, PDF
npm run test:flow                # serviços contra o Postgres (DATABASE_URL): modelos, carreteiro, PJ condicional,
                                 #   locação, admissão PDF único, expiração — use um banco de teste com seed
npm run dev                      # em outro terminal
node scripts/e2e.mjs             # 21 critérios de aceite ponta a ponta (login → PDF → e-mail → histórico)
```

---

## 11. Decisões técnicas

Registradas em [`docs/DECISOES.md`](docs/DECISOES.md).
