# system_product.md — Fronteiras do Sistema e do Produto

> Síntese entre [product.md](product.md) (o quê) e [stack.md](stack.md) (com quê). Responde: onde termina o produto e onde começa o sistema técnico, quem depende de quem, e o que está fora de escopo.

## O sistema em uma frase

Um monolito Node/Express de processo único que recebe áudio, processa em fila interna via ffmpeg + OpenRouter (Whisper), e serve o resultado a uma SPA sem build step — tudo dentro de um único container Docker, para um público interno pequeno (equipe de corretagem de planos de saúde).

## Escopo do produto (o que o sistema promete)

- Transcrever áudio/vídeo de atendimento com precisão em PT-BR
- Deixar o conteúdo pesquisável, editável e exportável (PDF/DOCX/TXT/SRT/VTT)
- Resumir e responder perguntas sobre a transcrição via IA
- Organizar por projetos
- Dar a um admin controle sobre usuários, chaves de API e custo

## Fora de escopo (deliberado ou por dívida técnica)

| Item | Por quê está fora |
|---|---|
| Multi-tenancy real (isolamento de dados) | Não construído ainda — ver [MULTIUSER.md](MULTIUSER.md) P-01/B-03 |
| Fila de processamento distribuída/paralela | Decisão de custo operacional: 1 job por vez no processo único |
| Autosserviço de conta (signup, troca de senha, billing) | Público é interno, provisionado pelo admin |
| Front-end com build step / framework | Baixo custo de manutenção é prioridade sobre DX de front |
| Observabilidade externa (APM, alertas) | `system_logs` local é suficiente para o volume atual |

## Onde produto e sistema se tocam (pontos de acoplamento)

| Decisão de produto | Consequência técnica | Documentado em |
|---|---|---|
| "Qualquer áudio de até ~600s processa direto" | Acima disso, split automático nos silêncios via ffmpeg — mais chamadas ao Whisper, mais custo e tempo | [../pipeline.md](../pipeline.md), [stack.md](stack.md) |
| "3 níveis de qualidade (Chita/Golfinho/Baleia)" | Mapeiam 1:1 para modelos OpenRouter distintos com preços distintos — trocar o mapeamento é mudança de produto E de custo simultaneamente | [product.md](product.md) §Ingestão |
| "Resumo de IA focado num assunto" | Campo `ai_focus` vira prompt — texto livre do usuário injetado no prompt de resumo, sem sanitização adicional além do próprio modelo | `services/openrouter.js` |
| "Ver progresso da fila" | Não existe posição na fila exposta — usuário só vê `pending`/`processing`, porque a fila é um poll simples, não uma estrutura com ranking | [MULTIUSER.md](MULTIUSER.md) §B-04 |
| "Painel admin único, sem múltiplos ambientes" | `JWT_SECRET` e credenciais vivem em `.env`/compose de um único deploy — não há isolamento de ambiente staging/prod | [stack.md](stack.md) §Configuração |

## Riscos de produto que são, na raiz, riscos de sistema

O maior risco de produto hoje — "não dá para convidar mais gente sem vazar dados de todo mundo" — é 100% uma limitação de sistema (ausência de `WHERE user_id` nas queries, fallback de auth sem token). Não há mitigação de produto (aviso na UI, etc.) que resolva isso; é bloqueador de engenharia. Ver [MULTIUSER.md](MULTIUSER.md) para a auditoria completa e [TASKS.md](TASKS.md) T-01/T-02 para o plano de correção.

## Ver também
- [product.md](product.md) — funcionalidades e lacunas de produto
- [stack.md](stack.md) — tecnologias e limites técnicos
- [system_design.md](system_design.md) — como as peças internas se conectam
- [MULTIUSER.md](MULTIUSER.md) — auditoria de prontidão multiusuário
