# INSTALL.md — Guia de Self-Hosting

> Como baixar, instalar e configurar o Falou.ai na sua própria máquina ou servidor. Duas rotas: **Docker Compose** (recomendado) e **instalação direta com Node.js**.

## ⚠️ Antes de instalar — leia isto

O isolamento multiusuário ainda não está completo. Estado atual das três vulnerabilidades encontradas na auditoria ([MULTIUSER.md](MULTIUSER.md)):

- ✅ **Resolvido (T-01):** requisição sem token agora retorna **401** — não existe mais bypass de autenticação nem senhas mestras.
- ✅ **Resolvido (T-15):** a chave da OpenRouter fica **cifrada em repouso** (AES-256-GCM) no SQLite e só sai do servidor mascarada (`sk-or-v1-…abcd`); o diretório do projeto não é mais publicado como estático.
- ⏳ **Em aberto (T-02):** as queries ainda não filtram por dono — todo usuário autenticado enxerga o conteúdo dos outros.

**Use com segurança assim:**
- ✅ Uso pessoal/único, na sua própria máquina ou numa rede privada (VPN/LAN)
- ✅ Atrás de um proxy com autenticação própria (Traefik + Basic Auth, Cloudflare Access, Tailscale) enquanto T-02 não é resolvida
- ❌ **Não** exponha a porta pública para mais de uma pessoa confiável usar até T-02/T-03 fecharem

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
APP_SECRET_KEY=gere_outro_valor_aleatorio_longo_aqui
OPENROUTER_API_KEY=sk-or-v1-sua-chave-aqui
```

Gere `JWT_SECRET` e `APP_SECRET_KEY` fortes em vez de deixar o default (o default é público, está no código-fonte):

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

Rode o comando **duas vezes** — um valor para cada variável. **Nunca** reutilize o valor de exemplo do `docker-compose.yml`.

> **Por que `APP_SECRET_KEY` importa tanto:** ela é a chave-mestra que cifra (AES-256-GCM) os segredos guardados no banco — hoje, a chave da OpenRouter. Sem essa variável, ou com o valor trocado, o sistema **não consegue ler a chave cifrada** (em `NODE_ENV=production` o servidor nem sobe). Guarde-a no mesmo cofre do backup do `.env`. Rotação segura em [MULTIUSER.md](MULTIUSER.md) e no checklist de deploy.

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

## 4B. Subir com Docker Compose + Traefik (HTTPS local)

O `docker-compose.yml` já inclui um **Traefik embutido** na mesma rede do app, com HTTPS de verdade via uma **CA local própria** (`certs/`). Serve para desenvolvimento e uso na LAN sem o aviso de "conexão não segura" no celular/navegador.

Como funciona:
- Traefik escuta em `:80` (redireciona tudo para HTTPS), `:443` (HTTPS com certificado local) e `:8080` (dashboard, sem auth — LAN de dev apenas)
- O roteamento é **estático, por arquivo** (`traefik/dynamic.yml`) — nenhum `docker.sock` exposto
- O certificado cobre `transcreveai.local`, `transcreveai.localhost`, `localhost`, `192.168.1.3` e `127.0.0.1` e é assinado pela CA em `certs/rootCA.pem`

Passos:

1. **Confie na CA local em cada dispositivo que for acessar** (senão o navegador avisa):
   - **Windows (Chrome/Edge):** dê duplo clique em `certs/rootCA.pem` → *Instalar Certificado* → **Máquina Local** → colocar em *Autoridades de Certificação Raiz Confiáveis* → concluir (aceite o prompt de admin). Pelo store só do usuário o Chromium **não** confia.
   - **Android (ex. acessar do celular na mesma Wi-Fi):** envie `certs/rootCA.pem` para o aparelho → *Configurações → Segurança → Mais configurações de segurança → Instalar certificado → Certificado da CA* → selecione o arquivo.
2. Suba os dois serviços:
   ```bash
   docker compose up -d
   ```
3. Acesse `https://192.168.1.3` (ou `https://transcreveai.local` se apontar esse nome no `hosts` da máquina cliente para o IP do servidor). O acesso direto em `http://192.168.1.3:3000` continua existindo para depuração.

Renovando os certificados (a CA dura 10 anos, o leaf 5):

```bash
openssl req -x509 -new -nodes -key certs/rootCA-key.pem -sha256 -days 3650 \
  -out certs/rootCA.pem -subj "/CN=Falou.ai Local CA" \
  -addext "basicConstraints=critical,CA:TRUE" -addext "keyUsage=critical,keyCertSign,cRLSign"
openssl req -new -key certs/transcreveai-key.pem -out /tmp/leaf.csr -subj "/CN=transcreveai.local"
openssl x509 -req -in /tmp/leaf.csr -CA certs/rootCA.pem -CAkey certs/rootCA-key.pem \
  -CAcreateserial -out certs/transcreveai-cert.pem -days 1825 -sha256 \
  -extfile <(echo "subjectAltName=DNS:transcreveai.local,DNS:transcreveai.localhost,DNS:localhost,IP:192.168.1.3,IP:127.0.0.1
basicConstraints=CA:FALSE
keyUsage=digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth")
docker compose restart traefik
```

> **Atenção:** `certs/rootCA-key.pem` é a chave privada da sua CA — quem a tiver pode assinar certificados que o seu navegador confia. Está no `.gitignore` de propósito; nunca committe a pasta `certs/`.

### Portainer + swarm (KVM2/ORION, rede PegazusNet + Traefik externo) — trilha de produção

É o caminho usado no deploy oficial. A imagem
`ghcr.io/pedroleondev/falou-ai:latest` (GitHub Container Registry — privada,
só sua conta puxa) é publicada automaticamente a cada push na `main`
(GitHub Actions, `.github/workflows/docker-publish.yml`). Autenticação é
automática via `GITHUB_TOKEN`: **nenhuma conta externa, nenhum secret manual**.

**Uma vez, no GitHub (para o Portainer puxar a imagem privada):**
1. GitHub → seu avatar → Settings → Developer settings → Personal access
   tokens → Tokens (classic) → Generate new token → marque **somente**
   `read:packages` → Generate → **copie o token** (só aparece 1x).
2. Portainer → Registries → Add registry → **Custom**:
   - Name: `ghcr`
   - Registry URL: `ghcr.io`
   - Username: `pedroleondev`
   - Password: o token do passo 1

Pronto — o Portainer agora autentica no depósito privado do GitHub.

**Uma vez, no manager do swarm:**
```bash
docker volume create falou_uploads
docker volume create falou_pgdata
# PegazusNet já existe no ORION; se não existir:
docker network create --driver overlay PegazusNet
```

**No Portainer:** Stacks → Add stack → cole o conteúdo de
`deploy/portainer-stack.yml` e preencha as variáveis no editor de env:

| Variável | O que é |
|---|---|
| `FALOU_DOMAIN` | domínio público, ex: `falou.pegazus.tech` (A/AAAA apontado pro KVM2) |
| `JWT_SECRET` / `APP_SECRET_KEY` | aleatórios longos (guarde o `APP_SECRET_KEY` — cifra a chave OpenRouter no banco) |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | do primeiro admin (seed único; mín. 8 chars) |
| `OPENROUTER_API_KEY` | seed da 1ª chave do pool; as demais entram pelo painel admin |
| `FALOU_DB_PASSWORD` | senha interna do postgres (não exposta fora da rede) |
| `ASAAS_API_KEY` / `ASAAS_API_URL` / `ASAAS_WEBHOOK_TOKEN` | produção: key de `www.asaas.com` + token configurado no painel Asaas (Webhooks → URL `https://SEU_DOMINIO/api/webhooks/asaas`) |
| `SMTP_*` | e-mail transacional; sem ele o cadastro público fica fechado (503) |

**Depois do deploy:** acesse `https://SEU_DOMINIO/app`, faça login com o admin
do seed, cadastre as chaves do pool OpenRouter (aba **Chaves OpenRouter API**),
ajuste o custo unitário em **Uso & Custos** e teste uma transcrição real.

**Backup em produção** (agende no host, ex. cron diário):
```bash
docker exec $(docker ps -q -f name=falou_db) pg_dump -U falou -Fc falou > backup_falou_$(date +%F).dump
docker run --rm -v falou_uploads:/data -v $PWD:/backup alpine tar czf /backup/falou_uploads_$(date +%F).tar.gz -C /data .
```

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

**Troque essa senha imediatamente** — a UI de troca de senha *pelo próprio usuário* ainda não existe (ver [TASKS.md](TASKS.md) T-09); enquanto isso, um admin pode redefinir a senha de qualquer conta em **Painel SaaS Admin → Usuários → Resetar senha** (T-23), e a criação de novos usuários/admins também é feita nessa aba. Até lá, trate esse admin default como uma credencial temporária de instalação, não como a conta real de uso.

A chave da OpenRouter que você colocou no `.env` é importada **uma única vez** no primeiro boot: o sistema cifra (AES-256-GCM, com `APP_SECRET_KEY`) e grava no SQLite. A partir daí o banco é a fonte de verdade e o `.env` pode ficar sem `OPENROUTER_API_KEY`.

Para conferir, trocar ou cadastrar uma chave, use a **sidebar → CONFIGURAR CHAVE** (ou **Admin → Chaves de API**):

1. Cole a chave (campo protegido, com botão de mostrar/ocultar)
2. Clique em **Testar chave** — o sistema valida contra a OpenRouter (`GET /api/v1/auth/key`, sem gastar crédito) e mostra limite/disponível
3. Digite a **senha do administrador** e salve — só é possível salvar após um teste OK

A chave nunca é devolvida pela API: a interface mostra apenas a versão mascarada (`sk-or-v1-…abcd`). Troca exige a senha do admin autenticado; 5 senhas erradas em 10 minutos bloqueiam o IP temporariamente.

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
| Segredos (JWT, OpenRouter) + chave-mestra de cifra | `.env` (`JWT_SECRET`, `OPENROUTER_API_KEY`, `APP_SECRET_KEY`) | Guardar em um cofre de senhas — **nunca** commitar. Sem `APP_SECRET_KEY`, a chave OpenRouter cifrada no banco é **irrecuperável** |

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

## 9. Cobrança recorrente via Asaas (opcional — T-27)

O sistema monetiza sozinho: o usuário escolhe Bronze, Prata ou Ouro no botão
**Fazer upgrade**, paga a fatura (PIX, boleto ou cartão) e o plano é liberado
**automaticamente** pelo webhook. Atraso suspende a conta (dados intactos);
cancelamento volta ao plano gratuito.

**Sem configurar nada**, a plataforma roda normal com os botões de assinatura
em "Em breve". Para ligar a cobrança:

1. Crie a conta no [Asaas](https://www.asaas.com) e gere a chave de API
   (Integrações → API). Para testar sem dinheiro real, use o
   [ambiente sandbox](https://sandbox.asaas.com) — a API é a mesma, só a URL muda.
2. No `.env`:

```dotenv
ASAAS_API_KEY=$aact_sua_chave_aqui
ASAAS_API_URL=https://sandbox.asaas.com/api/v3   # produção: https://www.asaas.com/api/v3
ASAAS_WEBHOOK_TOKEN=gere_um_valor_aleatorio
```

3. No painel do Asaas (Webhooks), aponte para
   `https://seu-dominio/api/webhooks/asaas` usando o **mesmo** token do passo 2.
4. `docker compose up -d transcreveai` (as novas variáveis exigem recreate).

**Importante:** em `NODE_ENV=production` o servidor **recusa subir** sem
`ASAAS_WEBHOOK_TOKEN` (o webhook é a alma da cobrança). Para desenvolver
localmente sem cobrança, defina `BILLING_STRICT=false` no `.env`.

Preços e cotas (R$ / transcrições por dia) ficam em `system_settings` — o
admin ajusta no painel (Configurações) sem tocar em código. Defaults:
bronze R$ 19,90/mês (15/dia), prata R$ 49,90 (60/dia), ouro R$ 99,90
(ilimitado); anual com ~2 meses de desconto.

## 10. Solução de problemas comuns

| Sintoma | Causa provável | Solução |
|---|---|---|
| `ffmpeg: not found` nos logs, todas as transcrições falham | Mexeu no `Dockerfile` mas só rodou `restart` | `docker compose build && docker compose up -d` |
| Porta 3000 já em uso | Outro serviço na mesma porta | Mude `PORT` no `.env` e o mapeamento `ports:` no `docker-compose.yml` |
| Login com `admin123` não funciona mais | Você já trocou a senha (correto!) | Use a nova senha, ou restaure o backup do `turboscribe.sqlite` se perdeu a credencial |
| `SQLITE_BUSY` sob uso simultâneo | Banco sem WAL, limitação conhecida | Ver [MULTIUSER.md](MULTIUSER.md) R-02 e [TASKS.md](TASKS.md) T-08 |
| Servidor recusa subir com `APP_SECRET_KEY` (produção) | Variável ausente ou com < 32 chars | Gere um valor aleatório (seção 3). **Atenção:** se o banco já tem chave cifrada com outro segredo, recadastre a chave OpenRouter pela sidebar após subir |
| Transcrições falham com "Nao foi possivel decifrar o segredo" | `APP_SECRET_KEY` do `.env` foi trocada sem recifrar o banco | Restaure o valor anterior (backup) ou recadastre a chave OpenRouter em **sidebar → CONFIGURAR CHAVE** |
| Traefik não roteia para o serviço | Rede diferente entre Traefik e o container | Confirme que ambos estão na mesma rede Docker (`docker network inspect`) |

## Ver também
- [../README.md](../README.md) — visão geral do projeto
- [product.md](product.md) · [stack.md](stack.md) · [system_design.md](system_design.md)
- [MULTIUSER.md](MULTIUSER.md) — antes de convidar mais de uma pessoa para usar
- [../pipeline.md](../pipeline.md) — Git Flow e detalhe do pipeline de transcrição
