// T-30: entrega de webhooks de conclusão de transcrição.
// O usuário passa callback_url na criação (API v1); ao concluir (ou falhar
// definitivamente), o Falou.ai POSTa no endpoint dele:
//   body:    { event, id, file_name, status, duration_seconds, error_message, completed_at }
//   headers: X-Falou-Event, X-Falou-Signature (HMAC-SHA256 do body com o
//            webhook_secret da chave de API — mostrado uma vez na criação)
// Retry com backoff (5 tentativas) SEM bloquear o worker da fila: a cadeia
// de retentativas roda em background; falha final vira log de auditoria.
const crypto = require('crypto');

const sleep = ms => new Promise(r => setTimeout(r, ms));

function signPayload(body, secret) {
  return crypto.createHmac('sha256', secret).update(body).digest('hex');
}

async function attemptOnce(url, body, signature, event) {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Falou-Event': event,
      'X-Falou-Signature': signature
    },
    body,
    timeout: 8000
  });
  return res.ok;
}

// Fire-and-forget: quem chama NÃO deve await (não pode segurar o worker).
function deliverWebhook({ callbackUrl, webhookSecret, payload, onLog }) {
  const body = JSON.stringify(payload);
  const signature = signPayload(body, webhookSecret);
  (async () => {
    const backoffs = [0, 1000, 3000, 7000, 15000]; // 5 tentativas
    for (let i = 0; i < backoffs.length; i++) {
      if (i > 0) await sleep(backoffs[i]);
      try {
        if (await attemptOnce(callbackUrl, body, signature, payload.event)) {
          if (onLog) await onLog(true, `entrega ok na tentativa ${i + 1}`);
          return;
        }
      } catch (_) { /* tenta de novo */ }
    }
    if (onLog) await onLog(false, 'falha em todas as 5 tentativas');
  })();
}

module.exports = { deliverWebhook, signPayload };
