# 👥 MULTIUSER.md — Auditoria de Prontidão para Múltiplos Usuários

> **Escopo:** o sistema está pronto para ~10 usuários simultâneos?
> **Método:** leitura do código + verificação empírica por HTTP contra o container em execução (`transcreveai-app`, up há 1h) em 31/08/2026.
> **Veredito: NÃO. Existem 3 bloqueadores de segurança e 1 bloqueador de capacidade.**

---

## 1. Resumo executivo

O sistema tem **as peças** de multiusuário (tabela `users` com `role`/`daily_limit`/`status`, login JWT, painel admin de usuários, `user_id` gravado em cada transcrição), mas **nenhuma delas é aplicada nas consultas**. Na prática o SaaS opera hoje como instalação **single-tenant de dono único** — que é exatamente como você o usou até agora.

| Dimensão | Situação | Pronto p/ 10 usuários? |
|---|---|---|
| Autenticação | JWT funcional, mas com bypass total | ❌ |
| Isolamento de dados (tenancy) | Inexistente | ❌ |
| Autorização admin | Contornável sem token | ❌ |
| Cotas por usuário | Coluna existe, regra não | ⚠️ |
| Capacidade de processamento | Fila serial, 1 job por vez | ⚠️ funciona, mas enfileira |
| Concorrência do banco | SQLite sem WAL | ⚠️ risco sob carga |
| Infra Docker | Container único, restart automático, volumes ok | ✅ suficiente p/ 10 |

---

## 2. Bloqueadores (com evidência reproduzível)

### 🔴 B-01 — Requisição sem token vira Administrador

`server.js:51-67`:

```js
function authenticateToken(req, res, next) {
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) {
    // Modo local conveniente: Fallback para usuário Admin padrão se sem token
    req.user = { id: 'admin-local', ..., role: 'admin' };
    return next();
  }
```

Qualquer requisição **sem** `Authorization` é tratada como admin. `requireAdmin` passa.

Evidência:
```
$ curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/api/admin/users
200
```
Retornou a lista completa de usuários, **sem autenticação nenhuma**.

**Impacto:** com 10 usuários, qualquer um (ou qualquer pessoa na rede) lê/apaga tudo e administra o sistema.

---

### 🔴 B-02 — Senhas mestras hardcoded no login

`server.js:96`:

```js
if (!match && password !== 'admin123' && password !== 'user123') {
  return res.status(401).json({ error: 'Credenciais inválidas.' });
}
```

As strings `admin123` e `user123` autenticam **qualquer e-mail cadastrado**, ignorando o hash bcrypt.

Evidência: login em `pedro.leon23@gmail.com` e em `admin@turboscribe.local` com a senha `user123` — ambos retornaram token válido.

**Impacto:** saber o e-mail de um colega = ter a conta dele.

---

### 🔴 B-03 — Nenhuma query filtra por `user_id`

Nenhuma das rotas de dados aplica `WHERE user_id = ?`. Exemplos:

```js
// server.js:180 — lista TODAS as transcrições do sistema
let sql = `SELECT t.*, p.name as project_name FROM transcriptions t
           LEFT JOIN projects p ON t.project_id = p.id WHERE 1=1`;

// server.js:141 — lista TODOS os projetos de todos os usuários
`SELECT p.*, COUNT(t.id) as file_count FROM projects p ... GROUP BY p.id`

// server.js:305 — apaga qualquer transcrição, de qualquer dono
`DELETE FROM transcriptions WHERE id = ?`
```

Também sem filtro: `GET /api/transcriptions/:id`, `/status`, `PUT`, `/api/export/:id/:format`.

**Impacto:** vazamento cruzado de conteúdo sensível (áudios de atendimento e negociação) entre os 10 usuários, e exclusão acidental ou maliciosa do trabalho alheio.

---

### 🟠 B-04 — Fila serial: 1 transcrição por vez no sistema inteiro

`server.js:592-600`:

```js
let isWorkerRunning = false;
setInterval(async () => {
  if (isWorkerRunning) return;
  task = await getAsync(`SELECT * FROM transcriptions WHERE status='pending' ORDER BY created_at ASC LIMIT 1`);
```

O worker roda **dentro do processo da API**, com trava global e poll de 5 s.

Não é um bug — é uma decisão de capacidade. Mas com 10 usuários simultâneos:

- 10 áudios de 5 min enviados juntos → o 10º só começa depois dos 9 anteriores.
- O pré-processamento `ffmpeg` é **CPU-bound e síncrono via `exec`**, competindo com o event loop do Express: a UI dos outros usuários fica lenta durante o processamento.
- Não há retry, nem prioridade, nem visibilidade de posição na fila para o usuário (ele vê `pending` e nada mais).

---

## 3. Riscos secundários

| # | Risco | Detalhe |
|---|---|---|
| R-01 | `JWT_SECRET` com default público | Hardcoded em `server.js:18` **e** no `docker-compose.yml`. Tokens forjáveis se o repo vazar. |
| R-02 | SQLite sem WAL | `db.js` abre o banco no modo padrão. 10 usuários escrevendo + worker atualizando `progress` a cada etapa → `SQLITE_BUSY`. |
| R-03 | Sem índices | `transcriptions(user_id, status, created_at)` e `segments(transcription_id)` sem índice. Com filtro por usuário isso vira gargalo. |
| R-04 | `uploads/` é um diretório plano e público | `app.use('/uploads', express.static(...))` serve **qualquer** áudio por URL, sem autenticação. Basta adivinhar/ver o nome. |
| R-05 | Sem `daily_limit` aplicado | Um usuário pode consumir todo o crédito da OpenRouter da empresa. |
| R-06 | Sem limite de upload no Multer | Um arquivo de 5 GB enche o disco do host (bind-mount). |
| R-07 | Sem signup / troca de senha | Onboarding de 10 pessoas é manual via painel admin (viável, mas a senha inicial trafega fora do sistema). |

---

## 4. Capacidade — o que o Docker atual aguenta

Configuração atual: **1 container, sem `deploy.resources`, sem réplicas**, restart `unless-stopped`.

| Carga | Comportamento esperado |
|---|---|
| 10 usuários navegando/lendo | ✅ Tranquilo. Express + SQLite leitura é barato. |
| 10 uploads simultâneos | ✅ Multer grava em disco em paralelo; resposta é 202 imediata. |
| 10 transcrições na fila | ⚠️ Processadas **em série**. Tempo do último ≈ soma de todos. |
| 10 pollings de `/status` a cada N s | ⚠️ Cada poll é um `SELECT` sem índice. Aceitável em 10, ruim em 50. |

**Estimativa:** para 10 usuários que enviam alguns áudios por dia (não todos ao mesmo tempo), a infra atual dá conta. O problema é **percepção** — sem posição na fila, um usuário atrás de 3 áudios longos acha que o sistema travou.

---

## 5. O que precisa existir antes do teste de carga valer

O teste de carga com 10 usuários **só produz um resultado significativo depois** de B-01/B-02/B-03, porque hoje todos os "usuários" enxergam o mesmo conjunto de dados — não há o que isolar nem medir.

Ordem correta:
1. **T-01** Fechar autenticação (B-01, B-02, R-01)
2. **T-02** Aplicar tenancy (`WHERE user_id`) em todas as rotas (B-03, R-04)
3. **T-03** Rodar `tests/load_multiuser.js` — valida isolamento **e** mede capacidade
4. **T-05** Ajustar a fila conforme o número medido

---

## 6. Como rodar o teste de 10 usuários

```bash
node tests/load_multiuser.js
```

O script (`tests/load_multiuser.js`) faz, em uma execução:

1. **Provisiona** 10 usuários de teste (`loadtest01..10@transcreveai.local`) via API admin, idempotente.
2. **Autentica** cada um e guarda o JWT.
3. **Fase A — Segurança:** verifica bypass sem token, senha mestra e acesso admin sem token.
4. **Fase B — Isolamento:** cada usuário cria um projeto e envia um áudio; depois checa se enxerga dados dos outros 9.
5. **Fase C — Capacidade:** 10 uploads simultâneos, mede tempo até 202, profundidade da fila e tempo total até o último `completed`.
6. Emite um relatório com `PASS`/`FAIL` por asserção e a tabela de tempos.

⚠️ **A Fase C consome créditos reais da OpenRouter.** Use `--no-transcribe` para rodar só as fases A e B (custo zero).

Outras opções: `--users=5`, `--cleanup` (suspende os usuários de teste), `AUDIO_SAMPLE=/caminho/audio.ogg`.

---

## 7. Execução de referência — 31/08/2026

`node tests/load_multiuser.js --no-transcribe`, contra o container em execução, com 10 usuários reais provisionados via API admin. **Resultado: 3 PASS / 8 FAIL.**

```
FASE A — SEGURANCA DA AUTENTICACAO
  ❌ GET /api/transcriptions sem token deve retornar 401
     ↳ retornou 200 com 62 registros expostos
  ❌ GET /api/admin/users sem token deve retornar 401
     ↳ retornou 200 — rota administrativa aberta
  ❌ Login com a senha mestra "user123" deve retornar 401
     ↳ retornou 200 e emitiu um token valido
  ❌ Login com a senha mestra "admin123" deve retornar 401
     ↳ retornou 200
  ✅ Usuario comum acessando /api/admin/users deve retornar 403
  ✅ Token invalido deve ser rejeitado

FASE B — ISOLAMENTO DE DADOS ENTRE USUARIOS
  ✅ Cada um dos 10 usuarios conseguiu criar seu projeto
  ❌ Usuario 01 nao deve enxergar projetos dos outros usuarios
     ↳ enxergou 9 projetos alheios (total visivel: 20)
  ❌ Usuario 02 nao deve conseguir apagar o projeto do usuario 01
     ↳ DELETE retornou 200 e o projeto FOI APAGADO
  ❌ Usuario 01 nao deve enxergar transcricoes de outros donos
     ↳ enxergou 62 de 62 registros pertencentes a outros user_id
  ❌ Arquivo em /uploads nao deve ser servido publicamente sem autenticacao
     ↳ GET /uploads/...ogg retornou 200
```

**Leitura dos resultados.** Os dois PASS da Fase A são enganosos: `403` para usuário comum e rejeição de token inválido só provam que o JWT funciona **quando existe um token**. O bypass acontece justamente na ausência dele.

O FAIL mais grave é o segundo da Fase B: o usuário 02 **apagou de fato** o projeto do usuário 01 e a API respondeu `200`. Não é um risco teórico de leitura — é perda de dados alheios em uma chamada.

Os dados de teste (10 usuários, 10 projetos) foram removidos do banco após a execução; o ambiente ficou como estava.

**Conclusão:** a infraestrutura Docker aguenta 10 usuários; a aplicação não. Colocar 10 pessoas neste sistema hoje significa que qualquer uma delas lê e apaga o conteúdo de todas as outras, e que qualquer pessoa com acesso à rede administra o sistema sem senha. Executar T-01 e T-02 antes de qualquer convite.
