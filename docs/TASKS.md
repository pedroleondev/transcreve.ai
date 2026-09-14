# ✅ TASKS.md — Backlog Executável

> Fonte única de verdade do que fazer. Uma tarefa por sessão (ver [WORKFLOW.md](WORKFLOW.md)).
> Estados: `TODO` · `DOING` · `DONE` · `BLOCKED`
> Atualizado em 31/08/2026.

## Quadro

| ID | Tarefa | Prioridade | Estado |
|---|---|---|---|
| T-01 | Fechar autenticação (remover bypass e senhas mestras) | 🔴 P0 | TODO |
| T-02 | Isolamento multi-tenant (`WHERE user_id`) em todas as rotas | 🔴 P0 | TODO |
| T-03 | Teste de carga e isolamento com 10 usuários | 🔴 P0 | TODO |
| T-04 | UI de leitura da transcrição (Markdown/HTML formatado) | 🟠 P1 | TODO |
| T-05 | Tema escuro | 🟠 P1 | TODO |
| T-06 | Concorrência da fila configurável + posição na fila na UI | 🟠 P1 | TODO |
| T-07 | Aplicar `daily_limit` e limite de upload | 🟡 P2 | TODO |
| T-08 | Endurecer SQLite (WAL + índices) | 🟡 P2 | TODO |
| T-09 | Página de Conta do usuário (perfil + trocar senha) | 🟡 P2 | TODO |
| T-10 | Corrigir `README.md` da raiz (descreve outro projeto) | 🟢 P3 | DONE |

---

### T-01 — Fechar autenticação
**Estado:** TODO · **Prioridade:** 🔴 P0
**Por quê:** hoje requisição sem token = admin, e as senhas `admin123`/`user123` abrem qualquer conta. Detalhe e evidência em [MULTIUSER.md](MULTIUSER.md) B-01 e B-02.
**Contexto:** `server.js:51-120`, `docker-compose.yml`, `docs/MULTIUSER.md` §2
**Toca:** `server.js`, `docker-compose.yml`, `.env.example`, `test_suite.js`
**Aceite:**
- [ ] `GET /api/transcriptions` sem `Authorization` → **401**
- [ ] `GET /api/admin/users` sem token → **401**; com token de `role='user'` → **403**
- [ ] Login com senha errada → **401** (senhas mestras removidas)
- [ ] Servidor **recusa subir** se `JWT_SECRET` não estiver definido em produção (`NODE_ENV=production`)
- [ ] `test_suite.js` ganha asserções para os 4 itens acima e continua verde

**Evidência:** _(preencher)_

---

### T-02 — Isolamento multi-tenant
**Estado:** TODO · **Prioridade:** 🔴 P0 · **Depende de:** T-01
**Por quê:** nenhuma query filtra por dono; qualquer usuário lê, edita e apaga o conteúdo dos outros ([MULTIUSER.md](MULTIUSER.md) B-03).
**Contexto:** `server.js:139-400`, `docs/STACK.md` §4
**Toca:** `server.js`, `db.js`, `test_suite.js`
**Aceite:**
- [ ] Helper único `scopeToUser(req)` aplicado em: `/api/projects`, `/api/transcriptions`, `/:id`, `/:id/status`, `PUT`, `DELETE`, `/api/export/:id/:format`, `/api/chat`, `/api/translate`
- [ ] Admin mantém visão global **apenas** quando enviar `?all=true` explicitamente
- [ ] Acesso a recurso de outro usuário → **404** (não 403 — não revela existência)
- [ ] `/uploads` deixa de ser estático público; passa por rota autenticada que valida o dono
- [ ] Usuário B não enxerga nem baixa nada do usuário A

**Evidência:** _(preencher)_

---

### T-03 — Teste de carga e isolamento com 10 usuários
**Estado:** TODO · **Prioridade:** 🔴 P0 · **Depende de:** T-01, T-02
**Por quê:** validar a configuração Docker atual sob uso multiusuário real e medir o teto da fila.
**Contexto:** `tests/load_multiuser.js`, `docs/MULTIUSER.md` §4 e §6
**Toca:** `tests/load_multiuser.js`, `docs/MULTIUSER.md`
**Aceite:**
- [ ] `node tests/load_multiuser.js --no-transcribe` → 100% PASS nas fases A (segurança) e B (isolamento)
- [ ] `node tests/load_multiuser.js` → fase C conclui os 10 jobs sem `failed` e sem `SQLITE_BUSY`
- [ ] Tabela de tempos (p50/p95 de resposta, tempo do último job) registrada em `MULTIUSER.md` §4
- [ ] Nenhum vazamento cruzado detectado

**Evidência (baseline 31/08/2026):** script criado e executado; `node tests/load_multiuser.js --no-transcribe` → **3 PASS / 8 FAIL**, exatamente as falhas previstas por T-01 e T-02. Saída completa em [MULTIUSER.md](MULTIUSER.md) §7. A tarefa fecha quando esta mesma execução der 100% PASS.

---

### T-04 — UI de leitura da transcrição
**Estado:** TODO · **Prioridade:** 🟠 P1
**Por quê:** hoje `renderCurrentTranscript()` (`app.js:719`) produz ou um `<p>` gigante com o texto corrido, ou uma lista plana de segmentos. Conteúdo longo fica ilegível.
**Contexto:** `app.js:719-751`, `index.html:221-260`, `services/exporter.js`
**Toca:** `app.js`, `index.html`
**Aceite:**
- [ ] Três **modos de leitura** alternáveis, persistidos em `localStorage`:
      `Transcrição` (segmentos + timestamps, como hoje) · `Leitura` (parágrafos agrupados, sem ruído) · `Resumo` (o `ai_summary` renderizado)
- [ ] `ai_summary` já vem em **Markdown** do backend (`server.js:702`) e hoje não é renderizado como tal → renderizar títulos, listas, negrito e citações
- [ ] Modo Leitura agrupa segmentos em parágrafos por pausa (> 1,5 s) e por troca de falante, em vez de uma linha por segmento
- [ ] Controles de conforto de leitura: tamanho da fonte (3 níveis) e largura da coluna (estreita/larga), persistidos
- [ ] Falantes com rótulo visual distinto e consistente
- [ ] Botão "Copiar como Markdown"
- [ ] Edição inline (`contenteditable`) continua funcionando no modo Transcrição, e `saveTranscriptChanges()` não corrompe o texto
- [ ] Sanitização do Markdown renderizado (sem `innerHTML` cru de conteúdo vindo da IA)

**Nota:** manter o princípio "sem build step" — renderizador Markdown mínimo próprio ou lib via CDN, decidido na sessão.

**Evidência:** _(preencher)_

---

### T-05 — Tema escuro
**Estado:** TODO · **Prioridade:** 🟠 P1 · **Faz par com:** T-04
**Por quê:** não existe nenhuma classe `dark:` no projeto (`grep -c "dark:" index.html` → 0). Leitura prolongada pede tema escuro.
**Contexto:** `index.html:12-53` (config Tailwind inline), `app.js:1-36`
**Toca:** `index.html`, `app.js`
**Aceite:**
- [ ] `tailwind.config` com `darkMode: 'class'`
- [ ] Alternador com 3 estados: Claro · Escuro · Sistema (`prefers-color-scheme`), persistido em `localStorage`
- [ ] Aplicação do tema **antes da primeira pintura** (script inline no `<head>`), sem flash branco
- [ ] Paleta definida por tokens, não por cores soltas — as 3 views, os modais e os drawers cobertos
- [ ] Contraste AA no texto da transcrição em ambos os temas
- [ ] Cores hardcoded em `app.js` (badges de status, tabela) migradas para classes com variante `dark:`

**Evidência:** _(preencher)_

---

### T-06 — Concorrência da fila + posição visível
**Estado:** TODO · **Prioridade:** 🟠 P1 · **Depende de:** T-03 (medição)
**Por quê:** `isWorkerRunning` (`server.js:594`) limita o sistema inteiro a 1 transcrição por vez; o usuário vê `pending` sem saber que há 6 na frente.
**Contexto:** `server.js:588-760`, `app.js:600-622`, `docs/MULTIUSER.md` §2 B-04
**Toca:** `server.js`, `app.js`, `index.html`, `.env.example`
**Aceite:**
- [ ] `WORKER_CONCURRENCY` (env, default 2) substitui a trava booleana; jobs em voo controlados por conjunto de IDs
- [ ] Claim atômico do job (`UPDATE ... SET status='processing' WHERE id=? AND status='pending'`) — sem dois workers pegando o mesmo
- [ ] `GET /api/transcriptions/:id/status` retorna `queue_position`
- [ ] UI mostra "3º na fila" em vez de só "pendente"
- [ ] Job travado em `processing` há mais de N minutos volta para `pending`, com contador de tentativas
- [ ] Sob 10 uploads simultâneos, a UI dos outros usuários permanece responsiva

**Evidência:** _(preencher)_

---

### T-07 — Cotas e limites de upload
**Estado:** TODO · **Prioridade:** 🟡 P2 · **Depende de:** T-01
**Por quê:** `users.daily_limit` existe no banco e **nunca é consultado**; o Multer aceita arquivo de qualquer tamanho ([MULTIUSER.md](MULTIUSER.md) R-05, R-06).
**Contexto:** `server.js:26-33`, `server.js:228-280`, `db.js` (`system_settings`)
**Toca:** `server.js`
**Aceite:**
- [ ] `/api/transcribe` conta as transcrições do usuário nas últimas 24 h e retorna **429** ao exceder `daily_limit`
- [ ] Admin (`daily_limit: 999999`) não é bloqueado
- [ ] `multer({ limits: { fileSize } })` alimentado por `system_settings.max_file_size_mb`
- [ ] Rejeição de duração acima de `max_duration_hours` após o `ffprobe`, com `error_message` claro
- [ ] UI mostra "X de Y transcrições hoje"

**Evidência:** _(preencher)_

---

### T-08 — Endurecer SQLite
**Estado:** TODO · **Prioridade:** 🟡 P2
**Por quê:** banco sem WAL e sem índices; com 10 usuários mais o worker atualizando `progress` a cada etapa, aparece `SQLITE_BUSY` ([MULTIUSER.md](MULTIUSER.md) R-02, R-03).
**Contexto:** `db.js:1-45`, `docs/STACK.md` §3
**Toca:** `db.js`
**Aceite:**
- [ ] `PRAGMA journal_mode=WAL`, `PRAGMA busy_timeout=5000`, `PRAGMA foreign_keys=ON` no boot
- [ ] Índices: `transcriptions(user_id, created_at)`, `transcriptions(status)`, `segments(transcription_id)`, `projects(user_id)`
- [ ] Criação idempotente (`CREATE INDEX IF NOT EXISTS`), sem quebrar o banco existente
- [ ] `test_suite.js` verde contra o banco já populado

**Evidência:** _(preencher)_

---

### T-09 — Página de Conta
**Estado:** TODO · **Prioridade:** 🟡 P2 · **Depende de:** T-01
**Por quê:** não existe tela de perfil; trocar senha exige o admin ([PRODUCT.md](PRODUCT.md) P-03).
**Contexto:** `index.html` (views), `app.js:240-257` (`showView`), `server.js:84-137`
**Toca:** `server.js`, `index.html`, `app.js`
**Aceite:**
- [ ] View `#view-account` com nome, e-mail, papel, consumo do dia e preferências (tema, modo de leitura)
- [ ] `PUT /api/auth/password` exigindo a senha atual
- [ ] Logout que limpa o `localStorage` e volta ao modal de login
- [ ] Sem token válido, a SPA mostra o login em vez do dashboard (hoje ela assume um usuário padrão em `app.js:3`)

**Evidência:** _(preencher)_

---

### T-10 — Corrigir README da raiz
**Estado:** DONE · **Prioridade:** 🟢 P3
**Por quê:** o `README.md` documenta uma landing page de plano de saúde com n8n/PostgreSQL/EvolutionAPI — outro projeto. O onboarding começa errado.
**Contexto:** `README.md`, `docs/product.md`, `docs/stack.md`
**Toca:** `README.md`
**Aceite:**
- [x] README descreve o TranscreveAI: o que é, como subir (`docker compose up -d`), credenciais e links para `docs/`
- [x] Conteúdo antigo preservado em `docs/legado-landing-n8n.md`

**Evidência (14/09/2026):** `README.md` reescrito com visão geral, aviso de segurança multiusuário, quickstart Docker e mapa de documentação; conteúdo antigo (n8n/PostgreSQL/EvolutionAPI) movido para `docs/legado-landing-n8n.md` com nota de que `config.js` ficou órfão (não referenciado por `server.js`/`app.js`/`index.html` atuais). De quebra: criado `docs/INSTALL.md` (guia self-hosting completo — Docker standalone, Docker+Traefik, Node direto, backup, troubleshooting) e `tests/fixtures/sample.ogg` (áudio sintético via TTS, sem dado real de cliente) substituindo o arquivo de cliente que `test_suite.js` e `tests/load_multiuser.js` usavam antes.

---

## Concluídas

| Tarefa | Commit |
|---|---|
| Pipeline assíncrono de transcrição com pré-processamento | `eb283a8` |
| ffmpeg na imagem Docker (destrava a fila) | `9b58da2` |
| Correção do endpoint `/api/chat` | `cb798b2` |
| Suíte de testes adaptada ao pipeline assíncrono | `6f7484d` |
| Premissa de deploy Docker + Git Flow formalizados | `4c5f316` |
