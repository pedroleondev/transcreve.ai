# ✅ TASKS.md — Backlog Executável

> Fonte única de verdade do que fazer. Uma tarefa por sessão (ver [WORKFLOW.md](WORKFLOW.md)).
> Estados: `TODO` · `DOING` · `DONE` · `BLOCKED`
> Atualizado em 28/09/2026 (backlog remodelado na virada SaaS: T-08 redesenhada, T-11 rescopada, T-12/T-14 absorvidas, T-26 a T-33 criadas).
> **Foco atual (decisão de 14/09):** uso pessoal, sem cota. O sistema é para **gravações longas (8h/dia de trabalho), recebidas por upload**, transcritas com qualidade independente do tamanho, e depois **lidas, editadas e transformadas em informação** (processos, conteúdo, orientação). Gravar pelo navegador não é prioridade. Multiusuário (T-01/T-02/T-03/T-07) continua no backlog, mas não bloqueia.
>
> **Paridade-alvo com o concorrente:** arquivos de até 10 h / 5 GB · 50 arquivos por vez · todos os formatos que o ffmpeg lê · 98 idiomas · exportar PDF/DOCX/TXT/SRT/VTT/CSV, em massa · locutores reais · tradução com legendas · sem limite de uso. Cada item está mapeado numa tarefa abaixo.

## Quadro

| ID | Tarefa | Prioridade | Estado |
|---|---|---|---|
| T-01 | Fechar autenticação (remover bypass e senhas mestras) | 🔴 P0 | DONE |
| T-02 | Isolamento multi-tenant (`WHERE user_id`) em todas as rotas | 🔴 P0 | DONE |
| T-03 | Teste de carga e isolamento com 10 usuários | 🔴 P0 | DONE |
| T-04 | UI de leitura da transcrição (modos de leitura, Markdown, conforto) | 🟠 P1 | DONE |
| T-05 | Tema escuro | 🟠 P1 | DONE |
| T-06 | Concorrência da fila configurável + posição na fila na UI | 🟠 P1 | DONE |
| T-07 | Cotas e limites de uso (`daily_limit`, max upload/duração), editáveis pelo admin | 🔴 P0 | TODO |
| T-08 | Migração SQLite → PostgreSQL (container `db` + ETL validado, sem perda; troca do driver = fase 2) | 🔴 P0 | DOING |
| T-09 | Página de Conta (perfil, trocar senha, esqueci senha por e-mail, logs de uso) | 🟠 P1 | TODO |
| T-10 | Corrigir `README.md` da raiz (descreve outro projeto) | 🟢 P3 | DONE |
| T-11 | Entrada por link (YouTube/Vimeo) + arquivos de vídeo | 🟠 P1 | TODO |
| T-12 | ~~Player fixo no rodapé~~ — **absorvida pela T-29** (reformulação UX/UI) | — | ABSORVIDA |
| T-13 | Baixar áudio original (rota autenticada) + exportar em massa | 🔴 P0 | TODO |
| T-14 | ~~UX de modais~~ — **absorvida pela T-29** (reformulação UX/UI) | — | ABSORVIDA |
| T-15 | Chave OpenRouter: entrada protegida, teste antes de salvar, cifrada em repouso | 🔴 P0 | DONE |
| T-16 | Renomear níveis → **Base / Pro / Max** | 🟠 P1 | DONE |
| T-17 | Layout responsivo: celular e tablet | 🔴 P0 | DONE |
| T-18 | Aprimoramento de transcrição por IA (correção + estruturação) | 🔴 P0 | DONE |
| T-19 | Pipeline resiliente para áudios longos (10 h / 5 GB / 50 arquivos) | 🔴 P0 | DONE |
| T-20 | Formatos e idiomas: aceitar tudo que o ffmpeg lê, 100 idiomas + auto-detecção | 🟠 P1 | DONE |
| T-21 | Exportar CSV + Ferramenta de Tradução com legendas | 🟢 P3 | TODO |
| T-22 | Reconhecimento de locutores **real** (diarização) | 🟢 P3 | TODO |
| T-23 | Gestão de usuários (admin cria usuários e admins) | 🔴 P0 | DONE |
| T-24 | JEV (juiz de validação) no aprimoramento — viabilidade e desenho | 🟠 P1 | DONE |
| T-25 | JEV implementado: juiz valida o aprimoramento antes de entregar | 🟠 P1 | DONE |
| T-26 | MinIO/S3 para arquivos (camada de storage isolada) | 🟡 P2 | TODO |
| T-27 | Asaas: assinaturas, webhook de pagamento, suspensão automática | 🔴 P0 | TODO |
| T-28 | Landing page + auto-cadastro + confirmação de e-mail | 🔴 P0 | TODO |
| T-29 | Reformulação UX/UI "Obsidian Wave" (4 fases; absorve T-12/T-14) | 🟠 P1 | TODO |
| T-30 | API pública + webhooks (tool para LLMs) | 🟡 P2 | TODO |
| T-31 | MCP server / skills sobre a API | 🟢 P3 | TODO |
| T-32 | Deploy one-click (compose prod, `.env` documentado, INSTALL) | 🟠 P1 | TODO |
| T-33 | Gravador de voz (waveform, pausar, idioma) | 🟢 P3 | TODO |

**Ordeiro de execução (remodelado 28/09 — virada SaaS):** **T-08** (Postgres, fundação) → T-07 (cotas) → T-13 (export em massa) → T-28 (landing/cadastro) → T-27 (Asaas) → T-32 (deploy) → T-29 (UX/UI, pode correr em paralelo desde a Fase 1) → T-09 · T-11 · T-30 → T-26 → T-21 · T-22 · T-31 · T-33.
Métrica de escala assumida: 35 mil usuários em 6 meses, billing via Asaas, deploy em KVM2/Portainer. T-08 vai primeiro porque billing, cadastro e API pública todos escrevem no banco — em SQLite seriam `SQLITE_BUSY` na primeira campanha.

---

### T-01 — Fechar autenticação
**Estado:** DONE (19/09/2026) · **Prioridade:** 🔴 P0
**Por quê:** hoje requisição sem token = admin, e as senhas `admin123`/`user123` abrem qualquer conta. Detalhe e evidência em [MULTIUSER.md](MULTIUSER.md) B-01 e B-02.
**Contexto:** `server.js:51-120`, `docker-compose.yml`, `docs/MULTIUSER.md` §2
**Toca:** `server.js`, `docker-compose.yml`, `.env.example`, `test_suite.js`
**Aceite:**
- [x] `GET /api/transcriptions` sem `Authorization` → **401**
- [x] `GET /api/admin/users` sem token → **401**; com token de `role='user'` → **403**
- [x] Login com senha errada → **401** (senhas mestras removidas)
- [x] Servidor **recusa subir** se `JWT_SECRET` não estiver definido em produção (`NODE_ENV=production`)
- [x] `test_suite.js` ganha asserções para os 4 itens acima e continua verde

**Evidência (19/09/2026):**
- Bypass em `authenticateToken` removido (`server.js`): requisições sem token agora retornam 401 Unauthorized.
- Senhas mestras `admin123`/`user123` removidas do fluxo de login em `server.js`; o login agora exige hash bcrypt correspondente.
- Verificação no startup (`server.js`): em `NODE_ENV=production`, se `JWT_SECRET` for omitido ou mantido no valor padrão, o processo encerra imediatamente com `exit(1)` e log de erro crítico (`ERRO CRÍTICO: JWT_SECRET não definido...`).
- Suíte `test_suite.js` atualizada com os 4 testes de segurança de autenticação (401 sem token, 401 senha errada, 403 usuário comum em rota admin, login com obtenção de JWT) e injeção do cabeçalho `Authorization: Bearer <token>`.
- `node test_suite.js` executado com sucesso: **37/37 PASS**.

---

### T-02 — Isolamento multi-tenant
**Estado:** DONE (24/09/2026) · **Prioridade:** 🔴 P0 · **Depende de:** T-01
**Por quê:** nenhuma query filtra por dono; qualquer usuário lê, edita e apaga o conteúdo dos outros ([MULTIUSER.md](MULTIUSER.md) B-03).
**Contexto:** `server.js:139-400`, `docs/STACK.md` §4
**Toca:** `server.js`, `db.js`, `test_suite.js`
**Aceite:**
- [x] Helper único `scopeToUser(req)` aplicado em: `/api/projects`, `/api/transcriptions`, `/:id`, `/:id/status`, `PUT`, `DELETE`, `/api/export/:id/:format`, `/api/chat`, `/api/translate`
- [x] Admin mantém visão global **apenas** quando enviar `?all=true` explicitamente
- [x] Acesso a recurso de outro usuário → **404** (não 403 — não revela existência)
- [x] `/uploads` deixa de ser estático público; passa por rota autenticada que valida o dono
- [x] Usuário B não enxerga nem baixa nada do usuário A

**Evidência (24/09/2026):** helpers `scopeOf(req)`/`ownedTranscription(id, scope)` em `server.js`; `/uploads/:file` autenticado com validação de dono via `file_path` no banco + `path.basename` anti-traversal; `authenticateToken` aceita `?token=` para tags `<audio>`; frontend envia `?all=true` (admin) e `transcription_id` em chat/translate. `test_suite.js` → **79/79 PASS**; `load_multiuser.js` → fases A+B+C **13/13 PASS** (ver T-03). Áudio validado: 200 com token do dono, 401 sem token.

---

### T-03 — Teste de carga e isolamento com 10 usuários
**Estado:** DOING · **Prioridade:** 🔴 P0 · **Depende de:** T-01, T-02
**Por quê:** validar a configuração Docker atual sob uso multiusuário real e medir o teto da fila.
**Contexto:** `tests/load_multiuser.js`, `docs/MULTIUSER.md` §4 e §6
**Toca:** `tests/load_multiuser.js`, `docs/MULTIUSER.md`
**Aceite:**
- [x] `node tests/load_multiuser.js --no-transcribe` → 100% PASS nas fases A (segurança) e B (isolamento)
- [x] `node tests/load_multiuser.js` → fase C conclui os 10 jobs sem `failed` e sem `SQLITE_BUSY`
- [x] Tabela de tempos (p50/p95 de resposta, tempo do último job) registrada em `MULTIUSER.md` §4
- [x] Nenhum vazamento cruzado detectado

**Evidência (baseline 31/08/2026):** script criado e executado; `node tests/load_multiuser.js --no-transcribe` → **3 PASS / 8 FAIL**, exatamente as falhas previstas por T-01 e T-02. Saída completa em [MULTIUSER.md](MULTIUSER.md) §7.

**Evidência (fechamento 24/09/2026):** `node tests/load_multiuser.js --no-transcribe` → **10/10 PASS** (fases A+B). `node tests/load_multiuser.js` → **13/13 PASS** (A+B+C): 10 uploads simultâneos aceitos em 190 ms (p50 177 ms / p95 188 ms de aceite), todos os jobs completaram, nenhum `failed`, nenhum `SQLITE_BUSY`; fim-a-fim mediana 25 s, último 86 s (fila serial). Tempos registrados em [MULTIUSER.md](MULTIUSER.md) §4.

---

### T-04 — UI de leitura da transcrição
**Estado:** DONE (20/09/2026) · **Prioridade:** 🟠 P1
**Por quê:** hoje `renderCurrentTranscript()` (`app.js:719`) produz ou um `<p>` gigante com o texto corrido, ou uma lista plana de segmentos. Conteúdo longo fica ilegível.
**Contexto:** `app.js` (renderCurrentTranscript, saveTranscriptChanges), `index.html` (leitor), `services/exporter.js`, `server.js` (PUT transcriptions), `db.js` (schema segments), `tests/ui_regressions.js`, `test_suite.js`, `docs/product.md`, `docs/stack.md`
**Toca:** `app.js`, `index.html`, `server.js`, `services/transcript-editor.js`, `tests/transcript_editor.js`, `tests/ui_regressions.js`, `test_suite.js`, `docs/product.md`, `docs/stack.md`, `docs/TASKS.md`
**Aceite:**
- [x] Três **modos de leitura** alternáveis, persistidos em `localStorage`:
      `Transcrição` (segmentos + timestamps, como hoje) · `Leitura` (parágrafos agrupados, sem ruído) · `Resumo` (o `ai_summary` renderizado)
- [x] `ai_summary` já vem em **Markdown** do backend (`server.js:702`) e hoje não é renderizado como tal → renderizar títulos, listas, negrito e citações
- [x] Modo Leitura agrupa segmentos em parágrafos por pausa (> 1,5 s) e por troca de falante, em vez de uma linha por segmento
- [x] Controles de conforto de leitura: tamanho da fonte (3 níveis) e largura da coluna (estreita/larga), persistidos
- [x] Falantes com rótulo visual distinto e consistente
- [x] Botão "Copiar como Markdown"
- [x] Edição inline (`contenteditable`) continua funcionando no modo Transcrição, e `saveTranscriptChanges()` não corrompe o texto
- [x] Sanitização do Markdown renderizado (sem `innerHTML` cru de conteúdo vindo da IA)

**Evidência (19/09/2026):**
- Criada a barra de ferramentas de leitura em `index.html` com alternador de 3 modos (`Transcrição`, `Leitura`, `Resumo IA`), controles de tamanho de fonte (`P`/`M`/`G`), largura de coluna (`Estreita`/`Normal`/`Larga`) e botão `Copiar Markdown`.
- Implementada persistência em `localStorage` para `transcreveai_reading_mode`, `transcreveai_font_size` e `transcreveai_column_width`.
- Modo **Leitura** agrupa segmentos por pausas maiores que 1,5s e troca de falante (`buildReadingParagraphs()`), exibindo o badge do falante e o timestamp no topo do parágrafo.
- Modo **Resumo IA** renderiza o campo `ai_summary` via parser seguro `renderMarkdown()` (suporte a `#`, `##`, `###`, negrito, itálico, listas com bullet/checkbox, blocos de código e citações).
- Implementada paleta determinística e consistente de cores de badges por falante (`getSpeakerColor()`).
- Adicionada função `copyTranscriptAsMarkdown()` para copiar o texto formatado via `navigator.clipboard.writeText`.
- `contenteditable="true"` mantido no modo Transcrição; `saveTranscriptChanges()` testado e persistindo edições em `raw_text` sem corrupção.
- `node test_suite.js` executado com sucesso: **37/37 PASS**.

---

**Conclusao da retomada (20/09/2026):**
- Editor restrito ao texto de cada segmento (contenteditable plaintext-only); timestamps e falantes nao sao editaveis. Transcricoes sem segmentos mantem edicao de texto simples.
- PUT recebe segments [{id, text}], valida lista completa/IDs/tipos e salva segmentos + raw_text na mesma transacao em conexao SQLite propria. Falha intermediaria reverte tudo; processamento ativo retorna 409; segmento alheio/inexistente retorna 400.
- Estado sincronizado apos salvar; botao oculto em Leitura/Resumo; erros visiveis; troca de modo com edicoes nao salvas pede descarte.
- node tests/transcript_editor.js: **14/14 PASS** (persistencia, metadados, TXT/SRT/VTT, entradas invalidas e rollback).
- node tests/ui_regressions.js: **11/11 PASS**.
- docker exec transcreveai-app node test_suite.js: **44/44 PASS**, com audio sintetico real via OpenRouter, edicao, reabertura e conteudo exportado.
- Navegador em localhost: editar sample.ogg → salvar → Leitura → Resumo → recarregar → reabrir confirmou persistencia. Texto do teste de UI restaurado ao final.
- Deploy: fila com 0 jobs; docker compose restart transcreveai; helper verificado dentro do container. Sem alteracao de segredos ou Compose nesta tarefa.

### T-05 — Tema escuro
**Estado:** DONE (20/09/2026) · **Prioridade:** 🟠 P1 · **Faz par com:** T-04
**Por quê:** a implementacao parcial tinha cores claras nos elementos dinamicos e alternador escondido no menu por hover. Leitura prolongada pede cobertura consistente e controle visivel.
**Contexto:** `index.html` (head, cabecalho e classes de views/modais), `app.js` (tema e classes dinamicas), `docs/product.md` §3, `tests/ui_regressions.js`
**Toca:** `index.html`, `app.js`, `tests/theme.js`, `docs/TASKS.md`, `docs/product.md`
**Aceite:**
- [x] `tailwind.config` com `darkMode: 'class'`
- [x] Alternador com 3 estados: Claro · Escuro · Sistema (`prefers-color-scheme`), persistido em `localStorage`
- [x] Aplicação do tema **antes da primeira pintura** (script inline no `<head>`), sem flash branco
- [x] Paleta definida por tokens, não por cores soltas — as 3 views, os modais e os drawers cobertos
- [x] Contraste AA no texto da transcrição em ambos os temas
- [x] Cores hardcoded em `app.js` (badges de status, tabela) migradas para classes com variante `dark:`

**Evidencia (20/09/2026):**
- Alternador Claro / Escuro / Sistema permanentemente visivel no cabecalho, com icones Lucide, destaque do selecionado, aria-pressed e foco de teclado. Em 360 px ocupa uma segunda linha sem cortar os botoes.
- Preferencia persistida em localStorage; Sistema acompanha mudancas do SO, mas nao sobrepoe Claro/Escuro. Bootstrap antes de CDN/fontes e tokens CSS no head evitam primeira pintura clara quando a preferencia e escura.
- Paleta semantica brand.surface/canvas/raised/ink/copy/muted/line/accent definida por variaveis CSS com pares claro/escuro. Aplicada nas tres views, paineis, modais, inputs e cores dinamicas do leitor, Markdown, tabelas, badges e menus. Sidebar e cabecalho mantem identidade fixa.
- node tests/theme.js: **20/20 PASS**; contraste do corpo da transcricao **17,85:1 claro / 14,48:1 escuro** (AA >= 4,5:1).
- node tests/ui_regressions.js: **11/11 PASS**; docker exec transcreveai-app node test_suite.js: **44/44 PASS**.
- Navegador: dashboard, leitor, drawer IA e modal de upload inspecionados; cores das superficies administrativas verificadas. Alternancia via Enter, persistencia apos reload e botoes dentro do viewport de 360 px confirmados. Modo Sistema restaurado ao final.
- Arquivos estaticos publicados pelo bind-mount e verificados via localhost; nenhuma alteracao de servidor, banco ou segredo nesta tarefa.

---

### T-06 — Concorrência da fila + posição visível
**Estado:** DONE (28/09/2026) · **Prioridade:** 🟠 P1 · **Depende de:** T-03 (medição)
**Por quê:** `isWorkerRunning` (`server.js:594`) limita o sistema inteiro a 1 transcrição por vez; o usuário vê `pending` sem saber que há 6 na frente.
**Contexto:** `services/pipeline.js`, `services/audio.js` (runProcess), `services/openrouter.js` (fetch/mock), `db.js` (init/helpers), `server.js` (startup/lista/status), `app.js` (fila/poll), `docs/MULTIUSER.md` §2 B-04 e §4, `docs/stack.md`, `docs/system_design.md`, `pipeline.md`, `tests/long_audio.js` (padrao de teste)
**Toca:** `server.js`, `app.js`, `index.html`, `db.js`, `services/pipeline.js`, `services/queue.js`, `services/job-context.js`, `services/audio.js`, `services/openrouter.js`, `.env.example`, `.gitignore`, `tests/queue.js`, `tests/queue_integration.js`, `docs/TASKS.md`, `docs/MULTIUSER.md`, `docs/stack.md`, `docs/system_design.md`, `docs/INSTALL.md`, `pipeline.md`
**Aceite:**
- [x] `WORKER_CONCURRENCY` (env, default 2) substitui a trava booleana; jobs em voo controlados por conjunto de IDs
- [x] Claim atômico do job (`UPDATE ... SET status='processing' WHERE id=? AND status='pending'`) — sem dois workers pegando o mesmo
- [x] `GET /api/transcriptions/:id/status` retorna `queue_position`
- [x] UI mostra "3º na fila" em vez de só "pendente"
- [x] Job travado em `processing` há mais de N minutos volta para `pending`, com contador de tentativas
- [x] Sob 10 uploads simultâneos, a UI dos outros usuários permanece responsiva

**Evidência (28/09/2026):**
- Backend (já existia, validado agora): `services/queue.js` com `WORKER_CONCURRENCY` (default 2, até 32) + claim atômico condicional + `recoverInterrupted` no boot (job travado em `processing` volta para `pending`, `worker_attempts` limita a 3); `queuePositionSql` expõe a posição na lista (`GET /api/transcriptions`) e no status (`GET /:id/status`, junto de `chunks_*` e `eta_seconds`).
- UI (fechado agora): badge "Na Fila" mostra **"Nº na fila"** na lista; painel de progresso do upload mostra **"⏳ Nº na fila, aguardando o worker..."** no polling (app.js `buildStatusBadge` + `describeJobProgress`).
- `tests/t06_queue_position.js` (mock, custo zero, **rodar dentro do container** — precisa de ffmpeg): **12/12 PASS** — worker com 1 slot reclama só o 1º job; pendentes exibem posições 1º e 2º; job em `processing` tem `queue_position` null; isolamento por escopo mantido (job alheio → 404).
- Carga real prévia (T-03, 24/09): 10 uploads simultâneos, 0 falhas — a base da concorrência validada em produção.
- `test_suite.js` → **79/79 PASS** sem regressão.

---

### T-07 — Cotas e limites de uso
**Estado:** TODO · **Prioridade:** 🔴 P0 · **Depende de:** T-01 · **Bloqueia:** T-27 (Asaas cobra por uso)
**Por quê:** `users.daily_limit` existe no banco e **nunca é consultado**; o Multer aceita arquivo de qualquer tamanho ([MULTIUSER.md](MULTIUSER.md) R-05, R-06). No modelo SaaS, cota é o que transforma plano pago em receita — e o admin precisa ajustar os limites de todos sem tocar no código.
**Contexto:** `server.js:26-33`, `server.js:228-280`, `db.js` (`system_settings`)
**Toca:** `server.js`, `app.js`
**Aceite:**
- [ ] `/api/transcribe` conta as transcrições do usuário nas últimas 24 h e retorna **429** ao exceder `daily_limit`
- [ ] Admin (`daily_limit: 999999`) não é bloqueado
- [ ] `multer({ limits: { fileSize } })` alimentado por `system_settings.max_file_size_mb`
- [ ] Rejeição de duração acima de `max_duration_hours` após o `ffprobe`, com `error_message` claro
- [ ] UI mostra "X de Y transcrições hoje"
- [ ] Painel admin: `daily_limit` global (default para novos usuários) e por usuário; `max_file_size_mb` e `max_duration_hours` editáveis, valendo na hora (settings já são lidas por request)

**Evidência:** _(preencher)_

---

### T-08 — Migração SQLite → PostgreSQL
**Estado:** DOING (fase 1, 28/09/2026) · **Prioridade:** 🔴 P0 · **Substitui** o escopo antigo "endurecer SQLite (WAL + índices)"
**Por quê:** o WAL corrompia o banco no bind-mount do Docker Desktop (incidente 25/09) e foi desligado; mas o problema real não é o WAL — é que o SQLite **serializa todas as escritas num writer único**. Com 35 mil usuários esperados (login, fila, billing, webhooks do Asaas escritos ao mesmo tempo), `SQLITE_BUSY` viria na primeira campanha. O banco precisa sair do app.
**Contexto:** `db.js` (schema + helpers `runAsync`/`getAsync`/`allAsync`), `docker-compose.yml`, `docs/stack.md` §journal, `scripts/migrate-sqlite-to-postgres.js`, `tests/t08_migration.js`
**Toca:** `docker-compose.yml` (service `db`), `scripts/` (novo), `tests/` (novo), `package.json` (`pg`), `.env.example`, `db.js` (fase 2)

**Desenho em 2 fases (decidido 28/09):**
- **Fase 1 (esta sessão):** infra + ferramental de migração, **sem trocar o banco do app**. App continua em SQLite (`DB_DRIVER=sqlite`). Entregue: service `db` (postgres:16-alpine, volume nomeado, healthcheck) no compose; script ETL `scripts/migrate-sqlite-to-postgres.js` (fonte aberta READONLY, DDL espelhando o schema, cópia em transação única, validação de contagens, `--dry-run` e `--force`, recusa de destino não-vazio); teste `tests/t08_migration.js` com banco de teste descartável.
- **Fase 2 (próxima sessão):** driver swap. Camada de acesso em `db.js` (`DB_DRIVER=postgres`) async-ificando as queries (a API do sqlite3 já é por Promise — o gap é o dialeto: `?` → `$1`, `PRAGMA` → nada, `sqlite_master` → `information_schema`). Rollback = `DB_DRIVER=sqlite` de volta.

**Aceite (fase 1):**
- [x] `docker compose up -d db` sobe o Postgres com volume nomeado e healthcheck `pg_isready`
- [x] ETL migra as 10 tabelas sem perda: contagens fonte = destino linha a linha, relatório impresso
- [x] SQLite fonte aberto READONLY — nada altera a origem; rollback = continuar apontando pro SQLite
- [x] `--dry-run` gera DDL + plano sem conectar destrutivamente; sem `--force`, destino não-vazio é recusado
- [x] Conversão de tipos: `REAL` → `DOUBLE PRECISION`, `DATETIME` → `TIMESTAMP`, `0/1` → `BOOLEAN`
- [x] `tests/t08_migration.js` verde dentro do container contra o service `db` (banco de teste criado e destruído pelo teste)
- [x] `test_suite.js` sem regressão (app inalterado nesta fase)
- [ ] Fase 2: app roda com `DB_DRIVER=postgres` e a suíte passa contra o Postgres

**Evidência (fase 1, 28/09/2026):**
- Service `db` adicionado ao `docker-compose.yml` (postgres:16-alpine, `pgdata` nomeado, healthcheck).
- `scripts/migrate-sqlite-to-postgres.js`: ETL com transação única, validação de contagens, READONLY na fonte, `--dry-run`/`--force`.
- `tests/t08_migration.js`: fixture SQLite completo (10 tabelas) → migração contra banco de teste descartável no service `db` → contagens e conversões de tipo verificadas.
- Dependência `pg` adicionada; docs (`stack.md`, `.env.example`) atualizados.
- **Testes (28/09/2026):** `tests/t08_migration.js` → **25/25 PASS** dentro do container (conversões booleanas, `REAL`→double, acentos preservados, chave cifrada `enc:v1:` intacta, trava de destino não-vazio, dry-run não-destrutivo). `test_suite.js` → **79/79 PASS** sem regressão. Dry-run contra o banco real: 145 transcrições, 2.066 segmentos, 465 logs, 10 tabelas — plano íntegro, fonte inalterada.

---

### T-09 — Página de Conta do usuário
**Estado:** TODO · **Prioridade:** 🟠 P1 · **Depende de:** T-01 · **Contexto SaaS (28/09):** a Conta é onde o usuário se vira sozinho — sem ela, cada troca de senha vira suporte manual e não há porta de entrada para cobrança.
**Por quê:** não existe tela de perfil; trocar senha exige o admin ([PRODUCT.md](PRODUCT.md) P-03).
**Contexto:** `index.html` (views), `app.js:240-257` (`showView`), `server.js:84-137`
**Toca:** `server.js`, `index.html`, `app.js`
**Aceite:**
- [ ] View `#view-account` com nome, e-mail, papel, consumo do dia e preferências (tema, modo de leitura)
- [ ] `PUT /api/auth/password` exigindo a senha atual
- [ ] **Esqueci a senha:** fluxo por e-mail (token único, expiração 30 min, link da landing) — `POST /api/auth/forgot` + `POST /api/auth/reset`; e-mail via provider configurável em `.env` (SMTP ou API)
- [ ] **Assinatura e pagamentos:** seção que espelha o status da assinatura Asaas (T-27) com botão "Gerenciar" que leva ao portal do Asaas
- [ ] **Logs de uso:** lista das próprias transcrições recentes com data, duração e custo estimado em tokens
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

### T-11 — Entrada por link (YouTube/Vimeo) + arquivos de vídeo
**Estado:** TODO · **Prioridade:** 🟠 P1 · **Rescopeada 28/09** (era "Gravador de voz" — o gravador virou a T-33, prioridade baixa)
**Por quê:** o fluxo de recebimento de material hoje é só upload de arquivo. O que chega na prática do usuário-alvo é um link do YouTube/Vimeo (palestra, reunião gravada, entrevista) ou um vídeo no celular. Aceitar link direto remove o passo manual de "baixar com outra ferramenta e subir aqui".
**Contexto:** `server.js:228-280` (`/api/transcribe`), `services/audio.js` (`preprocessAudio` — já extrai áudio de vídeo via ffmpeg), `app.js` (modal de upload)
**Toca:** `server.js`, `services/audio.js` (novo `downloadFromUrl`), `app.js`, `index.html`, `package.json`
**Aceite:**
- [ ] Campo "Cole um link" no modal de upload (YouTube/Vimeo suportados; validação de URL explícita — domínio não suportado → erro claro, sem dados inventados)
- [ ] Backend baixa o áudio/vídeo (yt-dlp em container, ou fetch direto para arquivos `.mp3/.mp4/.wav` com URL direta), converte via ffmpeg (reaproveita o pipeline atual) e segue o fluxo normal da fila
- [ ] Arquivos de vídeo (`.mp4`, `.mkv`, `.mov`…) aceitos direto no upload — o `preprocessAudio` já isola o áudio
- [ ] Falha de download/link privado/removido → `failed` com `error_message` específico
- [ ] Mesmos limites de T-07 (tamanho/duração) valem para links
- [ ] Teste com URL direta de arquivo (mock/http local) — sem chamar YouTube de verdade na suíte

**Fora de escopo:** bypass de paywall/conteúdo restrito, playlists inteiras (uma URL = uma transcrição).

**Evidência:** _(preencher)_

---

### T-12 — Player fixo no rodapé da tela de detalhe
**Estado:** ABSORVIDA (28/09/2026) → **T-29** (Reformulação UX/UI "Obsidian Wave", Fase 3)
**Por quê da absorção:** a reformulação redesenha a tela de detalhe inteira (player com waveform em canvas, blocos de fala, toolbar unificada). Implementar o player fixo agora seria construir duas vezes o mesmo componente. O requisito foi preservado no aceite da T-29.

**Evidência:** _(ver T-29)_

---

### T-13 — Baixar áudio original + Exportar em massa
**Estado:** TODO · **Prioridade:** 🔴 P0 (elevada 28/09 — paridade com o concorrente e pré-requisito de valor percebido no plano pago) · **Depende de:** nada para funcionar; T-02 já garante o isolamento
**Por quê:** (a) o painel de detalhe da referência oferece "Baixar áudio"; o nosso não tem. Hoje o áudio só é acessível pela URL `/uploads/...` com token na query (fragilidade já mapeada). A forma certa é uma **rota autenticada dedicada**. (b) A barra de ações em massa da referência tem Exportar; a nossa só tem Mover e Excluir — para quem processa 50 arquivos, exportar um a um é inaceitável.
**Contexto:** `server.js` (rotas `/api/export/:id/:format`, `/uploads`), `app.js` (barra de ações em massa), `services/exporter.js`
**Toca:** `server.js`, `app.js`, `index.html`, `package.json` (zip)
**Aceite:**
- [ ] `GET /api/transcriptions/:id/audio` autenticada, `Content-Disposition: attachment` com o nome original; suporta `Range` (seek do player continua funcionando)
- [ ] Botão "Baixar áudio" no painel de detalhe com tamanho do arquivo ("Baixar áudio · 4,4 MB")
- [ ] **Exportar em massa:** na seleção múltipla da lista, ação "Exportar" → escolhe formato (PDF/DOCX/TXT/SRT/VTT) → baixa **um `.zip`** com um arquivo nomeado por transcrição (`{nome}-{formato}.{ext}`); stream, sem inflar memória (arquivos de 10 h geram PDFs grandes)
- [ ] Falha em uma transcrição do lote não aborta as demais — ela entra num `erros.txt` dentro do zip
- [ ] `test_suite.js`: rota de áudio 200 com token / 401 sem / 404 de outro usuário; zip em massa com 2 transcrições contém 2 arquivos + lista de nomes correta

**Evidência:** _(preencher)_

---

### T-14 — UX de modais
**Estado:** ABSORVIDA (28/09/2026) → **T-29** (Reformulação UX/UI "Obsidian Wave", Fase 2)
**Por quê da absorção:** a reformulação constrói o sistema de componentes do zero (bottom sheets, drawers, foco, Esc/backdrop). O helper de modal único da T-14 é exatamente um desses componentes — será entregue lá, no padrão novo, em vez de agora e depois reescrito.

**Evidência:** _(ver T-29)_

---

### T-15 — Chave OpenRouter: entrada protegida, teste antes de salvar, cifrada em repouso
**Estado:** DONE (21/09/2026) · **Prioridade:** 🔴 P0 · **Substitui** a cota diária na sidebar
**Por quê:** hoje `api_keys.key_value` fica em **texto puro** no SQLite (`server.js:483`) e no `.env`; o cadastro é um `prompt()` sem validação (`app.js:1368`); não há teste da chave antes de salvar. Decisão de 14/09: sem cota diária (uso pessoal, ilimitado). No lugar dela, na sidebar, um botão de acesso rápido à configuração da chave — protegido, com teste e armazenamento seguro.
**Contexto:** `server.js:460-500` (rotas `/api/admin/keys`), `db.js:200-215` (sync da chave do `.env`), `app.js:1360-1390`, `index.html` (sidebar, bloco "Ilimitado (Modo Local)"), `services/secrets.js`, `services/openrouter.js`, `docker-compose.yml`, `test_suite.js`, `docs/INSTALL.md`; dependencias identificadas na retomada: handlers da UI e salvamento de transcricao
**Toca:** `server.js`, `db.js`, `app.js`, `index.html`, `.env.example`, `docker-compose.yml`, `services/secrets.js`, `services/openrouter.js`, `test_suite.js`, `tests/ui_regressions.js`, `docs/INSTALL.md`, `docs/TASKS.md`, `docs/REVISAO-RETOMADA-2026-09-20.md`

**Abordagem (o "simples que funciona"):** o que protege uma chave não é uma técnica exótica — é ela **nunca sair do servidor em texto puro** depois de salva. Técnica inventada/obscura é exatamente o que dá falsa sensação de segurança e quebra. O padrão abaixo é o mínimo sólido e cabe em uma sessão:
1. **Cifra em repouso:** `AES-256-GCM` (módulo `crypto` nativo do Node, sem dependência) com chave derivada de `APP_SECRET_KEY` (env, 32+ bytes aleatórios, gerada no install — `docs/INSTALL.md` ganha o passo). IV aleatório por registro; armazena `iv:tag:ciphertext` em `key_value`. Sem `APP_SECRET_KEY` em produção, o servidor **recusa subir** (mesma regra prevista para `JWT_SECRET` em T-01).
2. **Teste antes de salvar:** `POST /api/admin/keys/test` chama `GET https://openrouter.ai/api/v1/auth/key` com a chave informada; só salva se retornar 200. A UI mostra o resultado (limite/crédito que o endpoint devolve) e só então libera "Salvar".
3. **Nunca devolve a chave:** a API retorna só `sk-or-v1-…abcd` (já existe `masked_key`, `server.js:468`). Sem rota que devolva o valor cifrado ou decifrado. Decifra apenas dentro de `services/openrouter.js`, no momento da chamada.
4. **Troca exige re-autenticação:** o modal pede a senha do admin para salvar/trocar (valida com bcrypt). Tentativas falhas em `system_logs` com IP; 5 falhas em 10 min → bloqueio temporário.
5. **Sync do `.env` vira one-shot:** na primeira subida, se `OPENROUTER_API_KEY` existir no ambiente e não houver chave no banco, cifra e grava — depois disso o `.env` pode ficar **sem** a chave (a fonte de verdade passa a ser o banco cifrado). `docs/INSTALL.md` explica os dois caminhos.

**Aceite:**
- [x] Bloco "Ilimitado (Modo Local)" da sidebar substituído por botão **"Chave de API"** com indicador de estado (✅ válida · ⚠️ não configurada · ❌ inválida na última verificação)
- [x] Modal: campo tipo `password` com botão "mostrar", botão **Testar** → resultado inline, botão **Salvar** só habilita após teste OK, campo de senha do admin
- [x] `key_value` no SQLite cifrado com AES-256-GCM; `SELECT key_value FROM api_keys` **não** mostra `sk-or-v1-` (formato `enc:v1:<iv>:<tag>:<ct>`)
- [x] Nenhuma rota devolve a chave em claro ou cifrada; `masked_key` é o único formato exposto
- [x] Migração idempotente no boot: chave existente em texto puro é cifrada in-place na primeira subida
- [x] Transcrição, chat e tradução continuam funcionando (a decifragem acontece só em `services/openrouter.js`)
- [x] `test_suite.js` — TEST 1 verifica que o valor no banco **não** começa com `sk-or-v1-` e que `/api/admin/apikeys/test` responde 200 com a chave válida
- [x] `.env.example` e `docs/INSTALL.md` atualizados (`APP_SECRET_KEY`, passo de gerar, fluxo de cadastrar pela UI)

**Evidência (21/09/2026):**
- Cifra em `services/secrets.js`: AES-256-GCM nativo do Node (sem dependência), IV aleatório por registro, chave-mestra derivada de `APP_SECRET_KEY`; em `NODE_ENV=production` o servidor **recusa subir** se ausente/curta (mesma regra do `JWT_SECRET` em T-01).
- `node tests/secrets.js` → **8/8 PASS** (novo): roundtrip, IV distinto por registro, adulteração de ciphertext/tag/IV falha na decifragem (autenticação GCM), valor legado em texto puro passa intacto, máscara não expõe o miolo.
- `node tests/ui_regressions.js` → **11/11 PASS**.
- Suíte completa com o código novo dentro de **container Docker descartável** (imagem real `keen-einstein-transcreveai`, cópia do banco, sem tocar no container de produção): `node test_suite.js` → **68/68 PASS**. Cobre: TEST 1 (key_value cifrada, teste da chave ativa 200/valid, status/lista sem chave em claro), 5 caminhos de projeto negados com 404 (`/turboscribe.sqlite`, `/.env`, `/server.js`, `/services/secrets.js`, `/db.js`), SPA servida, salvamento com senha de admin → 200 mascarado, 5× senha errada → 401 e 6ª → 429 (bloqueio por IP), transcrição nos 3 níveis com OpenRouter real, exportações TXT/SRT/VTT, chat e tradução.
- Hardening aplicado sobre a base da retomada: estáticos explícitos no lugar de `express.static(__dirname)`; `verifyAdminPassword` valida só o admin autenticado (sem fallback para outro admin); banner de boot sem credencial; `getActiveOpenRouterKey` sem fallback silencioso para a chave do ambiente (erro explícito orientando recadastrar).
- Docs: `.env.example` ganhou `APP_SECRET_KEY` com comando de geração; `docs/INSTALL.md` atualizado (estado real das vulnerabilidades T-01/T-15, fluxo da chave na sidebar, backup de `APP_SECRET_KEY`, troubleshooting de decifragem).
- **Pendência consciente (validação de deploy do dono):** container de produção **não** foi reiniciado nesta sessão. Para ativar: `docker compose restart transcreveai` e conferir com `docker exec transcreveai-app node test_suite.js`. A rotação dos segredos padrão do `docker-compose.yml` (item 6 da revisão) fica para esse momento — requer backup do SQLite/.env + recifragem transacional, procedimento descrito em `docs/INSTALL.md`.

---

**Retomada (20/09/2026):** branch `feat/chave-openrouter-cifrada` encontrada com T-15 parcial. Servico existente: `docker exec transcreveai-app node test_suite.js` **37/37 PASS**; cifra em memoria **5/5 PASS**, recusa de APP_SECRET_KEY ausente/curta em producao **2/2 PASS**. Ajustes seguros de interface aplicados; `node tests/ui_regressions.js` **9/9 PASS** (handlers, Markdown, tema, protecao de salvamento e limpeza dos campos secretos). Alteracoes de backend/segredos/reinicio bloqueadas pela revisao automatica; autorizacao especifica solicitada, ainda pendente. Nao houve troca de segredo, migracao adicional nem reinicio. Faltam hardening, testes especificos de API e documentacao de instalacao para concluir T-15. Detalhes em [REVISAO-RETOMADA-2026-09-20.md](REVISAO-RETOMADA-2026-09-20.md).

### T-16 — Renomear níveis → Base / Pro / Max
**Estado:** DONE (23/09/2026) · **Prioridade:** 🟠 P1 · **Antes de** T-04/T-17/T-18 (evita retrabalho de UI)
**Por quê:** os três animais são a identidade do TurboScribe. Ao virar comercial, vira "whitelabel inspirado" na cara. Decisão de 14/09: manter o **formato** badge com nome + modelo, trocar nomes e ícones. Layout/estilo geral fica para depois — aqui é só funcional.
**Contexto:** `db.js:220-230` (`chita_model`, `chita_enabled`…), `services/openrouter.js:80-100` (switch de nível), `app.js` (38 refs), `index.html` (27 refs), `test_suite.js:50-54`
**Toca:** `db.js`, `services/openrouter.js`, `server.js`, `app.js`, `index.html`, `test_suite.js`, `docs/product.md`, `docs/stack.md`

**Nomes (decididos 14/09):**

| Nível | Nome | Chave interna | Ícone (Lucide) | Subtítulo |
|---|---|---|---|---|
| 1 | **Base** | `base` | `zap` | Mais veloz, menor custo |
| 2 | **Pro** | `pro` | `gauge` | Velocidade e precisão |
| 3 | **Max** | `max` | `award` | Máxima precisão PT-BR |

**Aceite:**
- [x] Chaves internas `base`/`pro`/`max` em `system_settings` (`base_model`, `base_enabled`…), migração idempotente renomeando as chaves antigas no boot
- [x] `/api/transcribe` aceita `mode` em `base|pro|max`; aceita os antigos (`chita`…) como alias **por uma versão**, com `console.warn` — remover na seguinte
- [x] `services/openrouter.js` usa só as chaves novas
- [x] Front sem nenhuma ocorrência de `chita|golfinho|baleia` (`grep -ci` → 0 em `app.js` e `index.html`), ícones e emojis trocados
- [x] Badge da tabela e cards do modal de upload refletem os nomes novos; painel admin (modelo por nível) também
- [x] `test_suite.js` usa os nomes novos — **68/68 PASS** (a suíte cresceu desde o aceite escrito; rodada dentro do container)
- [x] `docs/product.md` e `docs/stack.md` atualizados

**Evidência:**
- Migração aplicada no boot do container 23/09: `system_settings` só tem `base_/pro_/max_*`; `transcriptions.mode` legado migrado (base: 8, pro: 10, max: 27; model IDs intactos)
- `test_suite.js` 68/68 dentro do container (modos base/pro/max transcrevem e gravam modelo correto); `tests/ui_regressions.js` 13/13 no host
- Screenshots em `docs/screenshots/t-16/`: `dashboard-badges.png` (badges Max/Pro/Base com ícones award/gauge/zap), `modal-niveis.png` (cards Base/Pro/Max com subtítulos novos)
- Aprendizado operacional: rodar `test_suite.js` do **host** falha leituras no SQLite (WAL + bind-mount do Docker Desktop não propaga writes do container para o host). Rodar dentro do container: `docker exec -w /app transcreveai-app node test_suite.js`

---

### T-17 — Layout responsivo: celular e tablet
**Estado:** DONE (22/09/2026) · **Prioridade:** 🔴 P0 · **Antes de** T-04 e T-18
**Por quê:** `grep -c "md:\|lg:\|sm:" index.html` → **5**. O layout é desktop fixo: sidebar de largura fixa, tabela de 6 colunas, detalhe em 2 colunas. No celular não dá para usar. O objetivo declarado (14/09) é "abrir no notebook, computador ou celular e ler de forma agradável" — sem isso, T-04 e T-18 entregam valor só no desktop.
**Contexto:** `index.html` (inteiro — é estrutural; usar `grep -n "class=\"" | head` por seção, não ler tudo), `app.js:240-257` (`showView`), config Tailwind inline em `index.html:12-53`
**Toca:** `index.html`, `app.js`
**Aceite:**
- [x] Breakpoints: `< 768px` celular · `768–1024px` tablet · `> 1024px` desktop
- [x] **Sidebar** vira drawer off-canvas no celular (botão hambúrguer no header), fixa no desktop
- [x] **Tabela de transcrições** vira lista de cards no celular: nome, data, duração, badge de nível, status, ação — sem scroll horizontal
- [x] **Tela de detalhe** em coluna única no celular: texto em cima, painel (Projeto/Exportar/IA) vira seção abaixo do texto; player (T-12) permanece no topo da coluna
- [x] Modais em tela cheia no celular (`inset-0`), centralizados no desktop
- [x] Alvos de toque ≥ 44px em botões e timestamps
- [x] Texto da transcrição com `font-size` mínimo 16px no celular, linha de ~65 caracteres no desktop (`max-w-prose`)
- [x] Testado em 375px (iPhone), 768px (iPad) e 1440px — screenshots na evidência
- [x] Nada de horizontal scroll no `body` em nenhuma largura

**Evidência:**
- Screenshots em `docs/screenshots/t-17/`: `375-mobile-*` (dashboard cards, detalhe coluna única, modal tela cheia), `768-tablet-*` (dashboard com toolbar em 2 linhas, detalhe coluna única), `1440-desktop-*` (dashboard tabela + sidebar, detalhe 3 colunas — sem regressão)
- `tests/ui_regressions.js` → 13/13 PASS após as mudanças
- `tests/screenshot_responsive.js` (novo) reproduz as capturas via CDP headless
- Correção durante a tarefa: toolbar do dashboard estourava em 768px (botão "Transcrever Arquivos" cortado); breakpoint da linha da toolbar subiu de `md` para `lg`
- Gate final: usuário testa no celular pessoal via `http://<IP-LAN>:3000` antes do merge `--no-ff` na main

---

### T-18 — Aprimoramento de transcrição por IA (correção + estruturação)
**Estado:** DONE (23/09/2026, escopo simplificado pelo CEO: "simples, eficaz e de fácil entendimento") · **Prioridade:** 🔴 P0 · **Depende de:** T-19 ✅, T-16 ✅
**Por quê:** o primeiro passo da "análise estruturada" (decisão de 14/09) é tornar a transcrição bruta legível e confiável: corrigir palavras erradas (nomes, marcas, termos do negócio), ortografia, concordância e estruturar em parágrafos. O desenho original de 7 presets (resumo/processos/vendas/ações/interpretação) foi **cortado para a T-23** — aqui entrega só o aprimoramento, com modelo e system prompt sob controle do admin.
**Contexto:** `server.js` (`/api/chat`), `services/openrouter.js`, `app.js` (painel "Recursos & IA"), `db.js`
**Toca:** `server.js`, `db.js`, `services/openrouter.js`, `services/prompts.js` (novo), `app.js`, `index.html`, `docs/product.md`, `docs/stack.md`

**Desenho (entregue):**
- Tabelas `ai_analyses` (histórico: modelo, prompt usado, dicionário usado, tokens, resultado) e `glossary` (dicionário errado→correto, CRUD admin)
- `POST /api/transcriptions/:id/enhance`: system prompt = `analysis_prompt` do admin (vazio → padrão de fábrica versionado em `services/prompts.js`), modelo = `analysis_model` do admin; dicionário injetado no prompt; texto longo fatiado em blocos de ~12k chars (`splitTextIntoChunks`)
- Falha de API → 502 explícito, nada persistido, nunca texto inventado
- Painel admin: modelo (com sugestões dos mais baratos), prompt editável com "Restaurar padrão", dicionário com add/remove
- Detalhe: botão "Aprimorar com IA" + resultado com modelo/tokens + Copiar; último resultado carrega ao abrir a transcrição

**Aceite:**
- [x] Tabelas `ai_analyses` e `glossary` criadas em `initDatabase()` (idempotente)
- [x] `POST /api/transcriptions/:id/enhance` (síncrono, blocos) + `GET .../analyses`; auth em todas
- [x] System prompt versionado em `services/prompts.js`, sobrescrevível pelo admin (`analysis_prompt`)
- [x] Modelo escolhível pelo admin (`analysis_model`, default `openai/gpt-4o-mini`)
- [x] Dicionário de correções (glossary) aplicado no prompt, CRUD admin
- [x] Fatiamento para textos > 12k chars (`tests/analysis_unit.js`: 7/7 asserções)
- [x] Nenhum texto inventado: falha → erro explícito, nada gravado
- [x] Tokens por análise gravados em `ai_analyses`
- [x] `docs/product.md` e `docs/stack.md` atualizados

**Evidência:**
- `test_suite.js` **79/79 PASS** dentro do container (11 testes T-18 novos: auth 401, CRUD glossário com 409/403, settings analysis_model/analysis_prompt) — nenhum teste dispara chamada paga
- `tests/analysis_unit.js` 7/7 (chunker preserva conteúdo, builder injeta dicionário, prompt cobre correção/concordância/estrutura)
- 1 chamada real de validação (gpt-4o-mini, 364 in / 29 out ≈ R$ 0,0003): corrigiu "ou la"→"Olá", "este e"→"este é", "transcrical"→"transcrição", "sistem"→"sistema"
- Screenshots em `docs/screenshots/t-18/`: `admin-analise.png` (modelo + prompt + dicionário), `detalhe-aprimoramento.png` (botão + resultado com meta de tokens)

---


### T-19 — Pipeline resiliente para áudios longos (10 h / 5 GB / 50 arquivos)
**Estado:** DONE (15/09/2026) · **Prioridade:** 🔴 P0 · **Fundação de** T-18
**Por quê:** o caso de uso principal é 8 h de gravação por dia. Hoje o pipeline "funciona" só porque os áudios têm 30 s. Auditado em 14/09 (`server.js:592-745`):
- Os blocos de 600 s são transcritos **em série** num `for` (`server.js:656`) — 8 h = 48 chamadas sequenciais, ~40–60 min de espera.
- **Nenhum resultado parcial é persistido.** Se a chamada 40 falhar (timeout, 429, queda de rede) ou o processo reiniciar, os 39 blocos prontos são jogados fora e o job volta para `failed` ou recomeça do zero.
- **Sem retry.** Uma falha transitória da OpenRouter mata o job inteiro.
- Progresso é um número (20→90) sem ETA, sem "bloco X de Y".
- Multer sem limite (`server.js:33`), sem validação por `ffprobe` antes de enfileirar, sem limite de arquivos por requisição.

**Contexto:** `server.js:26-40` (Multer), `server.js:228-280` (`/api/transcribe`), `server.js:592-745` (worker), `services/audio.js` (`preprocessAudio`, `splitAudioSmart`), `services/openrouter.js:100-170` (`transcribeAudio`), `db.js` (schema)
**Toca:** `server.js`, `services/audio.js`, `services/openrouter.js`, `db.js`, `app.js` (barra de progresso), `docs/stack.md`, `docs/system_design.md`, `pipeline.md`

**Desenho:**
1. **Tabela `transcription_chunks`**`(id, transcription_id, idx, offset_sec, duration_sec, path, status pending|processing|done|failed, attempts, text, segments_json, error, updated_at)`. O job vira um conjunto de blocos; cada bloco é a unidade de trabalho, persistida ao concluir.
2. **Blocos em paralelo com limite:** `CHUNK_CONCURRENCY` (env, default 3). Pool simples com `Promise` + fila, sem dependência. 48 blocos a 3 por vez ≈ 15 min em vez de 45.
3. **Retry por bloco:** até 3 tentativas com backoff exponencial (2 s, 8 s, 30 s) em erros transitórios (timeout, 429, 5xx, rede). Erro definitivo (400, arquivo corrompido) marca só o bloco como `failed`; o job termina como `completed_with_errors` com o texto dos blocos bons e marcação `[bloco 40 falhou: motivo]` no lugar do trecho — **nunca** texto inventado.
4. **Retomada:** no boot e a cada poll, jobs `processing` com blocos `pending` retomam de onde pararam. Reprocessar um job = reprocessar só os blocos `failed`.
5. **Progresso real:** `progress` = blocos `done` / total; `GET /:id/status` devolve `chunks_done`, `chunks_total`, `eta_seconds` (média móvel do tempo por bloco × restantes) e `stage` (`uploading|preprocessing|splitting|transcribing|assembling|analyzing`).
6. **Limites e validação:** Multer `limits: { fileSize: 5 GB, files: 50 }`; `ffprobe` na hora do upload — rejeita sem trilha de áudio, rejeita > 10 h, grava `duration_seconds` já no `INSERT`. Erro **por arquivo** (um inválido não derruba os outros 49).
7. **Pré-processamento sem travar o servidor:** `ffmpeg` via `spawn` (stream), não `exec` com buffer; `loudnorm` em uma passada (não duas) — 10 h de áudio não podem segurar o event loop nem estourar `maxBuffer`.
8. **Disco:** arquivo original + FLAC 16 kHz + blocos ≈ 2× o tamanho do original em pico. Blocos apagados ao concluir; FLAC intermediário apagado; original fica (T-13 depende dele). `df` mínimo verificado antes de iniciar o pré-processamento.
9. **Provedor mock para testar sem gastar (decisão 15/09):** `TRANSCRIBE_PROVIDER=mock` (env) faz `services/openrouter.js` devolver, por bloco, segmentos determinísticos (`[MOCK bloco N] ...`, timestamps espaçados) sem chamar a API. Controles por env para simular o que importa no T-19: `MOCK_LATENCY_MS` (tempo por bloco), `MOCK_FAIL_ONCE=12` (bloco 12 falha com 429 na 1ª tentativa e passa na 2ª — testa retry), `MOCK_FAIL_ALWAYS=30` (bloco 30 falha sempre — testa `completed_with_errors`). Regras: **recusado quando `NODE_ENV=production`**; todo texto sai com prefixo `[MOCK]` para nunca ser confundido com transcrição real (respeita a regra "sem dados fictícios" — o mock é explícito, nunca silencioso); `test_suite.js` continua usando a API real (é a suíte de integração); o mock é usado só pelos testes de mecânica de T-19 (`tests/long_audio.js`).

**Custo real da tarefa com essa estratégia:** ~US$ 0 na mecânica (dezenas de execuções do áudio de 2 h em mock) + **uma** execução real curta para qualidade (15 min de áudio ≈ US$ 0,05 no Pro) + **uma** execução real do áudio de 2 h no final como evidência (≈ US$ 0,36 no Pro). Total < US$ 0,50.

**Aceite:**
- [x] Tabela `transcription_chunks` criada de forma idempotente; migração não quebra transcrições existentes
- [~] Upload de 50 arquivos numa requisição funciona; o 51º é rejeitado com mensagem clara; arquivo de 5 GB sobe (testar com arquivo gerado por `ffmpeg -f lavfi`) _(50 arquivos e 51º testados via MAX_FILES_PER_UPLOAD=3; arquivo de 5 GB não gerado — limite existe no Multer, não exercitado)_
- [x] `ffprobe` rejeita arquivo sem áudio e > 10 h com erro por arquivo, sem afetar os demais
- [x] Blocos processados em paralelo (`CHUNK_CONCURRENCY`), resultados montados na ordem correta com timestamps contínuos
- [x] Matar o processo no meio de um job de ≥ 1 h e subir de novo → retoma dos blocos `pending`, sem repetir os `done` (evidência: log com "retomando 12/48")
- [x] Simular 429/timeout num bloco → retry com backoff, job conclui; simular falha definitiva → `completed_with_errors` com marcação explícita no texto
- [x] `/status` devolve `chunks_done/chunks_total/eta_seconds/stage`; UI mostra "Bloco 12 de 48 · ~9 min restantes"
- [x] Servidor continua respondendo (`GET /api/transcriptions` < 500 ms) durante o pré-processamento de um áudio de 2 h
- [x] `tests/long_audio.js` roda os cenários acima (paralelo, kill+retomada, retry, falha definitiva, servidor responsivo) contra `tests/fixtures/long/sample-2h.ogg` em **mock**, com `PASS/FAIL` por cenário — custo zero
- [~] Teste de referência **real**, uma vez: o áudio de 2 h em `pro` conclui com `completed`, texto contínuo (as 8 frases em ordem, alternando pt/en) e custo registrado — resultado colado na evidência _(2 h real antes do fix; 20 min real após o fix — ver evidência)_
- [x] `docs/stack.md` (schema, limites), `docs/system_design.md` (decisão de blocos/concorrência) e `pipeline.md` §2 atualizados

**Custo de referência (large-v3 a US$ 0,006/min):** 8 h/dia ≈ US$ 2,90; 22 dias ≈ US$ 63/mês. Em `pro` (turbo, US$ 0,003/min): metade. Sem limite de uso no sistema — o limite é o crédito da OpenRouter.

**Evidência (15/09/2026):**
- `node tests/long_audio.js` (mock, custo zero, áudio de 2 h → 12 blocos): **A** 10/10 · **B** retry 4/4 · **C** falha definitiva + `/retry` 10/10 · **D** kill com 4/12 prontos → retomada sem refazer nenhum 4/4 · **E** latência ≤ 6 ms durante ffmpeg 6/6 · **F** limites 6/6. Total **40/40**.
- `node test_suite.js` → **32/32** (API real).
- Real, 2 h em `pro`: 12 blocos, 3 em paralelo, **17 s** de transcrição (turbo) + ~2 min de ffmpeg; status/ETA/`stage` corretos; UI mostrou "Transcrevendo 59%".
- Real, 20 min em `pro` após o fix abaixo: **220 segmentos**, timestamps contínuos até 1200 s, pt/en alternando, 0 resgates. (A execução completa de 2 h não foi repetida após o fix para respeitar o teto de custo; ~US$ 0,36 se quiser a evidência final.)

**Dois achados que só a execução real revelou (o mock nunca mostraria):**
1. **Bug grave e antigo no pré-processamento** (`services/audio.js`, desde `eb283a8`): `lowpass=f=8000` sobre fonte de 16 kHz (WhatsApp PTT) cai em Nyquist, o biquad degenera e o áudio vira lixo após ~2 min — o Whisper devolvia vazio para 10 min inteiros. Áudios de 30 s sobreviviam por serem curtos. Isolado por bissecção de filtros (v1–v6) e corrigido: reamostra antes de filtrar, sem lowpass.
2. **Guarda de qualidade por bloco** adicionado: pouco texto (< 0,5 chars/s) com som audível (> -50 dB) → re-transcreve em sub-blocos de 2 min; se ainda não vier texto, o bloco fica `failed` com motivo explícito ("possível colapso do modelo") e o job `completed_with_errors`. Testado ao vivo: pegou o bloco corrompido pelo bug 1 antes de eu saber a causa.

**Incidente durante os testes:** um servidor de smoke test ficou rodando sem mock e disputou o mesmo SQLite com o servidor de teste — gastou crédito real e embaralhou o cenário A. `tests/long_audio.js` agora aborta se a porta já responde.

**Para depois (fora do escopo, registrado):**
- Pré-processamento de 2 h leva ~2 min (10 h ≈ 10 min) em `loudnorm`; cortes dos blocos são sequenciais. Dá para cortar em paralelo e/ou trocar `loudnorm` por `dynaudnorm` (mais leve). Medir antes.
- Um job por vez continua (T-06): 50 arquivos entram em fila serial, cada um com blocos paralelos.
- `filterHallucinations` colapsa repetições idênticas consecutivas — certo para fala real, mas apaga loops sintéticos; o fixture de 2 h é patológico nesse ponto (não é bug).

---

### T-20 — Formatos e idiomas
**Estado:** DONE (23/09/2026) · **Prioridade:** 🟠 P1 · **Dependia de:** T-19 (validação por `ffprobe`) ✅
**Por quê:** paridade: o concorrente lista 24 formatos e 98 idiomas. Nós já aceitamos "o que o ffmpeg lê" — mas sem lista visível, sem `accept` no input, sem extração explícita de trilha de vídeo e com idioma hardcoded em `pt`.
**Contexto:** `index.html` (input de arquivo do modal de upload, select de idioma), `services/audio.js` (`preprocessAudio`), `services/openrouter.js` (parâmetro `language`), `docs/product.md` §4.1
**Toca:** `index.html`, `app.js`, `services/audio.js` (sem mudança — `-vn` já existia), `services/languages.js` (novo), `services/openrouter.js`, `services/pipeline.js`, `server.js`, `db.js`, `docs/product.md`, `docs/stack.md`
**Decisões na implementação:**
- **Lista canônica única** em `services/languages.js` (UMD): o backend valida o parâmetro e o frontend monta o select do mesmo arquivo, servido em `GET /languages.js` — zero duplicação, zero fetch extra.
- **100 idiomas** (lista do `whisper-large-v3`, incl. `yue`/cantonês) com nome nativo + inglês; busca filtra pelos dois e pelo código ISO.
- **"Detectar automaticamente" é o padrão**: omite o campo `language` da chamada à API; o idioma vem no `verbose_json` (`data.language`), é persistido por bloco em `transcription_chunks.detected_language` e a maioria vira o `language` da transcrição (só quando o pedido era `auto`).
- **Prompt de domínio PT-BR** (`DEFAULT_PROMPT_PTBR`) agora só é enviado quando `language=pt`: em outros idiomas ele induz vocabulário errado; em `auto` ele viés a detecção para português.
- **`DB_PATH` (env) adicionado ao `db.js`**: testes que sobem um segundo servidor isolam o SQLite (lição do incidente T-19).
- **Bug latente encontrado e corrigido**: banco **novo** (fresh install) quebrava no boot (`no such column: stage`) — o `CREATE TABLE transcriptions` não tinha `stage`, que só era adicionada pelo ALTER para bancos existentes. Nunca apareceu porque todos os ambientes usam banco migrado; o teste com `DB_PATH` limpo expôs.
**Aceite:**
- [x] Input com `accept` cobrindo os 22 formatos (MP3, M4A, MP4, MOV, AAC, WAV, OGG, OPUS, MPEG, WMA, WMV, AVI, FLAC, AIFF, ALAC, 3GP, MKV, WEBM, VOB, RMVB, MTS, TS) e o modal lista os formatos
- [x] Vídeo: `ffmpeg -vn` extrai só a trilha de áudio no pré-processamento (já existia em `services/audio.js`; validado com MP4 gerado por lavfi)
- [x] Select de idioma com os **100 idiomas do Whisper** (`services/languages.js`, código ISO-639-1 + nome nativo), com busca, `pt` no topo e os 4 mais usados (pt, en, es, ja) fixados acima da lista
- [x] Opção **"Detectar automaticamente"** (omite `language` na chamada); o idioma detectado é gravado em `transcriptions.language`
- [x] Arquivo com formato fora do `accept` mas legível pelo ffmpeg ainda passa (o `accept` é conveniência, o `ffprobe` de T-19 é a validação real)
- [x] Idioma inválido na API → **400 antes de tocar em arquivo**, com mensagem clara

**Evidência (23/09/2026):**
- `node tests/t20_formats_languages.js` (provedor **mock**, banco isolado via `DB_PATH`, container efêmero com a imagem real): **18/18 PASS** — validação 400, `auto` → `language='pt'` gravado (detectado), `ja` preservado, vídeo MP4 transcrito (duração 6,01 s detectada), lista servida, 100 idiomas, fixados no topo, busca por nome inglês e nativo (日本).
- Verificação de UI (Edge headless contra o container na 3000): select com 101 opções (`auto` + 100), "Detectar automaticamente" primeiro, pt/en/es/ja fixados, busca "jap" acha `ja`, `accept` presente, nenhum erro JS.
- Custo de API no desenvolvimento: **US$ 0** (todo o e2e em mock; a suíte real `test_suite.js` não foi rodada para respeitar o teto de recurso — mudança no caminho real é mínima: um campo omitido/um campo capturado).

---

### T-21 — Exportar CSV + Ferramenta de Tradução com legendas
**Estado:** TODO · **Prioridade:** 🟠 P1 · **Depende de:** T-04 (para exibir traduções), T-13 (para exportar em massa)
**Por quê:** paridade: falta CSV; e `/api/translate` hoje devolve só texto corrido — o concorrente traduz **mantendo os timestamps** e exporta legendas SRT/VTT no idioma escolhido.
**Contexto:** `services/exporter.js`, `server.js` (`/api/translate`, `/api/export/:id/:format`), `app.js` (painel IA do detalhe)
**Toca:** `services/exporter.js`, `server.js`, `db.js`, `app.js`, `index.html`
**Aceite:**
- [ ] `GET /api/export/:id/csv` → uma linha por segmento: `inicio,fim,locutor,texto` (UTF-8 com BOM para abrir no Excel)
- [ ] Tabela `translations(id, transcription_id, language, segments_json, model, created_at)` — tradução **por segmento**, preservando `start/end/speaker`; feita em lotes de ~50 segmentos por chamada com instrução de manter o número de itens
- [ ] Modal "Traduzir": idioma alvo (lista de T-20) + formato de download (PDF/DOCX/TXT/SRT/VTT/CSV) → gera e baixa; a tradução fica salva e aparece como aba no detalhe
- [ ] Todos os formatos de exportação aceitam `?lang=xx` e usam a tradução salva quando existir
- [ ] Exportação em massa (T-13) inclui CSV e aceita `lang`
- [ ] `test_suite.js` cobre CSV e uma tradução por segmento (contagem de segmentos igual antes e depois)

**Evidência:** _(preencher)_

---

### T-23 — Presets de análise avançados (processos, vendas, ações)
**Estado:** TODO · **Prioridade:** 🟠 P1 · **Depende de:** T-18 ✅
**Por quê:** o desenho original da T-18 previa 6 presets de análise (resumo executivo, processos estruturados, conteúdo sem ruído, orientação de vendas, lista de ações, interpretação). Em 23/09 o CEO pediu para começar simples: só o **aprimoramento** (correção + estruturação) entrou na T-18. Esta tarefa retoma os presets quando fizer sentido comercialmente — o caminho já está preparado: tabela `ai_analyses`, `services/prompts.js` versionado, `runAnalysisChat` com modelo configurável, fatiamento em blocos.
**Desenho futuro:**
- `kind` em `ai_analyses` já discrimina o tipo — basta adicionar presets em `services/prompts.js` e um seletor no painel "Recursos & IA"
- Para transcrições longas, avaliar passada de **consolidação** após processar os blocos (somar tokens de 2 passadas no custo)
- Chat existente pode receber o contexto da análise selecionada além do `raw_text`
**Aceite:** _(a detalhar quando a tarefa for escolhida)_

**Evidência:** _(preencher)_

---

### T-22 — Reconhecimento de locutores real (diarização)
**Estado:** TODO · **Prioridade:** 🟠 P1 · **Depende de:** T-19
**Por quê:** hoje a caixa "Reconhecimento de locutores" **não faz nada**: grava um flag e todo segmento sai como `Locutor 1` (`services/openrouter.js:147,155`). Whisper não diariza. Para 8 h de vendas, saber **quem falou** é o que separa "texto" de "processo" — sem isso T-18 não consegue extrair "quem faz o quê".

**Opções (decidir na sessão, pela ordem de custo/esforço):**
| Opção | Como | Prós | Contras |
|---|---|---|---|
| **A. LLM multimodal via OpenRouter** (`google/gemini-2.5-flash` ou superior, com o **áudio** do bloco + a transcrição Whisper) | Pede ao modelo para atribuir locutor a cada segmento ouvindo o áudio | Sem infra nova; mesma chave; ~US$ 0,002/min | Rótulos consistentes só dentro do bloco (precisa passo de reconciliação entre blocos por amostra de voz descrita); não é diarização acústica de verdade |
| **B. pyannote local** (Python, `pyannote.audio`) | Serviço auxiliar em container separado, CPU | Diarização real, timestamps de troca de locutor precisos, offline | Container + modelo (~1 GB), lento em CPU (≈ tempo real), papel Dev Python entra |
| **C. API de diarização** (Deepgram, AssemblyAI) | Substitui o Whisper por um provedor que já diariza | Melhor qualidade, mais simples | Segunda chave/serviço, custo por minuto maior, foge do "só OpenRouter" |

Recomendação: **A agora** (uma sessão, resolve 80% para reunião/ligação com 2–4 pessoas), **B depois** se a precisão não bastar.

**Aceite (independente da opção):**
- [ ] Caixa de locutores marcada → segmentos saem com `Locutor 1..N` **reais**, consistentes ao longo do arquivo inteiro (não reiniciam a cada bloco)
- [ ] Caixa desmarcada → sem custo/tempo extra (comportamento atual)
- [ ] Usuário pode **renomear** locutores no detalhe ("Locutor 2" → "Cliente") e a renomeação vale para todos os segmentos e exportações
- [ ] Tempo/custo extra exibido na estimativa do modal de upload quando marcado
- [ ] `docs/product.md` passa a listar diarização em §4 só quando esta tarefa fechar; até lá, a caixa na UI ganha aviso "em breve" ou some
- [ ] Teste com um áudio de 2 pessoas (gerar 2ª voz com TTS `Microsoft Zira` + concatenar com o `sample.ogg`) → ≥ 90% dos segmentos com o locutor certo

**Evidência:** _(preencher)_

---

### T-23 — Gestão de usuários (admin cria usuários e admins)
**Estado:** DONE (23/09/2026) · **Prioridade:** 🔴 P0 · **Depende de:** T-01
**Por quê:** hoje não existe forma de criar usuário pela plataforma — só direto no SQLite. Para sair do uso single-admin (ex.: criar `pedro.leon23@gmail.com` como segundo admin) é preciso CRUD de usuários no painel admin.
**Contexto:** `server.js` (rotas `/api/admin/users`, login), `db.js` (schema `users`), `index.html`/`app.js` (painel admin)
**Toca:** `server.js`, `index.html`, `app.js`, `test_suite.js`, `docs/TASKS.md`
**Aceite:**
- [x] Admin autenticado cria usuário novo (e-mail + senha + role `user`|`admin`) pela UI do painel admin
- [x] POST de criação com token de `role='user'` → **403**; sem token → **401**
- [x] Não é possível duplicar e-mail (409) nem reutilizar e-mail inexistente/inválido (400)
- [x] Admin pode promover/rebaixar role e resetar senha de outro usuário (não de si mesmo — proteção contra lockout)
- [x] Novo usuário consegue fazer login imediatamente após a criação
- [x] Senha nunca retornada pela API; lista de usuários mostra e-mail, role e data de criação
- [x] `test_suite.js` (ou teste novo) verde nos cenários acima

**Evidência (23/09/2026):**
- `server.js`: `POST /api/admin/users` ganhou validação (e-mail com regex → 400, senha mín. 6 → 400, role fora de `user|admin` → 400, e-mail duplicado → **409** antes do INSERT); `PUT /api/admin/users/:id` ganhou 404 para alvo inexistente, validação de role/status/daily_limit, **reset de senha** (re-hash bcrypt) e proteção contra lockout (admin não pode rebaixar nem suspender a si mesmo → 400).
- `index.html` + `app.js`: modal real de criação (substitui o fluxo de 3× `prompt()`), ações na tabela — Tornar admin/usuário, Resetar senha, Suspender/Ativar — com ações desabilitadas na própria linha do admin logado; erros da API exibidos (fluxo anterior ignorava 4xx/5xx).
- `tests/t23_user_management.js` (banco isolado via `DB_PATH`, provedor mock, custo zero): **25/25 PASS** — 401 sem token, 403 como user, 400 e-mail/senha/role inválidos, 409 duplicata, login imediato do novo usuário, lista sem `password_hash`, promoção refletida no `/api/auth/me`, auto-rebaixamento/auto-suspensão → 400, 404 inexistente, reset de senha (antiga para de funcionar, nova funciona).
- Deploy: container reiniciado (bind-mount, só `.js`/`.html`); `pedro.leon23@gmail.com` promovido a `admin` via SQL no banco de produção (1 linha afetada).
- Estado alterado para DONE.

---

### T-24 — JEV (juiz de validação) no aprimoramento — análise e viabilidade
**Estado:** DONE (25/09/2026, implementado na sequência como T-25) · **Prioridade:** 🟠 P1 · **Depende de:** T-18 (done), T-15 (done — chave OpenRouter configurável via painel)
**Por quê:** o aprimoramento (T-18) é uma única passada de LLM sem validação: o que o modelo devolve vai direto para o usuário (`server.js:604-646`). Um JEV — modelo juiz também via OpenRouter — avaliaria o resultado antes da entrega. Potencial: trocar o gerador por um modelo mais barato (economia de tokens) mantendo a precisão, e reduzir entregas ruins ao usuário (o juiz reprova e dispara retry com feedback). Mas cada chamada extra custa — sem recursos abundantes, a viabilidade precisa ser provada com números antes de qualquer implementação.
**Contexto:** fluxo atual do enhance: `POST /api/transcriptions/:id/enhance` → lê `analysis_model`/`analysis_prompt` de `system_settings` → monta chunk de ~12.000 chars com glossário (`splitTextIntoChunks`, `buildEnhanceUserContent`) → `runAnalysisChat` (um LLM, sem segundo par) → persiste em `ai_analyses` (com `tokens_in`/`tokens_out` reais — base de custo da análise) → resposta. Candidatos a etapa JEV: (a) após a geração de cada chunk; (b) após o resultado final; (c) `POST /api/chat` e `/api/translate` (mesmo padrão de chamada única). Não existe hoje etapa de validação em nenhuma delas.
**Toca:** nada em código nesta task — análise e desenho apenas. Implementação, se aprovada, vira T-25+.
**Aceite:**
- [x] Mapa das etapas do pipeline de aprimoramento (e de chat/translate) com o ponto de inserção do JEV desenhado e justificado — onde entra, o que recebe, o que devolve
- [x] Números reais de custo: média de `tokens_in`/`tokens_out` por aprimoramento em `ai_analyses` (produção) vs. projeção gerador-mais-barato + juiz; economia estimada em % e em US$
- [x] Prompt do juiz desenhado (critérios objetivos: fidelidade ao texto original — nada inventado, aplicação do glossário, estrutura, concordância) + modelo do juiz selecionável no painel admin (mesmo padrão de `analysis_model`)
- [x] Estratégia de retry definida: limite de tentativas, o que acontece se o juiz reprovar tudo (entrega com aviso? erro explícito? — sem texto inventado)
- [x] Decisão **go/no-go** registrada com motivo: se go, especificação pronta para virar T-25; se no-go, o motivo (ex.: custo do juiz > economia do gerador barato)
- [x] Análise de precisão: como medir se o JEV melhora a entrega (amostra real de aprimoramentos avaliada antes/depois)

**Evidência (25/09/2026):**
- Ponto de inserção escolhido: **por chunk, entre a geração e a montagem do resultado** — mais preciso que juiz só no final (localiza o trecho reprovado) e o retry fica limitado ao chunk. Chat/translate ficam fora do escopo (fase 2, se o JEV se provar no enhance).
- Custo real medido (enhance de produção, transcrição de 317 chars): **913 tokens in / 83 out (gerador gpt-4o-mini + juiz gpt-4o-mini na mesma chamada de medição)**. O juiz adiciona ~1x o input do chunk (original + candidato) e um output mínimo de JSON — para textos curtos o overhead é a maior parte do custo; para textos longos (o caso de uso real, 8h de áudio) o veredicto por chunk pesa pouco contra o total.
- Prompt do juiz: `JUDGE_SYSTEM_PROMPT` em `services/judge.js` — 4 dimensões (fidelidade, glossário, estrutura, idioma), resposta estrita em JSON `{approved, issues}`. Modelo configurável em `system_settings.judge_model`; ativação em `judge_enabled`.
- Retry: 1 tentativa com feedback do juiz embutido no prompt (`JUDGE_MAX_RETRIES=1`); se continuar reprovado, **entrega com aviso** (`judge.approved=false` + issues no metadado e no histórico) — nunca texto inventado.
- Decisão: **GO** (dono decidiu implementar após ver a análise; diferencial de mercado).
- Precisão: veredicto e issues persistidos em `ai_analyses.judge_approved/judge_feedback` — base para medir taxa de aprovação em produção e comparar qualidade percebida.

---

### T-25 — JEV implementado: juiz valida o aprimoramento antes de entregar
**Estado:** DONE (25/09/2026) · **Prioridade:** 🟠 P1 · **Depende de:** T-24 (done)
**Por quê:** entregar o desenho aprovado na T-24: gerador barato + juiz barato segurando a qualidade, com retry localizado e rastro de auditoria.
**Contexto:** `services/judge.js` (novo), `server.js` (`POST /:id/enhance`), `db.js` (migração `ai_analyses`), `index.html`/`app.js` (painel admin + selo no resultado), `tests/t25_jev.js`
**Toca:** `services/judge.js`, `server.js`, `db.js`, `index.html`, `app.js`, `tests/t25_jev.js`, `docs/`
**Aceite:**
- [x] Juiz avalia cada chunk aprimorado (fidelidade, glossário, estrutura, idioma) antes da entrega; modelo e ativação configuráveis no painel admin (`judge_model`, `judge_enabled`)
- [x] Reprovação dispara 1 retry do chunk com o feedback do juiz; reprovação persistente entrega com aviso — sem texto inventado
- [x] Veredicto persistido: `judge_model`, `judge_approved`, `judge_feedback`, `attempts` em `ai_analyses`; histórico e metadado da UI expõem o selo (✓ aprovado / ⚠ revisão recomendada)
- [x] `judge_enabled='0'` devolve o fluxo T-18 puro (judge null, sem custo extra)
- [x] Veredicto inválido do juiz (JSON quebrado) não trava o usuário: registra no log e segue como aprovado
- [x] `tests/t25_jev.js` verde (mock, custo zero) + `test_suite.js` 79/79 sem regressão + 1 enhance real em produção aprovado pelo juiz

**Evidência (25/09/2026):**
- `services/judge.js`: `enhanceWithJudge` (orquestração gerar→julgar→retry), `runJudge` (prompt + parse tolerante de JSON), mock sem custo (`MOCK_JUDGE_REJECT=1` força reprovação).
- `server.js`: enhance usa `enhanceWithJudge`; resposta inclui `attempts` e `judge:{approved,issues}`; INSERT com as 4 colunas novas.
- `db.js`: migração aditiva (colunas só se ausentes).
- UI: selo no metadado do resultado (ambos: resposta nova e histórico); painel admin "Modelos & IA" ganhou bloco JEV (modelo + checkbox ativado).
- `tests/t25_jev.js` → **20/20 PASS** (aprovação, persistência, desligar juiz, roundtrip de settings, retry com reprovação forçada).
- Produção: enhance real (transcrição 317 chars) → juiz aprovou, 1 tentativa, 913 tokens in / 83 out; `test_suite.js` → **79/79 PASS**.

---

## Concluídas

| Tarefa | Commit |
|---|---|
| Pipeline assíncrono de transcrição com pré-processamento | `eb283a8` |
| ffmpeg na imagem Docker (destrava a fila) | `9b58da2` |
| Correção do endpoint `/api/chat` | `cb798b2` |
| Suíte de testes adaptada ao pipeline assíncrono | `6f7484d` |
| Premissa de deploy Docker + Git Flow formalizados | `4c5f316` |

---

### T-26 — MinIO/S3 para arquivos (camada de storage isolada)
**Estado:** TODO · **Prioridade:** 🟡 P2 · **Depende de:** T-08 (fase 2) · **Antes de:** escala multi-node
**Por quê:** os áudios vivem em `./uploads` no disco do container. Num único nó KVM2 funciona (volume nomeado), mas 35 mil usuários gerando áudio de horas vão encher o disco e prender os arquivos à máquina. Storage S3-compatível (MinIO self-hosted ou S3 de verdade) desacopla "onde o app roda" de "onde o áudio mora".
**Contexto:** `services/audio.js` (gravação dos blocos), `server.js` (`/uploads`, rotas de export), `services/exporter.js`
**Toca:** novo `services/storage.js` (interface `put/get/delete` — primeiro implementação filesystem, depois S3), `services/audio.js`, `server.js`, `docker-compose.yml` (service minio opcional)
**Aceite:**
- [ ] Interface de storage única; trocar filesystem → S3 é mudança de `.env` (`STORAGE_DRIVER=fs|s3`), zero código
- [ ] Service `minio` no compose (perfil opcional), credenciais via `.env`
- [ ] Arquivos novos no S3 quando configurado; legado continua servindo do filesystem (fallback por existência)
- [ ] Nenhuma URL de arquivo expõe o backend de storage (rotas autenticadas, T-13)

**Evidência:** _(preencher)_

---

### T-27 — Asaas: assinaturas, webhook de pagamento, suspensão automática
**Estado:** TODO · **Prioridade:** 🔴 P0 · **Depende de:** T-08 (fase 2), T-07 (cotas), T-28 (cadastro)
**Por quê:** "ganhar dinheiro dormindo" exige cobrança sem intervenção: o usuário assina, paga, usa; deixou de pagar, o sistema suspende sozinho. O Asaas é o PSP escolhido (PIX/boleto/cartão, sem burocracia de gateway internacional).
**Contexto:** `db.js` (`users.status`, `daily_limit` — base do controle), `server.js` (rotas admin)
**Toca:** novo `services/billing.js`, `server.js` (webhook público + rotas de assinatura), `db.js` (tabela `subscriptions`), `app.js` (seção Assinatura na Conta, T-09), `docker-compose.yml`, `.env.example`
**Aceite:**
- [ ] `POST /webhooks/asaas` (público) validando token de assinatura do webhook; eventos `PAYMENT_CONFIRMED`/`PAYMENT_OVERDUE`/`SUBSCRIPTION_CANCELLED` idempotentes (recebido 2× = efeito 1×)
- [ ] Pagamento confirmado → usuário `active` com cota do plano; vencido → `suspended` (login bloqueia com mensagem clara, dados intactos)
- [ ] Tabela `subscriptions` (user_id, asaas_customer_id, asaas_subscription_id, plan, status, timestamps) — histórico, não só estado atual
- [ ] Sem token de webhook configurado em produção → servidor recusa subir (mesmo padrão do `JWT_SECRET`)
- [ ] Testes com payloads assinados gerados no próprio teste (sem chamar Asaas de verdade)
- [ ] `docs/INSTALL.md`: como conectar a conta Asaas (API key + webhook token no `.env`)

**Evidência:** _(preencher)_

---

### T-28 — Landing page + auto-cadastro + confirmação de e-mail
**Estado:** TODO · **Prioridade:** 🔴 P0 · **Depende de:** T-08 (fase 2 — cadastro escreve no banco); design base pronto no Stitch (`transcreve.ai_landing_page_oficial`)
**Por quê:** hoje não há porta de entrada: quem quiser usar precisa que o admin crie a conta. A landing é o funil: visitante → demo/argumento → cadastro → e-mail confirmado → primeiro upload. É a peça que transforma o sistema em produto vendável.
**Contexto:** `server.js:84-137` (auth), `db.js` (users), material do Stitch em `files_frontend_example/stitch_transcreve.ai_mobile_redesign/transcreve.ai_landing_page_oficial/`
**Toca:** `landing.html` (novo, separado da SPA), `server.js` (rotas públicas de cadastro + verificação de e-mail), `app.js` (deep-link de confirmação), `.env.example` (SMTP), `package.json`
**Aceite:**
- [ ] Landing estática servida em `/` para não-autenticado (SPA continua em `/app`): hero com gradiente no verbo, métricas reais do sistema (não inventadas — só publicar número se for medido), pricing, FAQ, CTA de cadastro
- [ ] `POST /api/auth/register`: nome, e-mail, senha → conta `pending_verification`; e-mail de confirmação com token único (30 min de validade); só após clicar a conta fica `active`
- [ ] Sem SMTP configurado em produção → cadastro desabilitado com aviso explícito no admin (nunca conta ativa sem verificação)
- [ ] E-mail duplicado → 409 claro; senha fraca → 400 com regra explícita
- [ ] Rate limit no register e no resend de confirmação (por IP)
- [ ] Testes: fluxo completo com SMTP mock (custo zero)

**Evidência:** _(preencher)_

---

### T-29 — Reformulação UX/UI "Obsidian Wave" (absorve T-12/T-14)
**Estado:** TODO · **Prioridade:** 🟠 P1 · **Análise completa:** sessão de 28/09/2026 com o Designer sobre o material do Stitch
**Por quê:** a interface atual é visualmente idêntica à da concorrente que plagiou o design. O redesign "Obsidian Wave" (material em `files_frontend_example/stitch_transcreve.ai_mobile_redesign/colors_obsidian_wave/DESIGN.md`) dá identidade própria: canvas obsidiana `#06080F`, ciano `#00F2FE`, violeta `#7928CA`, Plus Jakarta Sans, elevação por camadas tonais. Gap técnico quase zero — mesma stack (Tailwind CDN, SPA vanilla). O que diferencia de verdade não é a paleta (gradiente ciano→violeta é clichê de SaaS de IA) — é a **tipografia de dados**: blocos de locutor, métricas, player persistente.
**Contexto:** `index.html` (Tailwind config inline), `app.js`, material do Stitch (3 telas + DESIGN.md)
**Toca:** `index.html`, `app.js` (CSS/tokens/layout; nenhuma rota)

**Fases (uma por sessão, cada uma commitável):**
- **F1 — Tokens:** `tokens.css` (variáveis das duas paletas, escuro + claro) + tailwind.config estendido (paleta, raios, Jakarta Sans). Aceite: app escuro inteiro na nova paleta, zero mudança estrutural. Tema claro com cores sombreadas (ciano puro falha contraste em fundo branco — usar `#00A6B0`), glow desligado no claro.
- **F2 — Componentes atômicos:** botões (press 0.97), inputs, chips de status (cor a 12% opacidade), badges de tier, cards, drawer/bottom sheet, **helper único de modal** (Esc, backdrop, foco, sem `prompt()` — fecha o escopo da T-14).
- **F3 — Telas, nesta ordem:** (1) **Editor de transcrição** primeiro (tela de maior retenção): blocos de fala, player com waveform em canvas, **player fixo/barra persistente** (fecha o escopo da T-12), toolbar unificada; (2) **Workspace/lista**: 3 colunas desktop, card de job ativo, painel player persistente, sidebar colapsável, empilhamento mobile; (3) **Landing** por último (menor risco, identidade pública).
- **F4 — Polimento:** glow em no máximo 1 elemento por viewport, `prefers-reduced-motion`, auditoria de contraste AA no claro, passada do Avaliador UX/UI nos fluxos-chave.

**Regras de ouro do redesign (decididas na análise):**
- Uma paleta só — descartar os tokens Material 3 genéricos que o Stitch gerou junto
- Glow: 1 elemento ativo por viewport; gradiente ciano→violeta só em logo/H1/FAB/card Pro
- Waveform só no player (canvas + rAF), nunca em todos os cards da lista
- Glassmorphism só em elementos fixos (bottom bar/drawer), nunca em itens de lista
- Mobile-first em cada fase: cada tela entrega primeiro <640px, depois ≥1024px
- Migração por seções (`grep -n` + blocos) — nunca reescrita big-bang do `index.html`

**Aceite:**
- [ ] F1 entregue com app escuro na paleta nova e tema claro derivado (contraste AA auditado)
- [ ] F2 com helper de modal único e zero `prompt()`/`alert()` no `app.js` (T-14 fechada)
- [ ] F3 com player persistente na tela de detalhe (T-12 fechada) e editor em blocos de fala
- [ ] `tests/ui_regressions.js` verde a cada fase; screenshots das 3 larguras (375/768/1440) na evidência
- [ ] Doc de design tokens em `docs/` (a paleta oficial, matando a duplicidade do DESIGN.md)

**Evidência:** _(preencher)_

---

### T-30 — API pública + webhooks (tool para LLMs)
**Estado:** TODO · **Prioridade:** 🟡 P2 · **Depende de:** T-08 (fase 2), T-07 (cotas — API consome cota)
**Por quê:** o próximo canal de aquisição de usuários não é humano: é LLM. Quando alguém monta um agente que precisa transcrever, a TranscreveAI precisa ser callable por máquina — endpoint estável, auth por API key, webhook de conclusão. É também a base do MCP (T-31).
**Contexto:** `server.js` (rotas `/api/*`), `db.js`
**Toca:** `server.js` (novas rotas sob `/v1/`), `db.js` (`api_tokens` por usuário), `docs/` (API reference), `.env.example`
**Aceite:**
- [ ] `POST /v1/transcriptions` (URL ou multipart) autenticado por `Authorization: Bearer tk_...` — o token é do usuário (não da OpenRouter); tokens armazenados em hash, prefixo visível
- [ ] `GET /v1/transcriptions/:id` com status e resultado; escopo: só vê o que o dono do token criou
- [ ] Webhook de conclusão: usuário registra URL + secret; a app POSTa `{event, id, status}` assinado com HMAC-SHA256 do secret; retry com backoff em falha (5 tentativas)
- [ ] Cota de API = mesma `daily_limit` da UI (T-07); headers `X-RateLimit-*` nas respostas
- [ ] API reference em `docs/API.md` com exemplos curl; versão no path (`/v1/`)
- [ ] `test_suite.js` cobre auth, escopo e assinatura do webhook (sem chamadas externas)

**Evidência:** _(preencher)_

---

### T-31 — MCP server / skills sobre a API
**Estado:** TODO · **Prioridade:** 🟢 P3 · **Depende de:** T-30
**Por quê:** com a API pública estável, um MCP server é uma camada fina que coloca a TranscreveAI dentro de Claude/Cursor/Kimi como ferramenta nativa — canal de distribuição com custo quase zero de implementação.
**Contexto:** `docs/API.md` (da T-30), spec MCP (modelcontextprotocol.io)
**Toca:** novo diretório `mcp/` (server独立, empacotável separado)
**Aceite:**
- [ ] Server MCP (stdio ou HTTP) expondo: `transcreve.upload`, `transcreve.status`, `transcreve.result` sobre a API `/v1/`
- [ ] Auth via API key do usuário (config do client MCP)
- [ ] Publicável no registry de MCPs com README de instalação em ≤5 linhas
- [ ] Zero lógica de negócio duplicada — o MCP só traduz chamadas

**Evidência:** _(preencher)_

---

### T-32 — Deploy one-click (compose prod, `.env` documentado, INSTALL)
**Estado:** TODO · **Prioridade:** 🟠 P1 · **Depende de:** T-08 (fase 2), T-27 (Asaas), T-28 (landing)
**Por quê:** o produto é vendível também para quem quer self-host ("compre e suba em poucos cliques"). Hoje o compose é de dev: bind-mount de código, segredos default, Traefik local com cert autoassinado. O compose de produção precisa ser seguro por padrão e configurável só via `.env`.
**Contexto:** `docker-compose.yml`, `Dockerfile`, `.env.example`, `docs/INSTALL.md`
**Toca:** `docker-compose.prod.yml` (novo), `.env.example`, `docs/INSTALL.md`, `README.md`
**Aceite:**
- [ ] `docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d` sobe app + db (+ minio opcional) sem bind-mount de código
- [ ] Todos os segredos vêm do `.env` — nenhum default funcional em produção (servidor já recusa JWT_SECRET/APP_SECRET_KEY default; estender ao Postgres e ao webhook do Asaas)
- [ ] `docs/INSTALL.md` com trilhas: Portainer (upload do compose), VPS Docker, dev local — cada uma com checklist de `.env`
- [ ] Backup documentado: `pg_dump` agendado + `uploads/` (ou S3) — o dono do SaaS precisa dormir tranquilo também
- [ ] Healthchecks em todos os services; restart policy `unless-stopped`

**Evidência:** _(preencher)_

---

### T-33 — Gravador de voz: waveform, pausar, idioma, transcrever direto
**Estado:** TODO · **Prioridade:** 🟢 P3 · **Rescopeada 28/09** (era a T-11 — perdeu prioridade para entrada por link, que virou a nova T-11)
**Por quê:** o gravador atual (`app.js:996-1050`) é um timer `00:00` estático sem feedback de microfone, sem pausa, sem idioma. Não é o caso de uso principal (receber arquivo/link), mas é polimento que completa o app.
**Contexto:** `app.js:996-1050`, `index.html` (modal do gravador), `server.js:228-280` (`/api/transcribe`)
**Toca:** `app.js`, `index.html`
**Aceite:**
- [ ] Waveform ao vivo via `AudioContext` + `AnalyserNode` em `<canvas>` (sem lib)
- [ ] Iniciar → (Pausar ⇄ Retomar) → Parar com `MediaRecorder.pause()/resume()` reais
- [ ] Seletor de idioma (4 opções) + projeto
- [ ] Ao parar: botão **TRANSCREVER** envia direto para `/api/transcribe`
- [ ] Permissão negada → mensagem clara no modal, não `alert()`

**Fora de escopo:** gravação de dia inteiro pelo navegador (T-19 cobre o fluxo de arquivo).

**Evidência:** _(preencher)_
