# Falou.ai — API pública v1 (T-30)

API para automações (n8n, Make, scripts, LLMs). Cada usuário gera **uma chave
pessoal** na aba **Conta → Chave de API** e a usa no header `Authorization`.
O consumo cai na **cota do próprio usuário** (mesmo limite diário da interface).

Não há BYOK: as transcrições saem do **pool de chaves centrais do dono**
(T-35, balanceamento round-robin com circuit breaker). A chave do usuário é
só credencial de acesso — nunca toca a OpenRouter.

## Base URL

```
https://<seu-dominio>/api/v1
```

Localmente: `http://localhost:3000/api/v1`.

## Autenticação

Todas as rotas v1 exigem:

```
Authorization: Bearer fk_live_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

- Formato: `fk_live_` + 48 caracteres hex.
- 401 sem chave, chave malformada ou revogada.
- 403 se a conta estiver suspensa.
- Uma chave ativa por usuário. Regenerar revoga a anterior imediatamente.

## Cota (headers em toda resposta v1)

| Header | Significado |
|---|---|
| `X-RateLimit-Limit` | Limite de transcrições (24 h) |
| `X-RateLimit-Used` | Já usadas |
| `X-RateLimit-Remaining` | Restantes |

Esgotada a cota, a criação responde **429** e não consome nada.

---

## POST /api/v1/transcriptions

Cria uma transcrição. Consome 1 crédito por arquivo.

### multipart/form-data (upload direto)

Campo do arquivo: `files` (aceita múltiplos arquivos, como a interface).
Opcionais: `mode` (`base` | `pro` | `max`, padrão `max`), `language`
(`auto` ou ISO-639-1: `pt`, `en`, `es`…), `callback_url`.

```bash
curl -X POST http://localhost:3000/api/v1/transcriptions \
  -H "Authorization: Bearer fk_live_..." \
  -F "files=@/caminho/audio.mp3" \
  -F "mode=max" \
  -F "language=pt" \
  -F "callback_url=https://seu-n8n/webhook/xyz"
```

Resposta **202**:

```json
{
  "count": 1,
  "data": [{ "id": "uuid", "file_name": "audio.mp3", "status": "pending", "progress": 0, "duration_seconds": 123.4 }],
  "errors": []
}
```

### application/json (link)

```bash
curl -X POST http://localhost:3000/api/v1/transcriptions \
  -H "Authorization: Bearer fk_live_..." \
  -H "Content-Type: application/json" \
  -d '{ "url": "https://exemplo.com/audio.mp3", "mode": "max", "language": "auto", "callback_url": "https://seu-n8n/webhook/xyz" }'
```

Aceita links diretos de áudio/vídeo (mp3, wav, m4a, mp4, mkv…). O arquivo é
baixado pelo servidor. Se o download falhar, responde **202** com
`status: "failed"` e `error_message` (o job fica registrado para auditoria).

---

## GET /api/v1/transcriptions/:id

Status do job (com posição na fila e ETA quando aplicável).

```bash
curl http://localhost:3000/api/v1/transcriptions/<id> \
  -H "Authorization: Bearer fk_live_..."
```

```json
{
  "id": "uuid", "file_name": "audio.mp3", "status": "completed",
  "stage": null, "progress": 100, "duration_seconds": 123.4,
  "error_message": null, "mode": "max", "language": "auto",
  "created_at": "...", "queue_position": null, "eta_seconds": null
}
```

- Só o **dono da chave** vê os próprios jobs (404 para os demais).
- `status`: `pending` → `processing` → `completed` | `failed`.

## GET /api/v1/transcriptions/:id/text

Texto final. Responde **409** enquanto não estiver `completed`.

```json
{ "id": "uuid", "file_name": "audio.mp3", "status": "completed",
  "text": "…transcrição completa…", "summary": null,
  "duration_seconds": 123.4, "error_message": null }
```

## GET /api/v1/account

Saldo do dono da chave (para o n8n desviar o fluxo antes de gastar crédito):

```json
{ "name": "Pedro", "email": "pedro@…", "plan": "ouro", "role": "user",
  "quota": { "limit": 100, "used": 12, "remaining": 88, "exempt": false } }
```

---

## Webhooks (callback_url)

Ao concluir ou falhar **definitivamente**, o Falou.ai faz POST no
`callback_url` informado na criação:

**Headers**

```
Content-Type: application/json
X-Falou-Event: transcription.completed   | transcription.failed
X-Falou-Signature: <hmac-sha256 hex do body com seu webhook_secret>
```

**Body**

```json
{
  "event": "transcription.completed",
  "id": "uuid",
  "file_name": "audio.mp3",
  "status": "completed",
  "duration_seconds": 123.4,
  "error_message": null,
  "completed_at": "2026-10-05T16:00:00.000Z"
}
```

### Validando a assinatura (Node.js)

```js
const crypto = require('crypto');
const expected = crypto.createHmac('sha256', process.env.FALOU_WEBHOOK_SECRET)
  .update(rawBody)          // o body EXATO, antes de JSON.parse
  .digest('hex');
if (expected !== req.headers['x-falou-signature']) return res.status(401).end();
```

O `webhook_secret` é exibido **uma única vez** junto com a chave (Conta →
Chave de API). Guarde-o na variável de ambiente da sua automação.

**Retry:** 5 tentativas com backoff (0 s, 1 s, 3 s, 7 s, 15 s). Entrega é
fire-and-forget: não trava a fila de transcrição. Falha final vira log de
auditoria (`WEBHOOK_DELIVERED` / `WEBHOOK_FAILED`).

---

## Fluxo típico no n8n

1. Webhook manual (recebe o arquivo/link).
2. HTTP Request → `POST /api/v1/transcriptions` com `callback_url` apontando
   para outro Webhook do próprio n8n.
3. (opcional, assíncrono) Webhook trigger recebe `transcription.completed`.
4. Ou, síncrono: Wait + `GET /api/v1/transcriptions/:id` em loop até
   `status=completed` (max ~30 tentativas, intervalo 10 s).
5. `GET /api/v1/transcriptions/:id/text` → usar `text`.

Workflow de exemplo pronto para importar: `docs/n8n/falou-transcricao-flow.json`.
