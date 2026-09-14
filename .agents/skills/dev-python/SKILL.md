---
name: dev-python
description: "Use para scripts auxiliares em Python: análise de dados do SQLite, testes de carga, manipulação de áudio com ffmpeg, automações e prototipagem. NÃO para o backend da aplicação, que é Node.js."
---

# Dev Python

## ⚠️ Leia isto primeiro — fronteira de atuação

**O backend do TranscreveAI é Node.js/Express, não Python.** `server.js`, `db.js` e `services/*.js` são território do [analista-desenvolvimento](../analista-desenvolvimento/SKILL.md). Este papel **não reescreve** a aplicação em Python e não introduz um segundo runtime na imagem Docker de produção.

Se uma tarefa parece pedir Python no caminho crítico da aplicação, a resposta correta é apontar isso e devolver a tarefa ao papel certo.

## Onde este papel é legítimo

| Uso | Exemplo concreto no projeto |
|---|---|
| Análise do banco | Ler `turboscribe.sqlite` e cruzar duração × custo × modelo por usuário |
| Testes de carga | Simular N usuários concorrentes com `asyncio` + `httpx`, medir p50/p95 |
| Áudio | Prototipar filtros `ffmpeg`, medir ganho de acurácia antes de portar para `services/audio.js` |
| Qualidade da transcrição | Calcular WER contra um gold standard PT-BR, avaliar o filtro de alucinações |
| Automação | Backup do SQLite, limpeza de `uploads/` órfãos, relatórios recorrentes |

## Regras

1. **Isolamento.** Todo script Python vive em `tools/` ou `tests/`, nunca na raiz da aplicação. Nada em `services/`.
2. **Zero acoplamento com produção.** O container de produção não ganha Python. Scripts rodam no host, contra a API HTTP ou contra uma **cópia** do SQLite.
3. **Nunca escrever no `turboscribe.sqlite` de produção.** Leitura, sempre. Para experimentar, copie o arquivo primeiro. O banco é o estado real do usuário.
4. **Dependências declaradas** em `tools/requirements.txt`, com versões fixadas. Sem `pip install` implícito.
5. **Protótipo é protótipo.** Se um script Python provar uma melhoria (ex.: cadeia de filtros de áudio melhor), o resultado é uma **especificação** para o `services/audio.js` — não um serviço Python permanente.

## Contexto obrigatório
- `docs/STACK.md` §3 (esquema do banco) antes de qualquer query
- `services/audio.js` antes de mexer em ffmpeg — os filtros já aplicados estão lá
- `docs/WORKFLOW.md` §4 (economia de contexto)

## Estilo
Python 3.11+, `pathlib`, type hints nas assinaturas públicas, `argparse` para qualquer script que aceite parâmetro, saída legível em stdout (nada de `print` de debug esquecido). Um script = um propósito.
