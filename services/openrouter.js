const fetch = require('node-fetch');
const FormData = require('form-data');
const fs = require('fs');
const { getAsync } = require('../db');

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
 * Obtém a chave ativa do OpenRouter no banco de dados SQLite
 */
async function getActiveOpenRouterKey() {
  try {
    const row = await getAsync(`SELECT key_value FROM api_keys WHERE provider = 'openrouter' AND is_active = 1 LIMIT 1`);
    if (row && row.key_value) {
      return row.key_value;
    }
  } catch (err) {
    console.warn('[OpenRouter] Erro ao buscar chave ativa do banco SQLite:', err.message);
  }
  return process.env.OPENROUTER_API_KEY || '';
}

/**
 * Mapeia o modo selecionado para o modelo OpenRouter equivalente ou aceita ID direto
 */
async function resolveWhisperModel(modeOrModelId) {
  if (modeOrModelId && modeOrModelId.includes('/')) {
    return modeOrModelId; // Se o usuário enviou um model ID direto (ex: openai/whisper-large-v3)
  }

  switch (modeOrModelId) {
    case 'chita':
      return 'openai/whisper-1';
    case 'golfinho':
      return 'openai/whisper-large-v3-turbo';
    case 'baleia':
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

async function transcribeAudioFile(filePath, language = 'pt', modeOrModelId = 'openai/whisper-large-v3', opts = {}) {
  const apiKey = await getActiveOpenRouterKey();
  const primaryModel = await resolveWhisperModel(modeOrModelId);
  const promptText = opts.prompt || DEFAULT_PROMPT_PTBR;

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
      formData.append('language', language || 'pt');
      formData.append('response_format', 'verbose_json');
      // temperature 0 + prompt reduzem drasticamente alucinações do Whisper em silêncio/ruído
      formData.append('temperature', '0');
      formData.append('prompt', promptText);

      const response = await fetch('https://openrouter.ai/api/v1/audio/transcriptions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'HTTP-Referer': 'http://localhost:3000',
          'X-Title': 'TurboScribe Local SaaS',
          ...formData.getHeaders()
        },
        body: formData
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

        if (segments.length === 0 && data.text) {
          segments.push({
            speaker: 'Locutor 1',
            start: 0,
            end: data.duration || 10,
            text: data.text.trim()
          });
        }

        return {
          model_used: model,
          text: data.text ? data.text.trim() : '',
          segments: segments,
          duration: data.duration || (segments.length ? segments[segments.length - 1].end : 0)
        };
      } else {
        const errText = await response.text();
        console.warn(`[OpenRouter Warning] Modelo ${model} retornou HTTP ${response.status}: ${errText}`);
        lastError = new Error(`OpenRouter HTTP ${response.status}: ${errText}`);
      }
    } catch (err) {
      console.warn(`[OpenRouter Error] Erro ao tentar modelo ${model}: ${err.message}`);
      lastError = err;
    }
  }

  throw lastError || new Error('Não foi possível obter transcrição via OpenRouter API.');
}

/**
 * Chamada para Chat / ChatGPT via OpenRouter (Resumo e Perguntas sobre o Áudio)
 */
async function generateChatCompletion(transcriptText, prompt) {
  const apiKey = await getActiveOpenRouterKey();

  const systemMessage = {
    role: 'system',
    content: 'Você é o assistente inteligente do TurboScribe. Seu trabalho é ajudar o usuário analisando a transcrição fornecida, resumindo pontos chave, tirando dúvidas ou extraindo ações. Responda sempre em Português do Brasil (PT-BR) de forma profissional, direta e clara.'
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
        'X-Title': 'TurboScribe Local SaaS'
      },
      body: JSON.stringify({
        model: 'openai/gpt-4o-mini',
        messages: [systemMessage, userMessage],
        temperature: 0.3
      })
    });

    if (response.ok) {
      const data = await response.json();
      return data.choices && data.choices[0] ? data.choices[0].message.content : 'Sem resposta do modelo.';
    } else {
      const errText = await response.text();
      throw new Error(`OpenRouter Chat HTTP ${response.status}: ${errText}`);
    }
  } catch (error) {
    console.error('[OpenRouter Chat Error]', error);
    throw error;
  }
}

/**
 * Tradução de Transcrição via OpenRouter
 */
async function translateTranscript(transcriptText, targetLanguage = 'English') {
  const apiKey = await getActiveOpenRouterKey();

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
        'X-Title': 'TurboScribe Local SaaS'
      },
      body: JSON.stringify({
        model: 'openai/gpt-4o-mini',
        messages: [systemMessage, { role: 'user', content: transcriptText }],
        temperature: 0.2
      })
    });

    if (response.ok) {
      const data = await response.json();
      return data.choices && data.choices[0] ? data.choices[0].message.content : 'Falha na tradução.';
    } else {
      const errText = await response.text();
      throw new Error(`OpenRouter Translate HTTP ${response.status}: ${errText}`);
    }
  } catch (error) {
    console.error('[OpenRouter Translate Error]', error);
    throw error;
  }
}

module.exports = {
  getAvailableOpenRouterModels,
  transcribeAudioFile,
  generateChatCompletion,
  translateTranscript
};
