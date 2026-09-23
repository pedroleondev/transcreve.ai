# product.md — TranscreveAI (TurboScribe Local)

> O que o sistema é, para quem, e o que já existe de fato. Fonte de verdade auditada no código em 14/09/2026.
> Nada aqui é aspiracional sem estar marcado `[PLANEJADO]`.

## Definição

SaaS local de **transcrição de áudio e vídeo com IA**, self-hosted em Docker, com painel administrativo. Substitui o TurboScribe.ai comercial para uso interno da operação (corretagem de planos de saúde / atendimento).

**Job-to-be-done principal:** transformar áudios de WhatsApp e gravações de atendimento em texto legível, pesquisável e exportável, com resumo de IA focado num assunto.

## Personas

| Persona | Uso | Estado hoje |
|---|---|---|
| Admin SaaS | Cria usuários, gerencia chaves de API, modelos, limites, vê logs | ✅ Implementado (`view-admin`) |
| Usuário operacional | Sobe áudio, acompanha fila, lê/edita transcrição, exporta, usa IA | ✅ Implementado (`view-dashboard`, `view-details`) |
| Leitor / consumidor do conteúdo | Só quer ler bem o resultado (resumo, tópicos, falantes) | ✅ Modos de leitura, resumo Markdown e edicao persistente (T-04) |

## Telas existentes

Apenas 3 views, todas na mesma SPA (`index.html` + `app.js`), alternadas por `showView()`:

| View | ID no DOM | Conteúdo |
|---|---|---|
| Dashboard | `#view-dashboard` | Lista de transcrições, busca, sidebar de projetos, upload/drag-drop, gravador de voz, seleção em massa |
| Detalhe | `#view-details` | Player de áudio sincronizado, transcrição editável (`contenteditable`), timestamps clicáveis, painel de exportação e IA |
| Admin | `#view-admin` | Abas: Métricas, Usuários, Chaves de API, Configurações, Logs |

Planos, FAQ, blog e login são **modais** em `app.js`, não páginas. Não existe: perfil/conta, cadastro (signup), recuperação de senha, billing.

## Funcionalidades por área

### Ingestão
- Upload múltiplo (botão + drag & drop global) e gravação direta pelo navegador (MediaRecorder)
- Formatos: qualquer coisa que `ffmpeg` leia (`.ogg`, `.m4a`, `.mp3`, vídeo com trilha de áudio)
- Nível de transcrição: **Base** (rápido, `whisper-1`), **Pro** (equilibrado, `whisper-large-v3-turbo`), **Max** (precisão PT-BR, `whisper-large-v3`, padrão)
- Estimativa de preço e precisão antes do envio
- Campo "assunto a focar" (`ai_focus`) que vira prompt do resumo pós-transcrição

### Processamento (assíncrono)
Detalhado em [../pipeline.md](../pipeline.md). Resumo: `pending` → pré-processamento ffmpeg (16kHz mono FLAC + loudnorm) → split nos silêncios se > 600s → Whisper via OpenRouter por bloco → filtro de alucinações → resumo IA opcional → `completed`.

### Aparencia
- Alternador Claro / Escuro / Sistema sempre visivel no cabecalho, acessivel por teclado. A escolha fica salva neste navegador.
- Sistema acompanha a preferencia do dispositivo; Claro/Escuro sao escolhas fixas. Paleta aplicada a dashboard, detalhe, admin, modais e paineis de IA.
- Tokens de texto/superficie mantem contraste AA na transcricao (17,85:1 claro / 14,48:1 escuro).

### Consumo do resultado
- Timestamps clicáveis com seek no player
- Modos Transcrição, Leitura (parágrafos por pausa/falante) e Resumo IA com Markdown escapado; preferências de modo, fonte e coluna persistidas
- Copiar como Markdown e rótulos de falantes com cores consistentes
- Edição inline do texto por segmento e do nome do arquivo; salvar sincroniza texto e segmentos usados nas exportações, preservando timestamps/falantes
- Leitura/Resumo não permitem salvar sobre a transcrição; troca de modo avisa sobre edições não salvas
- Exportação: PDF, DOCX, TXT, SRT, VTT (com/sem timestamps)
- Chat com IA sobre a transcrição (`/api/chat`) e tradução (`/api/translate`)

### Organização
- Projetos: criar, excluir, vincular transcrição, mover em massa
- Busca por nome de arquivo e por conteúdo (`raw_text LIKE`)

### Administração
- Métricas (`/api/admin/metrics`)
- CRUD de usuários com `daily_limit` e `status` (active/suspended)
- Chaves de API OpenRouter (múltiplas, com ativação)
- Configurações globais (tamanho máx., duração máx., idioma padrão, modelo por nível)
- Logs de auditoria (`system_logs`)

## Lacunas conhecidas

| # | Lacuna | Impacto |
|---|---|---|
| P-01 | Sem isolamento entre usuários — todo mundo vê tudo | Bloqueia uso multiusuário real |
| P-02 | `daily_limit` existe no banco mas não é aplicado | Sem controle de consumo/custo |
| P-03 | Sem tela de conta/perfil nem troca de senha pelo usuário | Admin precisa mexer no banco |
| P-04 | Resolvido por T-04 em 20/09/2026 | Modos de leitura e edição por segmento com persistência validada |
| P-05 | Resolvido por T-05 em 20/09/2026 | Claro / Escuro / Sistema no cabecalho; preferencia persistida e contraste AA no leitor |
| P-06 | Fila com concorrência 1 | 10 usuários = fila serial |
| P-07 | "Reconhecimento de locutores" é só um flag — todo segmento sai `Locutor 1` | Sem "quem falou" em reuniões/vendas (T-22) |
| P-08 | Blocos de áudio longo transcritos em série, sem retry nem resultado parcial salvo | 8 h de áudio = 45 min de espera e qualquer falha perde tudo (T-19) |

Ver [MULTIUSER.md](MULTIUSER.md) para o detalhe de risco/segurança por trás de P-01/P-02/P-06.

## Ver também
- [stack.md](stack.md) — tecnologias e limites técnicos
- [system_product.md](system_product.md) — síntese produto + fronteiras do sistema
- [system_design.md](system_design.md) — arquitetura e decisões de design
- [workflow.md](workflow.md) — como o time trabalha nesse produto
