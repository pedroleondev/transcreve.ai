const nodeFetch = require('node-fetch');
const { getJobSignal, jobSleep } = require('./job-context');
const fetch = (url, options = {}) => nodeFetch(url, { ...options, signal: getJobSignal() || options.signal });
const FormData = require('form-data');
const fs = require('fs');
const { getAsync, allAsync } = require('../db');
const secrets = require('./secrets');

// ---------------------------------------------------------------------------
// Provedor MOCK — so para testar a mecanica do pipeline (paralelismo, retry,
// retomada) sem gastar credito. Explicito por env, recusado em producao, e todo
// texto sai prefixado com [MOCK] para nunca ser confundido com transcricao real.
//   TRANSCRIBE_PROVIDER=mock
//   MOCK_LATENCY_MS=300      tempo simulado por bloco
//   MOCK_FAIL_ONCE=12        bloco 12 falha com 429 na 1a tentativa (testa retry)
//   MOCK_FAIL_ALWAYS=30      bloco 30 falha sempre com 400 (testa falha definitiva)
// ---------------------------------------------------------------------------
const MOCK_ENABLED = process.env.TRANSCRIBE_PROVIDER === 'mock';
if (MOCK_ENABLED && process.env.NODE_ENV === 'production') {
  throw new Error('TRANSCRIBE_PROVIDER=mock e proibido com NODE_ENV=production.');
}
if (MOCK_ENABLED) {
  console.warn('[OpenRouter] *** PROVEDOR MOCK ATIVO — nenhuma transcricao real sera feita ***');
}
const mockFailedOnce = new Set();

async function mockTranscribe(filePath, opts = {}) {
  const idx = Number.isInteger(opts.chunkIndex) ? opts.chunkIndex : 0;
  const failOnce = process.env.MOCK_FAIL_ONCE !== undefined ? Number(process.env.MOCK_FAIL_ONCE) : null;
  const failAlways = process.env.MOCK_FAIL_ALWAYS !== undefined ? Number(process.env.MOCK_FAIL_ALWAYS) : null;
  const latency = Number(process.env.MOCK_LATENCY_MS || 300);

  await jobSleep(latency);

  if (failAlways === idx) {
    throw new Error('OpenRouter HTTP 400: [MOCK] falha definitiva simulada');
  }
  if (failOnce === idx && !mockFailedOnce.has(idx)) {
    mockFailedOnce.add(idx);
    throw new Error('OpenRouter HTTP 429: [MOCK] rate limit simulado');
  }

  let duration = opts.durationHint || 0;
  if (!duration) {
    try { duration = (await require('./audio').probeMedia(filePath)).duration; } catch (_) { duration = 30; }
  }
  const segments = [];
  for (let t = 0; t < duration; t += 5) {
    segments.push({
      speaker: 'Locutor 1',
      start: t,
      end: Math.min(t + 5, duration),
      text: `[MOCK bloco ${idx}] segmento ${segments.length + 1}`
    });
  }
  return {
    model_used: 'mock/transcriber',
    text: segments.map(s => s.text).join(' '),
    segments,
    duration,
    detected_language: process.env.MOCK_DETECTED_LANGUAGE || opts.languageHint || 'pt'
  };
}

/**
 * Catálogo de Modelos da OpenRouter para Transcrição de Áudio
 * Preços em USD por minuto de áudio e nível de precisão técnica para Português do Brasil (PT-BR)
 */
const OPENROUTER_TRANSCRIPTION_MODELS = [
  {
    id: 'openai/whisper-large-v3',
    name: 'OpenAI Whisper Large v3',
    provider: 'OpenAI',
    price_per_minute_usd: 0.006,
    precision_rating: 5.0,
    precision_percentage: '99.2%',
    description: 'Maior acurácia do mercado. Recomendado para sotaques brasileiros, jargões técnicos e nomes próprios.',
    recommended: true,
    tag: 'Recomendado PT-BR ⭐'
  },
  {
    id: 'openai/whisper-large-v3-turbo',
    name: 'OpenAI Whisper Large v3 Turbo',
    provider: 'OpenAI',
    price_per_minute_usd: 0.003,
    precision_rating: 4.8,
    precision_percentage: '97.8%',
    description: 'Ultra veloz com excelente nível de precisão. Metade do preço do Large v3.',
    recommended: false,
    tag: 'Rápido & Econômico ⚡'
  },
  {
    id: 'openai/whisper-1',
    name: 'OpenAI Whisper 1',
    provider: 'OpenAI',
    price_per_minute_usd: 0.006,
    precision_rating: 4.5,
    precision_percentage: '96.5%',
    description: 'Modelo clássico de áudio da OpenAI. Ótimo para áudios curtos e conversas simples.',
    recommended: false,
    tag: 'Padrão OpenAI'
  },
  {
    id: 'google/gemini-2.0-flash-001',
    name: 'Google Gemini 2.0 Flash (Audio Multimodal)',
    provider: 'Google',
    price_per_minute_usd: 0.002,
    precision_rating: 4.9,
    precision_percentage: '98.5%',
    description: 'Modelo Multimodal do Google. Custo extremamente baixo e altíssima compreensão contextual.',
    recommended: false,
    tag: 'Ultra Barato 💡'
  }
];

function getAvailableOpenRouterModels() {
  return OPENROUTER_TRANSCRIPTION_MODELS;
}

/**
 * T-35: POOL de chaves OpenRouter do dono — N chaves ativas com round-robin
 * e circuit breaker por chave. Falhas 429/5xx/de rede abrem o disjuntor da
 * chave por POOL_COOLDOWN_MS e o tráfego migra para as chaves saudáveis.
 *
 * acquireOpenRouterKey() devolve { id, key } — o id é devolvido em
 * releaseOpenRouterKey(id, error) para o breaker aprender com o resultado.
 *
 * Regra anti-mascaramento do T-15 mantida: sem chave ativa E sem ambiente,
 * erro EXPLICITO (nunca fallback silencioso). Pool esgotado (todas em
 * cooldown) também é erro explícito — o dono precisa saber, não dormir no erro.
 */
const POOL_MAX_FAILURES = 3;
const POOL_FAILURE_WINDOW_MS = 2 * 60 * 1000;
const POOL_COOLDOWN_MS = 2 * 60 * 1000;
const keyHealth = new Map(); // key_id -> { failures: [ts], cooldownUntil: 0 }
let poolCursor = 0;

function poolRegisterFailure(id) {
  const now = Date.now();
  const h = keyHealth.get(id) || { failures: [], cooldownUntil: 0 };
  h.failures = [...h.failures.filter(t => now - t < POOL_FAILURE_WINDOW_MS), now];
  if (h.failures.length >= POOL_MAX_FAILURES) {
    h.cooldownUntil = now + POOL_COOLDOWN_MS;
    h.failures = [];
    console.warn(`[Pool] Chave ${id} em cooldown por ${POOL_COOLDOWN_MS / 60000} min após ${POOL_MAX_FAILURES} falhas.`);
  }
  keyHealth.set(id, h);
}

function poolRegisterSuccess(id) {
  keyHealth.delete(id); // saudável de novo — histórico zera
}

function isKeyCoolingDown(id) {
  const h = keyHealth.get(id);
  return !!h && Date.now() < h.cooldownUntil;
}

async function acquireOpenRouterKey() {
  const rows = await allAsync(
    `SELECT id, key_value FROM api_keys WHERE provider = 'openrouter' AND is_active = TRUE ORDER BY created_at ASC`
  );
  if (!rows.length) {
    // Compat: banco ainda sem chave — usa o ambiente. No boot, o seed one-shot
    // grava essa chave cifrada no banco e ela passa a ser a fonte de verdade.
    const envKey = process.env.OPENROUTER_API_KEY || '';
    if (!envKey) {
      throw new Error('Nenhuma chave OpenRouter ativa no pool. Cadastre uma no painel admin (Chaves de API).');
    }
    return { id: null, key: envKey };
  }
  const available = rows.filter(r => !isKeyCoolingDown(r.id));
  if (!available.length) {
    throw new Error('Pool de chaves OpenRouter temporariamente indisponível: todas em cooldown após falhas 429/5xx. Aguarde alguns minutos ou cadastre outra chave.');
  }
  poolCursor = (poolCursor + 1) % available.length;
  const chosen = available[poolCursor];
  return { id: chosen.id, key: secrets.decrypt(chosen.key_value) };
}

function releaseOpenRouterKey(id, error) {
  if (!id) return;
  if (!error) return poolRegisterSuccess(id);
  // Só falha DE POOL: 429/5xx da API ou quebra de rede. Erro 400 de um
  // modelo específico (ex.: modelo sem suporte a palavra) não contamina a chave.
  if (/HTTP (429|5\d\d)/.test(error.message) || /fetch failed|timeout|ECONN|ETIMEDOUT|EAI_AGAIN/i.test(error.message)) {
    poolRegisterFailure(id);
  }
}

// Mantido para compatibilidade com o status/test das rotas admin (leitura única).
async function getActiveOpenRouterKey() {
  const row = await getAsync(`SELECT key_value FROM api_keys WHERE provider = 'openrouter' AND is_active = TRUE LIMIT 1`);
  if (row && row.key_value) return secrets.decrypt(row.key_value);
  return process.env.OPENROUTER_API_KEY || '';
}

/**
 * Valida uma chave contra a OpenRouter sem gastar credito (GET /auth/key).
 * @returns {Promise<{valid: boolean, status: number, info: object|null, error: string|null}>}
 */
async function testOpenRouterKey(apiKey) {
  try {
    const response = await fetch('https://openrouter.ai/api/v1/auth/key', {
      headers: { 'Authorization': `Bearer ${apiKey}` },
      timeout: 15000
    });
    if (!response.ok) {
      return { valid: false, status: response.status, info: null, error: response.status === 401 ? 'Chave invalida ou revogada.' : `OpenRouter respondeu HTTP ${response.status}.` };
    }
    const body = await response.json();
    const d = body.data || {};
    return {
      valid: true,
      status: 200,
      info: {
        label: d.label || null,
        limit: d.limit ?? null,
        usage: d.usage ?? null,
        limit_remaining: d.limit_remaining ?? null,
        is_free_tier: Boolean(d.is_free_tier)
      },
      error: null
    };
  } catch (e) {
    return { valid: false, status: 0, info: null, error: `Falha de rede ao contatar a OpenRouter: ${e.message}` };
  }
}

/**
 * Mapeia o modo selecionado para o modelo OpenRouter equivalente ou aceita ID direto
 */
async function resolveWhisperModel(modeOrModelId) {
  if (modeOrModelId && modeOrModelId.includes('/')) {
    return modeOrModelId; // Se o usuário enviou um model ID direto (ex: openai/whisper-large-v3)
  }

  switch (modeOrModelId) {
    case 'base':
      return 'openai/whisper-1';
    case 'pro':
      return 'openai/whisper-large-v3-turbo';
    case 'max':
    default:
      return 'openai/whisper-large-v3';
  }
}

/**
 * Envia o arquivo de áudio para transcrição via OpenRouter API com fallback automático de modelos
 */
const DEFAULT_PROMPT_PTBR =
  'Transcrição de uma ligação de atendimento comercial em português do Brasil sobre planos de saúde ' +
  '(Amil, Bradesco, SulAmérica, PME, adesão, co-participação, carência, boleto, cotação, corretor).';

const TRANSCRIBE_TIMEOUT_MS = Number(process.env.TRANSCRIBE_TIMEOUT_MS || 10 * 60 * 1000);

async function transcribeAudioFile(filePath, language = 'pt', modeOrModelId = 'openai/whisper-large-v3', opts = {}) {
  // T-20: 'auto' (ou vazio) = detecção automática — o campo `language` é
  // OMITIDO da chamada e o Whisper detecta. O prompt de domínio PT-BR só é
  // aplicado quando o idioma é pt: em outros idiomas ele induz vocabulário
  // errado, e em 'auto' viés de detecção para português.
  const lang = String(language || '').toLowerCase();
  const autoDetect = !lang || lang === 'auto';

  if (MOCK_ENABLED) return mockTranscribe(filePath, { ...opts, languageHint: autoDetect ? null : lang });

  const poolKey = await acquireOpenRouterKey();
  const apiKey = poolKey.key;
  const primaryModel = await resolveWhisperModel(modeOrModelId);
  const promptText = opts.prompt || (autoDetect || lang === 'pt' ? DEFAULT_PROMPT_PTBR : '');

  // Fila de modelos para tentar em ordem de prioridade
  const modelsToTry = [
    primaryModel,
    'openai/whisper-large-v3',
    'openai/whisper-large-v3-turbo',
    'openai/whisper-1'
  ].filter((v, i, a) => a.indexOf(v) === i);

  let lastError = null;

  for (const model of modelsToTry) {
    try {
      console.log(`[OpenRouter Audio API] Processando ${filePath} com modelo ${model}...`);

      const formData = new FormData();
      formData.append('file', fs.createReadStream(filePath));
      formData.append('model', model);
      if (!autoDetect) formData.append('language', lang);
      formData.append('response_format', 'verbose_json');
      // Karaoke (precisão real): pede também timestamp por PALAVRA — mesmo
      // preço por minuto da API, sem custo extra. Sem suporte do modelo, a
      // resposta simplesmente não vem com `words` e o frontend interpola.
      formData.append('timestamp_granularities[]', 'segment');
      formData.append('timestamp_granularities[]', 'word');
      // temperature 0 + prompt reduzem drasticamente alucinações do Whisper em silêncio/ruído
      formData.append('temperature', '0');
      if (promptText) formData.append('prompt', promptText);

      const response = await fetch('https://openrouter.ai/api/v1/audio/transcriptions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'HTTP-Referer': 'http://localhost:3000',
          'X-Title': 'Falou.ai Local SaaS',
          ...formData.getHeaders()
        },
        body: formData,
        timeout: TRANSCRIBE_TIMEOUT_MS
      });

      if (response.ok) {
        const data = await response.json();
        console.log(`[OpenRouter Sucesso] Modelo ${model} transcreveu com êxito!`);

        const rawSegments = data.segments || [];
        const segments = rawSegments.map((seg, idx) => ({
          speaker: seg.speaker || 'Locutor 1',
          start: seg.start !== undefined ? parseFloat(seg.start) : idx * 5,
          end: seg.end !== undefined ? parseFloat(seg.end) : (idx + 1) * 5,
          text: seg.text ? seg.text.trim() : ''
        }));

        // Karaoke: associa as palavras com tempo real a seus segmentos (cada
        // palavra vai a exatamente um segmento, na ordem). Se o modelo não
        // devolveu `words`, os segmentos ficam sem `words` e o frontend cai
        // na interpolação.
        const rawWords = Array.isArray(data.words) ? data.words : [];
        if (rawWords.length && segments.length) {
          let wi = 0;
          for (const seg of segments) {
            const ws = [];
            while (wi < rawWords.length && (rawWords[wi].start || 0) < seg.end) {
              const rw = rawWords[wi++];
              const wStart = parseFloat(rw.start) || 0;
              if (wStart >= seg.start - 0.05) {
                ws.push({ w: String(rw.word || '').trim(), s: wStart, e: parseFloat(rw.end) || wStart });
              }
            }
            if (ws.length) seg.words = ws;
          }
        }

        if (segments.length === 0 && data.text) {
          segments.push({
            speaker: 'Locutor 1',
            start: 0,
            end: data.duration || 10,
            text: data.text.trim()
          });
        }

        releaseOpenRouterKey(poolKey.id, null);
        return {
          model_used: model,
          text: data.text ? data.text.trim() : '',
          segments: segments,
          duration: data.duration || (segments.length ? segments[segments.length - 1].end : 0),
          detected_language: data.language || null
        };
      } else {
        const errText = await response.text();
        console.warn(`[OpenRouter Warning] Modelo ${model} retornou HTTP ${response.status}: ${errText}`);
        lastError = new Error(`OpenRouter HTTP ${response.status}: ${errText}`);
        releaseOpenRouterKey(poolKey.id, lastError);
      }
    } catch (err) {
      console.warn(`[OpenRouter Error] Erro ao tentar modelo ${model}: ${err.message}`);
      lastError = err;
      releaseOpenRouterKey(poolKey.id, err);
    }
  }

  throw lastError || new Error('Não foi possível obter transcrição via OpenRouter API.');
}

/**
 * Chamada para Chat / ChatGPT via OpenRouter (Resumo e Perguntas sobre o Áudio)
 */
async function generateChatCompletion(transcriptText, prompt) {
  if (MOCK_ENABLED) return `[MOCK] resposta simulada para: ${String(prompt).slice(0, 80)}`;

  const poolKey = await acquireOpenRouterKey();
  const apiKey = poolKey.key;

  const systemMessage = {
    role: 'system',
    content: 'Você é o assistente inteligente do Falou.ai. Seu trabalho é ajudar o usuário analisando a transcrição fornecida, resumindo pontos chave, tirando dúvidas ou extraindo ações. Responda sempre em Português do Brasil (PT-BR) de forma profissional, direta e clara.'
  };

  const userMessage = {
    role: 'user',
    content: `TRANSCRIÇÃO DO ÁUDIO:\n"""\n${transcriptText}\n"""\n\nPERGUNTA OU INSTRUÇÃO DO USUÁRIO:\n${prompt}`
  };

  try {
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'http://localhost:3000',
        'X-Title': 'Falou.ai Local SaaS'
      },
      body: JSON.stringify({
        model: 'openai/gpt-4o-mini',
        messages: [systemMessage, userMessage],
        temperature: 0.3
      })
    });

    if (response.ok) {
      const data = await response.json();
      releaseOpenRouterKey(poolKey.id, null);
      return data.choices && data.choices[0] ? data.choices[0].message.content : 'Sem resposta do modelo.';
    } else {
      const errText = await response.text();
      releaseOpenRouterKey(poolKey.id, new Error(`HTTP ${response.status}`));
      throw new Error(`OpenRouter Chat HTTP ${response.status}: ${errText}`);
    }
  } catch (error) {
    releaseOpenRouterKey(poolKey.id, error);
    console.error('[OpenRouter Chat Error]', error);
    throw error;
  }
}

/**
 * T-18: Análise/Aprimoramento de transcrição — chat com system prompt e modelo
 * configuráveis pelo admin. Retorna conteúdo + uso de tokens para métricas.
 * ANALYSIS_MOCK=1 (ou provedor mock) devolve resposta simulada sem custo — só para testes.
 */
const ANALYSIS_MOCK = MOCK_ENABLED || process.env.ANALYSIS_MOCK === '1';

async function runAnalysisChat({ systemPrompt, userContent, model }) {
  if (ANALYSIS_MOCK) {
    return {
      content: `[MOCK ANALYSIS] Texto aprimorado (simulado, sem custo de API).\n\n${String(userContent).slice(0, 200)}...`,
      tokens_in: 0,
      tokens_out: 0
    };
  }

  const poolKey = await acquireOpenRouterKey();
  const apiKey = poolKey.key;

  try {
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'http://localhost:3000',
        'X-Title': 'Falou.ai Local SaaS'
      },
      body: JSON.stringify({
        model: model || 'openai/gpt-4o-mini',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userContent }
        ],
        temperature: 0.2
      })
    });

    if (response.ok) {
      const data = await response.json();
      const content = data.choices && data.choices[0] ? data.choices[0].message.content : '';
      if (!content) throw new Error('Modelo retornou conteúdo vazio.');
      releaseOpenRouterKey(poolKey.id, null);
      return {
        content,
        tokens_in: data.usage ? data.usage.prompt_tokens : 0,
        tokens_out: data.usage ? data.usage.completion_tokens : 0
      };
    } else {
      const errText = await response.text();
      releaseOpenRouterKey(poolKey.id, new Error(`HTTP ${response.status}`));
      throw new Error(`OpenRouter Chat HTTP ${response.status}: ${errText}`);
    }
  } catch (error) {
    releaseOpenRouterKey(poolKey.id, error);
    console.error('[OpenRouter Analysis Error]', error);
    throw error;
  }
}

/**
 * Tradução de Transcrição via OpenRouter
 */async function translateTranscript(transcriptText, targetLanguage = 'English') {
  const poolKey = await acquireOpenRouterKey();
  const apiKey = poolKey.key;

  const systemMessage = {
    role: 'system',
    content: `Você é um tradutor profissional de alto nível. Traduza o texto a seguir fielmente para o idioma: ${targetLanguage}. Mantenha a pontuação e formatação natural.`
  };

  try {
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'http://localhost:3000',
        'X-Title': 'Falou.ai Local SaaS'
      },
      body: JSON.stringify({
        model: 'openai/gpt-4o-mini',
        messages: [systemMessage, { role: 'user', content: transcriptText }],
        temperature: 0.2
      })
    });

    if (response.ok) {
      const data = await response.json();
      releaseOpenRouterKey(poolKey.id, null);
      return data.choices && data.choices[0] ? data.choices[0].message.content : 'Falha na tradução.';
    } else {
      const errText = await response.text();
      releaseOpenRouterKey(poolKey.id, new Error(`HTTP ${response.status}`));
      throw new Error(`OpenRouter Translate HTTP ${response.status}: ${errText}`);
    }
  } catch (error) {
    releaseOpenRouterKey(poolKey.id, error);
    console.error('[OpenRouter Translate Error]', error);
    throw error;
  }
}

module.exports = {
  getAvailableOpenRouterModels,
  testOpenRouterKey,
  transcribeAudioFile,
  generateChatCompletion,
  runAnalysisChat,
  translateTranscript,
  acquireOpenRouterKey,
  releaseOpenRouterKey,
  isKeyCoolingDown
};
