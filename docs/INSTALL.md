# INSTALL.md — Guia de Self-Hosting

> Como baixar, instalar e configurar o TranscreveAI na sua própria máquina ou servidor. Duas rotas: **Docker Compose** (recomendado) e **instalação direta com Node.js**.

## ⚠️ Antes de instalar — leia isto

Este sistema **não está pronto para ser exposto publicamente na internet com múltiplos usuários** hoje. Uma auditoria de código (ver [MULTIUSER.md](MULTIUSER.md)) encontrou:

- Requisição sem token de autenticação é tratada como **administrador**
- Senhas mestras (`admin123` / `user123`) autenticam **qualquer** e-mail cadastrado
- Nenhuma rota filtra dados por usuário — todo mundo vê e pode apagar o conteúdo de todo mundo

**Use com segurança assim:**
- ✅ Uso pessoal/único, na sua própria máquina ou numa rede privada (VPN/LAN)
- ✅ Atrás de um proxy com autenticação própria (Traefik + Basic Auth, Cloudflare Access, Tailscale) enquanto T-01/T-02 não são resolvidas
- ❌ **Não** exponha a porta pública sem proxy de autenticação para mais de uma pessoa confiável usar

Ver [TASKS.md](TASKS.md) T-01 e T-02 para o estado da correção.

## Requisitos

| Rota | Requisito |
|---|---|
| Docker Compose | Docker Engine + Docker Compose v2. Opcional: Traefik já rodando na máquina se quiser domínio próprio |
| Instalação direta | Node.js 20+, `ffmpeg`/`ffprobe` instalados e no `PATH`, SQLite (embutido via `sqlite3` npm) |
| Ambos | Uma chave de API da [OpenRouter](https://openrouter.ai/) com crédito — é o único custo recorrente do sistema |

## 1. Baixar o projeto

```bash
git clone https://github.com/pedroleondev/transcreve.ai.git
cd transcreve.ai
```

Sem acesso ao repositório? Baixe o `.zip` da página do GitHub ("Code" → "Download ZIP") e extraia.

## 2. Conseguir sua chave da OpenRouter

1. Crie uma conta em [openrouter.ai](https://openrouter.ai/)
2. Adicione crédito (o consumo é por segundo de áudio transcrito — ver tabela de preços em [../pipeline.md](../pipeline.md) §7)
3. Em **Keys**, crie uma chave nova — o formato começa com `sk-or-v1-`
4. Guarde essa chave, você vai colar no `.env` no próximo passo

## 3. Configurar variáveis de ambiente

```bash
cp .env.example .env
```

Edite `.env`:

```dotenv
PORT=3000
JWT_SECRET=gere_um_valor_aleatorio_longo_aqui
OPENROUTER_API_KEY=sk-or-v1-sua-chave-aqui
```

Gere um `JWT_SECRET` forte em vez de deixar o default (o default é público, está no código-fonte):

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

Cole o resultado em `JWT_SECRET`. **Nunca** reutilize o valor de exemplo do `docker-compose.yml`.

## 4A. Subir com Docker Compose — sem domínio (uso local)

Mais simples: acesso por `http://localhost:3000`, sem Traefik.

```bash
docker compose up -d
```

Isso builda a imagem (instala `ffmpeg` dentro do container) e sobe o serviço lendo `JWT_SECRET`/`OPENROUTER_API_KEY` do `.env`. Verifique:

```bash
docker compose logs -f transcreveai
```

Acesse `http://localhost:3000`.

## 4B. Subir com Docker Compose + Traefik (domínio próprio)

O `docker-compose.yml` já vem com labels do Traefik prontos:

```yaml
labels:
  - "traefik.enable=true"
  - "traefik.http.routers.transcreveai.rule=Host(`transcreveai.localhost`) || Host(`transcreveai.local`)"
  - "traefik.http.routers.transcreveai.entrypoints=web"
  - "traefik.http.services.transcreveai.loadbalancer.server.port=3000"
```

Pré-requisito: um Traefik já rodando na mesma rede Docker (`default` ou a rede que o seu Traefik usa — ajuste `networks:` se o seu Traefik estiver em uma rede externa nomeada, ex. `traefik-public`).

Passos:

1. Troque o `Host(...)` do label pelo seu domínio real, por exemplo:
   ```yaml
   - "traefik.http.routers.transcreveai.rule=Host(`transcreveai.seudominio.com`)"
   ```
2. Se o seu Traefik expõe HTTPS via um entrypoint próprio (ex. `websecure` + resolver Let's Encrypt), adicione:
   ```yaml
   - "traefik.http.routers.transcreveai.entrypoints=websecure"
   - "traefik.http.routers.transcreveai.tls.certresolver=SEU_RESOLVER"
   ```
3. Se o seu Traefik roda numa rede externa, aponte o serviço para ela:
   ```yaml
   networks:
     - traefik-public

   networks:
     traefik-public:
       external: true
   ```
4. **Recomendado enquanto T-01/T-02 não fecham:** adicione autenticação no próprio Traefik (middleware `basicauth` ou `forwardauth`), já que o sistema não tem isolamento multiusuário nativo ainda:
   ```yaml
   - "traefik.http.routers.transcreveai.middlewares=transcreveai-auth"
   - "traefik.http.middlewares.transcreveai-auth.basicauth.users=usuario:$$hash_bcrypt_aqui"
   ```
5. Suba:
   ```bash
   docker compose up -d
   ```

Acesse pelo domínio configurado.

## 4C. Instalação direta com Node.js (sem Docker)

```bash
npm install
```

Instale `ffmpeg` e `ffprobe` e garanta que estão no `PATH`:

- **Windows:** baixe um build estático (ex. gyan.dev), extraia e adicione a pasta `bin` ao `PATH`
- **macOS:** `brew install ffmpeg`
- **Linux (Debian/Ubuntu):** `sudo apt install ffmpeg`

Confirme:

```bash
ffmpeg -version
ffprobe -version
```

Suba o servidor:

```bash
npm start
```

Acesse `http://localhost:3000`. Para desenvolvimento com reload automático: `npm run dev`.

## 5. Primeiro acesso

O sistema cria um admin padrão automaticamente no primeiro boot:

```
E-mail: admin@turboscribe.local
Senha:  admin123
```

**Troque essa senha imediatamente** — hoje isso é feito direto no SQLite ou recriando o usuário pelo painel admin, já que a UI de troca de senha própria ainda não existe (ver [TASKS.md](TASKS.md) T-09). Até lá, trate esse admin default como uma credencial temporária de instalação, não como a conta real de uso.

A chave da OpenRouter que você colocou no `.env` já é sincronizada automaticamente para o banco no boot — não precisa recadastrá-la no painel, mas pode trocar por outra ali (**Admin → Chaves de API**) se quiser usar uma chave diferente sem reiniciar o container.

## 6. Testar a instalação

Com o servidor rodando:

```bash
node test_suite.js
```

Usa o arquivo de áudio versionado em `tests/fixtures/sample.ogg` (voz sintética, sem dado real — ver [workflow.md](workflow.md#teste-com-arquivo-base)). Consome um pouco de crédito real da OpenRouter (é a mesma chave que você configurou). Uma suíte 100% verde confirma: upload, pipeline de transcrição, exportação, chat e tradução funcionando ponta a ponta.

## 7. Backup — não perca o seu trabalho

Três coisas guardam todo o estado do sistema, e nenhuma delas é o código-fonte:

| O quê | Onde | Como fazer backup |
|---|---|---|
| Banco de dados (usuários, transcrições, textos, configurações) | `turboscribe.sqlite` | Copiar o arquivo (com o serviço parado, ou aceitar pequena janela de inconsistência com ele rodando) |
| Áudios originais enviados | `uploads/` | Copiar a pasta |
| Segredos (JWT, chave OpenRouter) | `.env` | Guardar em um cofre de senhas — **nunca** commitar |

```bash
# Exemplo simples de backup
docker compose stop transcreveai
tar -czf backup-$(date +%F).tar.gz turboscribe.sqlite uploads/ .env
docker compose start transcreveai
```

O **código** do projeto é o que menos risco de perda tem — se este repositório tem um remote no GitHub (`git remote -v`), um `git push` regular já é backup suficiente para o código. O que precisa de rotina de backup separada é o trio acima, porque fica fora do Git de propósito (`.gitignore`).

## 8. Atualizando

**Docker Compose:**
```bash
git pull
docker compose build   # só necessário se Dockerfile ou dependências de sistema mudaram
docker compose up -d
```

**Instalação direta:**
```bash
git pull
npm install
npm start
```

Regra prática: mudou só `.js`/`.html` → `docker compose restart transcreveai` basta. Mudou o `Dockerfile` ou dependência de sistema → precisa `build`. Detalhe em [../pipeline.md](../pipeline.md) §1.4.

## 9. Solução de problemas comuns

| Sintoma | Causa provável | Solução |
|---|---|---|
| `ffmpeg: not found` nos logs, todas as transcrições falham | Mexeu no `Dockerfile` mas só rodou `restart` | `docker compose build && docker compose up -d` |
| Porta 3000 já em uso | Outro serviço na mesma porta | Mude `PORT` no `.env` e o mapeamento `ports:` no `docker-compose.yml` |
| Login com `admin123` não funciona mais | Você já trocou a senha (correto!) | Use a nova senha, ou restaure o backup do `turboscribe.sqlite` se perdeu a credencial |
| `SQLITE_BUSY` sob uso simultâneo | Banco sem WAL, limitação conhecida | Ver [MULTIUSER.md](MULTIUSER.md) R-02 e [TASKS.md](TASKS.md) T-08 |
| Traefik não roteia para o serviço | Rede diferente entre Traefik e o container | Confirme que ambos estão na mesma rede Docker (`docker network inspect`) |

## Ver também
- [../README.md](../README.md) — visão geral do projeto
- [product.md](product.md) · [stack.md](stack.md) · [system_design.md](system_design.md)
- [MULTIUSER.md](MULTIUSER.md) — antes de convidar mais de uma pessoa para usar
- [../pipeline.md](../pipeline.md) — Git Flow e detalhe do pipeline de transcrição
