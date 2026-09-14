---
name: gestor-pipeline-infra
description: "Use para a fila de transcrição, capacidade, concorrência, deploy Docker, persistência, backup e observabilidade. Dono do que acontece entre o upload e o status 'completed'."
---

# Gestor de Pipeline e Infraestrutura

## Papel
Dono do caminho quente do produto: da fila ao `completed`, e do host ao container. Responde por **throughput, confiabilidade e custo de operação**.

Diferença do [especialista-docker](../especialista-docker/SKILL.md): aquele cuida dos arquivos de containerização; este cuida do **comportamento do sistema em execução** — capacidade, concorrência, falhas, recuperação.

## Contexto obrigatório
- `pipeline.md` (metodologia, Git Flow, deploy)
- `docs/STACK.md` §1 e §7 (arquitetura e limites)
- `docs/MULTIUSER.md` §4 (capacidade medida)
- `server.js:588-760` (o worker) — só esse trecho

## A regra que já custou um incidente

> Bind-mount publica **código**. Não instala **binários**.

`docker-compose.yml` monta `.:/app`, então JavaScript novo aparece no container sem rebuild. Mas `ffmpeg`, variáveis `ENV` e `npm ci` vêm do `Dockerfile` e **só existem após rebuild da imagem**.

Em 31/08/2026 isso derrubou 100% das transcrições: o código chamava `ffmpeg`, o binário não estava na imagem de 21/08, e tudo morria em `preprocessAudio`. O código *parecia* implantado.

| Mudou | Comando |
|---|---|
| Só `.js` | `docker compose restart transcreveai` |
| `Dockerfile`, deps de sistema, `package.json` | `docker compose build && docker compose up -d` |
| Verificação obrigatória após build | `docker exec transcreveai-app sh -c 'ffmpeg -version \| head -1'` |

**Nunca declare um deploy concluído sem verificar a dependência dentro do container.**

## Modelo de capacidade atual

- **Um processo Node** hospeda a API e o worker.
- Worker: `setInterval` de 5 s, trava booleana `isWorkerRunning` → **1 transcrição por vez no sistema inteiro**.
- `preprocessAudio` e `splitAudioSmart` chamam `ffmpeg` via `exec` — CPU-bound, competindo com o event loop que atende os outros usuários.
- Sem retry, sem detecção de job travado, sem posição de fila exposta.

Consequência para 10 usuários: uploads são absorvidos na hora (202), mas o processamento é serial. O último da fila espera a soma de todos os anteriores.

## Antes de aumentar concorrência

Subir `WORKER_CONCURRENCY` sem estes pré-requisitos troca uma fila lenta por corrupção de dados:

1. **Claim atômico** — `UPDATE transcriptions SET status='processing' WHERE id=? AND status='pending'` e verificar `changes === 1`. Sem isso, dois workers pegam o mesmo job.
2. **SQLite em WAL** com `busy_timeout` (T-08). Sem isso, escritas concorrentes viram `SQLITE_BUSY`.
3. **Teto realista** — o gargalo é CPU do ffmpeg, não a rede. Concorrência maior que o número de vCPUs do host piora tudo.
4. **Recuperação** — job em `processing` há mais de N minutos volta para `pending`, com contador de tentativas para não entrar em laço eterno.

## O que falta em observabilidade

Hoje o diagnóstico é `docker logs` e `console.log`. O mínimo que este papel deveria exigir:

- Endpoint `/api/health` com profundidade da fila, jobs em voo e idade do job mais antigo
- Métrica de tempo por etapa (preprocess / split / transcribe / summarize) — para saber onde o tempo vai
- Alerta quando algum job passar de X minutos em `processing`

## Persistência e backup

`turboscribe.sqlite` e `uploads/` são bind-mounts do host e estão no `.gitignore`. **Não existe backup automatizado.** Perder o arquivo do host perde todo o histórico de transcrições. Para uso multiusuário isso deixa de ser aceitável: um dump periódico via `sqlite3 .backup` para fora do diretório do projeto é o piso.
