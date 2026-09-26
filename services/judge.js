// T-25 — JEV: Juiz de Execução e Validação do aprimoramento (T-18).
//
// Ideia: o gerador (analysis_model) produz o texto aprimorado; o JUIZ
// (judge_model, tambem OpenRouter, configuravel no painel admin) avalia o
// resultado ANTES de entregar ao usuario. Se reprovar, o gerador refaz o
// trecho com a critica do juiz (1 retry). Se continuar reprovado, entrega
// com aviso ("revisao recomendada") — nunca texto inventado.
//
// Ganho pretendido: poder trocar o gerador por um modelo mais barato sem
// cair a qualidade percebida — o juiz barato segura a porta. Custo: o juiz
// le original + candidato e responde um JSON minimo (~2x input do chunk).
//
// Mock (TRANSCRIBE_PROVIDER=mock ou ANALYSIS_MOCK=1): sem custo de API.
// MOCK_JUDGE_REJECT=1 forca reprovacao para testar o retry.

const { runAnalysisChat } = require('./openrouter');

const ANALYSIS_MOCK = process.env.TRANSCRIBE_PROVIDER === 'mock' || process.env.ANALYSIS_MOCK === '1';

// Quantas vezes o gerador refaz um chunk reprovado pelo juiz.
const JUDGE_MAX_RETRIES = 1;

const JUDGE_SYSTEM_PROMPT = `Você é um juiz de qualidade rigoroso de textos aprimorados a partir de transcrições de áudio.
Você recebe: (1) o texto ORIGINAL da transcrição, (2) o texto APRIMORADO pelo assistente e (3) um glossário de correções que deve ter sido aplicado.

Avalie APENAS estas quatro dimensões:
1. FIDELIDADE — o aprimorado não pode inventar fatos, dados, nomes ou citações que não existam no original. Rearranjo, resumo e estruturação são permitidos; conteúdo novo não é.
2. GLOSSÁRIO — se o glossário traz correções para termos presentes no original, elas devem estar aplicadas no aprimorado.
3. ESTRUTURA — o texto deve estar organizado (parágrafos coerentes, sem quebras estranhas, sem repetição de trechos).
4. IDIOMA/CONCORDÂNCIA — português correto, sem trechos em outro idioma salvo se o original estiver em outro idioma.

Responda EXCLUSIVAMENTE com um objeto JSON válido, sem texto antes ou depois, no formato:
{"approved": true ou false, "issues": ["problema 1", "problema 2"]}

Se approved for true, issues deve ser uma lista vazia. Seja exigente: qualquer invenção de conteúdo reprova automaticamente.`;

// Extrai o JSON do veredicto com tolerância a markdown/code fences ao redor.
function parseJudgeVerdict(content) {
  const text = String(content || '').trim();
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return { approved: null, issues: [`Juiz não respondeu JSON parseável: "${text.slice(0, 120)}"`] };
  try {
    const parsed = JSON.parse(match[0]);
    return {
      approved: typeof parsed.approved === 'boolean' ? parsed.approved : null,
      issues: Array.isArray(parsed.issues) ? parsed.issues.map(String) : []
    };
  } catch (_) {
    return { approved: null, issues: [`Veredicto do juiz com JSON inválido: "${match[0].slice(0, 120)}"`] };
  }
}

// Uma chamada de juiz. Em modo mock: aprova, salvo MOCK_JUDGE_REJECT=1.
async function runJudge({ original, candidate, glossary, model }) {
  if (ANALYSIS_MOCK) {
    const reject = process.env.MOCK_JUDGE_REJECT === '1';
    return {
      verdict: { approved: !reject, issues: reject ? ['mock: conteúdo reprovado para testar o retry'] : [] },
      tokens_in: 0,
      tokens_out: 0
    };
  }

  const glossaryLines = (glossary || []).map(g => `- "${g.wrong}" → "${g.correct}"`).join('\n') || '(vazio)';
  const userContent = `GLOSSÁRIO DE CORREÇÕES OBRIGATÓRIAS:\n${glossaryLines}\n\n=== TEXTO ORIGINAL ===\n${original}\n\n=== TEXTO APRIMORADO (avaliar) ===\n${candidate}`;

  const r = await runAnalysisChat({ systemPrompt: JUDGE_SYSTEM_PROMPT, userContent, model });
  const verdict = parseJudgeVerdict(r.content);
  if (verdict.approved === null) {
    // Resposta inválida do juiz não reprova o usuário: registra e segue como aprovado.
    console.error('[JEV] Veredicto inválido do juiz, tratando como aprovado:', verdict.issues[0]);
    verdict.approved = true;
  }
  return { verdict, tokens_in: r.tokens_in, tokens_out: r.tokens_out };
}

/**
 * Aprimora todos os chunks com validação do juiz.
 * chunks: [{ index, original, userContent }] — userContent já montado pelo caller
 * (buildEnhanceUserContent). generate: função (userContent) => { content, tokens_in, tokens_out }
 *
 * Retorna { results, tokensIn, tokensOut, judge, attempts }:
 *  - judge: null se desabilitado; senão { approved, issues } agregados dos chunks
 *  - attempts: maior número de tentativas de geração usado num chunk (1 = sem retry)
 */
async function enhanceWithJudge({ chunks, generate, glossary, judgeModel, judgeEnabled }) {
  const results = [];
  let tokensIn = 0, tokensOut = 0, attempts = 1;
  const allIssues = [];
  let allApproved = true;

  for (const chunk of chunks) {
    let generated = await generate(chunk.userContent);
    tokensIn += generated.tokens_in;
    tokensOut += generated.tokens_out;

    if (judgeEnabled) {
      let verdict = null;
      let judgeTokensIn = 0, judgeTokensOut = 0;
      for (let retry = 0; retry <= JUDGE_MAX_RETRIES; retry++) {
        const j = await runJudge({ original: chunk.original, candidate: generated.content, glossary, model: judgeModel });
        judgeTokensIn += j.tokens_in;
        judgeTokensOut += j.tokens_out;
        verdict = j.verdict;
        if (verdict.approved) break;
        if (retry < JUDGE_MAX_RETRIES) {
          const feedback = (verdict.issues || []).join('; ');
          const regen = await generate(
            `${chunk.userContent}\n\n---\nREGRA EXTRA DO JUIZ: sua resposta anterior foi reprovada. Corrija EXATAMENTE estes problemas e nada mais: ${feedback}`
          );
          tokensIn += regen.tokens_in;
          tokensOut += regen.tokens_out;
          generated = regen;
          attempts = Math.max(attempts, retry + 2);
        }
      }
      tokensIn += judgeTokensIn;
      tokensOut += judgeTokensOut;
      if (!verdict.approved) {
        allApproved = false;
        allIssues.push(...(verdict.issues || []).map(i => `[trecho ${chunk.index + 1}] ${i}`));
      }
    }

    results.push(generated.content);
  }

  return {
    results,
    tokensIn,
    tokensOut,
    attempts,
    judge: judgeEnabled ? { approved: allApproved, issues: allIssues } : null
  };
}

module.exports = { enhanceWithJudge, runJudge, parseJudgeVerdict, JUDGE_SYSTEM_PROMPT, JUDGE_MAX_RETRIES };
