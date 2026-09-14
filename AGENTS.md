# Diretrizes do Projeto: TranscreveAI

Este arquivo é o prompt de sistema do projeto. **Leia-o inteiro; ele é curto de propósito.** O resto do contexto é carregado sob demanda, nunca de uma vez.

---

## 🚦 Como iniciar qualquer sessão

1. Abra [`docs/TASKS.md`](docs/TASKS.md) e escolha **uma** tarefa (`T-XX`).
2. Leia **apenas** os arquivos listados no campo `Contexto` daquela tarefa.
3. Faça o alinhamento curto dos papéis (máx. 5 linhas, máx. 2 papéis).
4. Implemente, valide, registre a evidência, encerre a sessão.

O protocolo completo está em [`docs/WORKFLOW.md`](docs/WORKFLOW.md). **Não leia `server.js`, `app.js` ou `index.html` por inteiro** — são ~135 KB juntos. Use `grep -n` e `sed -n 'A,Bp'`.

---

## 📚 Mapa da documentação

| Documento | Responde |
|---|---|
| [`docs/product.md`](docs/product.md) | O que o sistema é, para quem, quais telas e funcionalidades **existem de fato** |
| [`docs/stack.md`](docs/stack.md) | Tecnologias, esquema do banco, mapa de rotas, limites técnicos |
| [`docs/system_product.md`](docs/system_product.md) | Onde produto e sistema técnico se acoplam, fronteiras e fora de escopo |
| [`docs/system_design.md`](docs/system_design.md) | Arquitetura, decisões de design e o tradeoff aceito em cada uma |
| [`docs/workflow.md`](docs/workflow.md) | Como trabalhamos: uma tarefa por sessão, contexto sob demanda, teste com arquivo base |
| [`docs/INSTALL.md`](docs/INSTALL.md) | Como instalar self-hosted (Docker, Docker+Traefik, Node direto) e configurar a OpenRouter |
| [`docs/TASKS.md`](docs/TASKS.md) | O backlog executável com critérios de aceite |
| [`docs/MULTIUSER.md`](docs/MULTIUSER.md) | Auditoria de prontidão multiusuário, capacidade e riscos |
| [`pipeline.md`](pipeline.md) | Pipeline técnico de transcrição, deploy Docker e Git Flow |

---

## ⚠️ Três regras que já custaram caro

1. **Bind-mount publica código, não binários.** Mexeu no `Dockerfile` → `docker compose build`. Só `.js` → `docker compose restart transcreveai`. Verifique dentro do container antes de declarar deploy feito.
2. **Sem dados fictícios.** Falha de API retorna erro explícito. Nunca injetar texto inventado no banco.
3. **Doc desatualizada é dívida de token.** Mudou a realidade, atualize `docs/` no mesmo commit.

---

## 👥 Papéis disponíveis (`.agents/skills/`)

### Negócio e coordenação
- [Empreendedor](.agents/skills/empreendedor/SKILL.md) — decide **se** vale construir; corta escopo, cuida do custo por transcrição.
- [Gestor de Projetos](.agents/skills/gestor-projeto/SKILL.md) — organiza **como** entregar; divide e prioriza.

### Construção
- [Analista de Desenvolvimento](.agents/skills/analista-desenvolvimento/SKILL.md) — backend Node/Express, arquitetura, rotas.
- [Especialista em Banco de Dados](.agents/skills/especialista-db/SKILL.md) — SQLite, migrações, queries.
- [Especialista em Front-end](.agents/skills/especialista-frontend/SKILL.md) — HTML/JS da SPA, estado, requisições.
- [Dev Python](.agents/skills/dev-python/SKILL.md) — scripts auxiliares, análise de dados, testes de carga. **Não** é o backend.

### Forma e qualidade
- [Designer](.agents/skills/designer/SKILL.md) — tokens visuais, tipografia, tema claro/escuro, legibilidade.
- [Avaliador de UX/UI](.agents/skills/avaliador-ux-ui/SKILL.md) — usabilidade, fluxos, responsividade.
- [Especialista em Testes](.agents/skills/especialista-testes/SKILL.md) — suíte automatizada, validação de API.

### Operação
- [Gestor de Pipeline e Infra](.agents/skills/gestor-pipeline-infra/SKILL.md) — fila, concorrência, capacidade, backup, observabilidade.
- [Especialista em Docker](.agents/skills/especialista-docker/SKILL.md) — Dockerfile, compose, containerização.

**Limite:** no máximo 2 papéis por tarefa. Mais que isso é deliberação cara sem ganho.
