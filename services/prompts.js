// Prompts versionados da T-18 (Análise/Aprimoramento de transcrição por IA).
// O admin pode sobrescrever o system prompt em Configurações; este arquivo é
// o PADRÃO de fábrica e a referência para o botão "Restaurar padrão".

const PROMPT_VERSION = '2026-09-23.1';

const DEFAULT_ENHANCE_SYSTEM_PROMPT = `Você é um revisor profissional de transcrições de áudio em Português do Brasil (PT-BR).

Sua tarefa é APRIMORAR a transcrição bruta recebida, aplicando nesta ordem:
1. CORREÇÃO DE PALAVRAS: corrija nomes próprios, termos técnicos, marcas e jargões conforme o DICIONÁRIO DE CORREÇÕES fornecido (quando houver). Use o contexto da frase para decidir.
2. ORTOGRAFIA E GRAMÁTICA: corrija erros ortográficos e de concordância (gênero, número, regência, crase) sem alterar o sentido.
3. PONTUAÇÃO: ajuste pontuação e capitalização para leitura fluida.
4. ESTRUTURA: organize o texto em parágrafos por assunto ou por locutor (quando identificável), preservando os carimbos de tempo [HH:MM:SS] quando fornecidos.

REGRAS:
- NÃO invente conteúdo, NÃO adicione informações que não estejam no áudio transcrito.
- NÃO resuma: o resultado deve conter TODO o conteúdo falado, só mais legível e correto.
- Se um trecho estiver inintelível, marque como [inaudível].
- Responda APENAS com o texto aprimorado, sem explicações, sem preâmbulo.`;

// Monta o conteúdo da mensagem do usuário com a transcrição e o dicionário.
function buildEnhanceUserContent(transcriptText, glossaryPairs) {
  const glossarySection = glossaryPairs && glossaryPairs.length
    ? 'DICIONÁRIO DE CORREÇÕES (forma errada → forma correta):\n' +
      glossaryPairs.map(g => `- ${g.wrong} → ${g.correct}`).join('\n') + '\n\n'
    : '';

  return `${glossarySection}TRANSCRIÇÃO BRUTA:\n"""\n${transcriptText}\n"""\n\nAprimore a transcrição seguindo as instruções do system prompt.`;
}

// Divide um texto longo em blocos de no máximo maxChars, cortando no fim de
// parágrafo/linha mais próximo para não quebrar frases no meio.
function splitTextIntoChunks(text, maxChars = 12000) {
  const clean = String(text || '');
  if (clean.length <= maxChars) return clean.trim() ? [clean] : [];

  const chunks = [];
  let rest = clean;
  while (rest.length > maxChars) {
    let cut = rest.lastIndexOf('\n\n', maxChars);
    if (cut < maxChars * 0.5) cut = rest.lastIndexOf('\n', maxChars);
    if (cut < maxChars * 0.5) cut = rest.lastIndexOf('. ', maxChars);
    if (cut < maxChars * 0.5) cut = maxChars;
    chunks.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

module.exports = {
  PROMPT_VERSION,
  DEFAULT_ENHANCE_SYSTEM_PROMPT,
  buildEnhanceUserContent,
  splitTextIntoChunks
};
