// T-27: cobrança recorrente via Asaas (PIX, boleto e cartão no portal deles).
//
// Configuração por .env:
//   ASAAS_API_KEY        — chave da API (sandbox ou produção)
//   ASAAS_API_URL        — default https://sandbox.asaas.com/api/v3
//                          (produção: https://www.asaas.com/api/v3)
//   ASAAS_WEBHOOK_TOKEN  — token que O PAINEL DO ASAAS envia no header
//                          'asaas-access-token' a cada chamada de webhook
//
// Planos e preços vivem em system_settings (admin edita sem deploy):
//   plan_bronze_monthly / plan_bronze_annual / plan_bronze_quota
//   plan_prata_monthly  / plan_prata_annual  / plan_prata_quota
//   plan_ouro_monthly   / plan_ouro_annual   / plan_ouro_quota
// (quota = daily_limit do usuário; 999999 = ilimitado no sentido do sistema)
//
// Idempotência do webhook: cada evento só produz efeito se mudar o estado —
// receber PAYMENT_CONFIRMED 2× não duplica efeito nem histórico.

const { getAsync, allAsync, runAsync } = require('../db');

const API_KEY = (process.env.ASAAS_API_KEY || '').trim();
const API_URL = (process.env.ASAAS_API_URL || 'https://sandbox.asaas.com/api/v3').replace(/\/$/, '');
const WEBHOOK_TOKEN = (process.env.ASAAS_WEBHOOK_TOKEN || '').trim();

const PLANS = ['bronze', 'prata', 'ouro'];
const CYCLES = { monthly: 'MONTHLY', annual: 'YEARLY' };
const FREE_QUOTA = 3;

function billingEnabled() {
  return API_KEY.length > 0;
}

// Catálogo de planos: preço (R$) e cota diária lidos de system_settings.
// Defaults = proposta analisada em 02/10 a partir do custo real de API
// (R$ 2–8/usuário/mês); o admin sobrescreve no painel a qualquer momento.
const DEFAULTS = {
  plan_bronze_monthly: '19.90', plan_bronze_annual: '199.00', plan_bronze_quota: '15',
  plan_prata_monthly: '49.90', plan_prata_annual: '499.00', plan_prata_quota: '60',
  plan_ouro_monthly: '99.90', plan_ouro_annual: '999.00', plan_ouro_quota: '999999'
};

async function getPlanCatalog() {
  const rows = await allAsync(`SELECT key, value FROM system_settings WHERE key LIKE 'plan_%'`);
  const map = Object.fromEntries(rows.map(r => [r.key, r.value]));
  const catalog = {};
  for (const plan of PLANS) {
    catalog[plan] = {
      monthly: Number(map[`plan_${plan}_monthly`] ?? DEFAULTS[`plan_${plan}_monthly`]),
      annual: Number(map[`plan_${plan}_annual`] ?? DEFAULTS[`plan_${plan}_annual`]),
      quota: Number(map[`plan_${plan}_quota`] ?? DEFAULTS[`plan_${plan}_quota`])
    };
  }
  return catalog;
}

async function asaasApi(method, path, body) {
  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', access_token: API_KEY },
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = (data.errors && data.errors[0] && data.errors[0].description) || data.message || `Asaas respondeu HTTP ${res.status}`;
    throw new Error(`Asaas: ${msg}`);
  }
  return data;
}

async function ensureCustomer(user) {
  // Reaproveita customer existente (1:1 com usuário, último criado).
  const existing = await getAsync(
    `SELECT asaas_customer_id FROM subscriptions WHERE user_id = ? AND asaas_customer_id IS NOT NULL ORDER BY created_at DESC`,
    [user.id]
  );
  if (existing && existing.asaas_customer_id) return existing.asaas_customer_id;
  const customer = await asaasApi('POST', '/customers', {
    name: user.name,
    email: user.email,
    cpfCnpj: user.cpf_cnpj,
    externalReference: user.id
  });
  return customer.id;
}

// Cria a assinatura no Asaas e a linha local. Devolve a URL da 1ª fatura.
async function createSubscription(user, plan, cycle) {
  const catalog = await getPlanCatalog();
  const p = catalog[plan];
  if (!p || !PLANS.includes(plan)) throw Object.assign(new Error('Plano inválido.'), { statusHint: 400 });
  const value = cycle === 'annual' ? p.annual : p.monthly;
  if (!(value > 0)) throw Object.assign(new Error(`Preço do plano ${plan} (${cycle}) não configurado.`), { statusHint: 400 });

  const active = await getAsync(
    `SELECT id FROM subscriptions WHERE user_id = ? AND status IN ('pending','active','overdue')`,
    [user.id]
  );
  if (active) throw Object.assign(new Error('Você já tem uma assinatura. Cancele-a antes de trocar de plano.'), { statusHint: 409 });

  // O Asaas exige CPF/CNPJ no customer para gerar cobranças.
  const cpfDigits = String(user.cpf_cnpj || '').replace(/\D/g, '');
  if (cpfDigits.length !== 11 && cpfDigits.length !== 14) {
    throw Object.assign(
      new Error('Informe um CPF ou CNPJ válido no seu perfil (aba Conta) para assinar — é exigência do Asaas para emitir cobranças.'),
      { statusHint: 400 }
    );
  }

  const customerId = await ensureCustomer({ ...user, cpf_cnpj: cpfDigits });
  const nextDueDate = new Date(Date.now() + 24 * 3600 * 1000).toISOString().slice(0, 10);
  const sub = await asaasApi('POST', '/subscriptions', {
    customer: customerId,
    billingType: 'UNDEFINED', // usuário escolhe PIX/boleto/cartão na fatura
    cycle: CYCLES[cycle] || 'MONTHLY',
    value: value.toFixed(2),
    nextDueDate,
    description: `TurboScribe ${plan} (${cycle === 'annual' ? 'anual' : 'mensal'})`
  });

  const id = require('uuid').v4();
  await runAsync(
    `INSERT INTO subscriptions (id, user_id, asaas_customer_id, asaas_subscription_id, plan, cycle, status) VALUES (?, ?, ?, ?, ?, ?, 'pending')`,
    [id, user.id, customerId, sub.id, plan, cycle]
  );

  // 1ª fatura da assinatura — é onde o usuário paga (PIX/boleto/cartão).
  let invoiceUrl = null;
  try {
    const payments = await asaasApi('GET', `/subscriptions/${sub.id}/payments?status=PENDING`);
    const first = Array.isArray(payments) ? payments[0] : (payments.data && payments.data[0]);
    invoiceUrl = first ? (first.invoiceUrl || null) : null;
  } catch (_) { /* a fatura aparece na conta Asaas mesmo sem a URL */ }

  return { subscriptionId: sub.id, invoiceUrl, plan, cycle };
}

async function cancelSubscription(user) {
  const sub = await getAsync(
    `SELECT * FROM subscriptions WHERE user_id = ? AND status IN ('pending','active','overdue') ORDER BY created_at DESC`,
    [user.id]
  );
  if (!sub) throw Object.assign(new Error('Nenhuma assinatura ativa.'), { statusHint: 404 });
  if (sub.asaas_subscription_id) {
    try { await asaasApi('DELETE', `/subscriptions/${sub.asaas_subscription_id}`); } catch (_) { /* segue o cancelamento local */ }
  }
  await applyPlanToUser(user.id, 'gratuito');
  await runAsync(`UPDATE subscriptions SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [sub.id]);
  return { ok: true };
}

async function applyPlanToUser(userId, plan) {
  const catalog = await getPlanCatalog();
  const quota = plan === 'gratuito' ? FREE_QUOTA : (catalog[plan] ? catalog[plan].quota : FREE_QUOTA);
  await runAsync(`UPDATE users SET plan = ?, daily_limit = ? WHERE id = ?`, [plan, quota, userId]);
}

// Handler do webhook. Recebe o payload inteiro do Asaas. Naturalmente
// idempotente: transições só escrevem quando o estado muda.
async function handleWebhook(payload) {
  const event = payload.event;
  const payment = payload.payment || {};
  const subscriptionId = payment.subscription;

  if (['PAYMENT_CONFIRMED', 'PAYMENT_RECEIVED', 'PAYMENT_AUTHORIZED'].includes(event)) {
    if (!subscriptionId) return { ignored: true, reason: 'pagamento avulso (sem assinatura)' };
    const sub = await getAsync(`SELECT * FROM subscriptions WHERE asaas_subscription_id = ?`, [subscriptionId]);
    if (!sub) return { ignored: true, reason: 'assinatura desconhecida' };
    if (sub.status !== 'active') {
      await runAsync(`UPDATE subscriptions SET status = 'active', updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [sub.id]);
      await applyPlanToUser(sub.user_id, sub.plan);
      await runAsync(`UPDATE users SET status = 'active' WHERE id = ? AND status != 'active'`, [sub.user_id]);
    }
    return { ok: true, effect: sub.status === 'active' ? 'already-active' : 'activated' };
  }

  if (event === 'PAYMENT_OVERDUE') {
    if (!subscriptionId) return { ignored: true, reason: 'pagamento avulso' };
    const sub = await getAsync(`SELECT * FROM subscriptions WHERE asaas_subscription_id = ?`, [subscriptionId]);
    if (!sub) return { ignored: true, reason: 'assinatura desconhecida' };
    if (sub.status !== 'overdue') {
      await runAsync(`UPDATE subscriptions SET status = 'overdue', updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [sub.id]);
      await runAsync(`UPDATE users SET status = 'suspended' WHERE id = ? AND role != 'admin'`, [sub.user_id]);
    }
    return { ok: true, effect: 'suspended' };
  }

  if (event === 'SUBSCRIPTION_CANCELLED') {
    const sub = await getAsync(`SELECT * FROM subscriptions WHERE asaas_subscription_id = ?`, [subscriptionId]);
    if (!sub) return { ignored: true, reason: 'assinatura desconhecida' };
    if (sub.status !== 'cancelled') {
      await runAsync(`UPDATE subscriptions SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [sub.id]);
      await applyPlanToUser(sub.user_id, 'gratuito');
      await runAsync(`UPDATE users SET status = 'active' WHERE id = ? AND status = 'suspended' AND role != 'admin'`, [sub.user_id]);
    }
    return { ok: true, effect: 'cancelled' };
  }

  return { ignored: true, reason: `evento '${event}' sem ação` };
}

function verifyWebhookToken(headerToken) {
  if (!WEBHOOK_TOKEN) return false;
  return String(headerToken || '') === WEBHOOK_TOKEN;
}

module.exports = {
  billingEnabled, getPlanCatalog, createSubscription, cancelSubscription,
  handleWebhook, verifyWebhookToken, applyPlanToUser, PLANS, FREE_QUOTA
};
