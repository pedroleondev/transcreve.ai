// Testes unitários T-18 (sem custo de API): chunker e builder de prompt.
const assert = require('assert');
const { splitTextIntoChunks, buildEnhanceUserContent, DEFAULT_ENHANCE_SYSTEM_PROMPT, PROMPT_VERSION } = require('../services/prompts');

// 1. Texto curto = chunk único
assert.deepStrictEqual(splitTextIntoChunks('texto curto'), ['texto curto'], 'texto curto vira 1 chunk');

// 2. Texto vazio = nenhum chunk
assert.deepStrictEqual(splitTextIntoChunks(''), [], 'texto vazio não gera chunk');
assert.deepStrictEqual(splitTextIntoChunks('   '), [], 'só espaços não gera chunk');

// 3. Texto longo é dividido em blocos <= maxChars, sem perder conteúdo
const sentence = 'Esta é uma frase de teste com conteúdo suficiente para encher blocos. ';
const long = sentence.repeat(800); // ~46k chars
const chunks = splitTextIntoChunks(long, 12000);
assert(chunks.length >= 3, `texto de ${long.length} chars gerou ${chunks.length} chunks (esperado >= 3)`);
for (const c of chunks) assert(c.length <= 12000, `chunk respeita o limite: ${c.length}`);
const rejoined = chunks.join(' ');
assert(rejoined.replace(/\s+/g, ' ').includes(sentence.trim()), 'conteúdo preservado entre chunks');

// 4. Corte preferencial em quebra de parágrafo, não no meio de frase
const paragraphs = Array.from({ length: 40 }, (_, i) => `Parágrafo ${i + 1}. `.repeat(30).trim()).join('\n\n');
const pChunks = splitTextIntoChunks(paragraphs, 3000);
assert(pChunks.every(c => !c.endsWith('Par')), 'nenhum chunk termina no meio de uma palavra');

// 5. Builder inclui o dicionário quando há termos
const withGlossary = buildEnhanceUserContent('olá', [{ wrong: 'amil', correct: 'Amil' }, { wrong: 'bradesco', correct: 'Bradesco' }]);
assert(withGlossary.includes('amil → Amil'), 'builder inclui par errado→correto');
assert(withGlossary.includes('bradesco → Bradesco'), 'builder inclui segundo par');
assert(withGlossary.includes('olá'), 'builder inclui a transcrição');

// 6. Builder funciona sem dicionário
const noGlossary = buildEnhanceUserContent('olá', []);
assert(!noGlossary.includes('DICIONÁRIO'), 'sem dicionário não há seção de correções');

// 7. Prompt padrão cobre os focos do CEO: correção, concordância, estrutura
assert(/concord/.test(DEFAULT_ENHANCE_SYSTEM_PROMPT), 'prompt menciona concordância');
assert(/dicion/i.test(DEFAULT_ENHANCE_SYSTEM_PROMPT), 'prompt menciona dicionário');
assert(/estrutur/i.test(DEFAULT_ENHANCE_SYSTEM_PROMPT), 'prompt menciona estrutura');
assert(/NÃO invente/.test(DEFAULT_ENHANCE_SYSTEM_PROMPT), 'prompt proíbe inventar conteúdo');

console.log(`✅ prompts.js: 7/7 asserções PASS (versão do prompt: ${PROMPT_VERSION})`);
