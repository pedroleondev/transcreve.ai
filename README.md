# TranscreveAI

SaaS local de **transcrição de áudio e vídeo com IA**, self-hosted em Docker, com painel administrativo. Sobe áudios de atendimento/WhatsApp e devolve texto pesquisável, editável e exportável, com resumo de IA.

Roda inteiro na sua máquina ou servidor: Node.js + Express + SQLite + ffmpeg, transcrição via [OpenRouter](https://openrouter.ai/) (Whisper), sem dependência de nenhum SaaS de terceiros além da própria OpenRouter para transcrever.

## O que ele faz

- Upload múltiplo, drag & drop e gravação direta pelo navegador
- Pré-processamento de áudio (normalização, divisão automática de áudios longos) antes de transcrever
- 3 níveis de qualidade/custo: **Chita** (rápido), **Golfinho** (equilibrado), **Baleia** (precisão)
- Transcrição com timestamps clicáveis, edição inline, resumo de IA focado num assunto
- Exportação em PDF, DOCX, TXT, SRT, VTT
- Chat com IA sobre a transcrição e tradução
- Organização em projetos, busca por conteúdo
- Painel admin: usuários, chaves de API, métricas, logs

Detalhe completo do produto em [docs/product.md](docs/product.md).

## ⚠️ Antes de instalar

Este sistema **hoje não isola dados entre usuários** — qualquer pessoa com acesso à instância vê e pode apagar o conteúdo de todo mundo, e existe um bypass de autenticação conhecido. É seguro para **uso pessoal ou em rede privada**; não exponha publicamente para múltiplos usuários sem um proxy de autenticação na frente. Detalhe da auditoria em [docs/MULTIUSER.md](docs/MULTIUSER.md).

## Instalação rápida

Requisitos: Docker + Docker Compose, e uma chave de API da [OpenRouter](https://openrouter.ai/).

```bash
git clone https://github.com/pedroleondev/transcreve.ai.git
cd transcreve.ai
cp .env.example .env
# edite .env: cole sua OPENROUTER_API_KEY e gere um JWT_SECRET próprio
docker compose up -d
```

Acesse `http://localhost:3000`. Login inicial: `admin@turboscribe.local` / `admin123` — **troque essa senha assim que entrar**.

Sem Docker, ou quer domínio próprio com Traefik? Guia completo, com as duas rotas passo a passo, backup e troubleshooting: **[docs/INSTALL.md](docs/INSTALL.md)**.

## Documentação

| Documento | Responde |
|---|---|
| [docs/INSTALL.md](docs/INSTALL.md) | Como instalar (Docker, Docker+Traefik, ou Node direto) e configurar a chave da OpenRouter |
| [docs/product.md](docs/product.md) | O que o sistema é, para quem, e o que existe de fato |
| [docs/stack.md](docs/stack.md) | Tecnologias, schema do banco, rotas de API, limites técnicos |
| [docs/system_design.md](docs/system_design.md) | Arquitetura e por que cada decisão de design foi tomada |
| [docs/system_product.md](docs/system_product.md) | Onde produto e sistema técnico se acoplam |
| [docs/workflow.md](docs/workflow.md) | Como o projeto é desenvolvido (contexto sob demanda, testes, pré-infra) |
| [docs/MULTIUSER.md](docs/MULTIUSER.md) | Auditoria de segurança e capacidade multiusuário |
| [docs/TASKS.md](docs/TASKS.md) | Backlog executável com critérios de aceite |
| [pipeline.md](pipeline.md) | Pipeline técnico de transcrição, deploy Docker e Git Flow |

## Stack

Node.js 20 · Express · SQLite · ffmpeg · OpenRouter (Whisper) · Tailwind (CDN) · JS vanilla, sem build step. Sem framework de front, sem ORM, sem fila externa — proposital, baixo custo operacional. Detalhe em [docs/stack.md](docs/stack.md).

## Contribuindo

Este projeto segue desenvolvimento orientado a contexto: uma tarefa por sessão, lida em [docs/TASKS.md](docs/TASKS.md), com protocolo descrito em [docs/workflow.md](docs/workflow.md) e [AGENTS.md](AGENTS.md). Antes de abrir uma mudança, rode `node test_suite.js` (usa o áudio de teste versionado em `tests/fixtures/sample.ogg`, sem dado real de cliente).

## Licença

MIT — ver [LICENSE](LICENSE).
