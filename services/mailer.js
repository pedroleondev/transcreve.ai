// Serviço de e-mail transacional (T-28) — SMTP via nodemailer.
//
// Configuração por .env:
//   SMTP_HOST, SMTP_PORT (default 587), SMTP_USER, SMTP_PASS,
//   SMTP_SECURE=true somente para porta 465,
//   MAIL_FROM (default "TurboScribe <no-reply@turboscribe.local>"),
//   PUBLIC_BASE_URL (link da landing/app usado nos e-mails; default http://localhost:3000)
//
// Regra de honestidade (aceite T-28): sem SMTP configurado, em produção
// (NODE_ENV=production) NENHUM e-mail é enviado e o cadastro deve recusar
// (503). Fora de produção, a mensagem vai para o log do servidor — fluxo
// completo testável sem custo.

const nodemailer = require('nodemailer');

const isProduction = process.env.NODE_ENV === 'production';

function smtpConfigured() {
  return Boolean((process.env.SMTP_HOST || '').trim());
}

let transporter = null;
if (smtpConfigured()) {
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: process.env.SMTP_SECURE === 'true',
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
  });
} else if (isProduction) {
  console.warn('[mailer] ATENÇÃO: SMTP não configurado em produção — cadastro público será recusado (503) a menos que REGISTRATION_REQUIRES_SMTP=false (self-host local; o link vai para o log do servidor).');
}

const FROM = (process.env.MAIL_FROM || 'TurboScribe <no-reply@turboscribe.local>').trim();
const BASE_URL = (process.env.PUBLIC_BASE_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/$/, '');

// Envia o e-mail de confirmação de cadastro. Retorna { delivered: boolean }.
// Sem SMTP em ambiente de desenvolvimento, imprime o link no log (custo zero).
async function sendVerificationEmail(to, name, token) {
  const confirmUrl = `${BASE_URL}/app?confirm_token=${encodeURIComponent(token)}`;
  const subject = 'Confirme seu cadastro — TurboScribe';
  const text = [
    `Olá, ${name}!`,
    '',
    'Você criou uma conta no TurboScribe. Confirme seu e-mail para ativar a conta (válido por 30 minutos):',
    '',
    confirmUrl,
    '',
    'Se não foi você, ignore este e-mail.',
  ].join('\n');

  if (!transporter) {
    if (isProduction) return { delivered: false };
    console.log(`[mailer:dev] Confirmação para ${to} (token ${token}): ${confirmUrl}`);
    return { delivered: false };
  }
  await transporter.sendMail({ from: FROM, to, subject, text });
  return { delivered: true };
}

module.exports = { smtpConfigured, sendVerificationEmail, BASE_URL };
