const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');

function execPromise(command, opts = {}) {
  return new Promise((resolve, reject) => {
    exec(command, { maxBuffer: 1024 * 1024 * 64, ...opts }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`Command failed: ${command}\n${error.message}\n${stderr}`));
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
}

/**
 * Normaliza qualquer áudio/vídeo para o formato ideal do Whisper:
 * 16 kHz, mono, FLAC (lossless e compacto), com filtro passa-alta para
 * remover ruído de baixa frequência e loudnorm para nivelar o volume.
 * Isso reduz drasticamente as alucinações do Whisper em áudios de telefone/WhatsApp.
 *
 * @returns {Promise<{path: string, duration: number}>}
 */
async function preprocessAudio(inputPath, outputPath) {
  const filters = [
    'highpass=f=90',
    'lowpass=f=8000',
    'loudnorm=I=-16:TP=-1.5:LRA=11',
    'aresample=16000'
  ].join(',');

  await execPromise(
    `ffmpeg -y -i "${inputPath}" -vn -ac 1 -af "${filters}" -c:a flac "${outputPath}"`
  );

  let duration = 0;
  try {
    const { stdout } = await execPromise(
      `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${outputPath}"`
    );
    duration = parseFloat(stdout.trim()) || 0;
  } catch (_) { /* ignore */ }

  return { path: outputPath, duration };
}

/**
 * Detecta trechos de silêncio no áudio usando o filtro silencedetect do ffmpeg.
 * @returns {Promise<Array<{start: number, end: number}>>}
 */
async function detectSilences(inputPath, noiseDb = -32, minDuration = 0.6) {
  let stderr = '';
  try {
    const res = await execPromise(
      `ffmpeg -hide_banner -i "${inputPath}" -af "silencedetect=noise=${noiseDb}dB:d=${minDuration}" -f null -`
    );
    stderr = res.stderr;
  } catch (e) {
    stderr = e.message; // silencedetect ainda imprime no stderr mesmo em erro
  }

  const silences = [];
  let currentStart = null;
  for (const line of stderr.split('\n')) {
    const startMatch = line.match(/silence_start:\s*(-?[\d.]+)/);
    const endMatch = line.match(/silence_end:\s*(-?[\d.]+)/);
    if (startMatch) currentStart = parseFloat(startMatch[1]);
    if (endMatch && currentStart !== null) {
      silences.push({ start: Math.max(0, currentStart), end: parseFloat(endMatch[1]) });
      currentStart = null;
    }
  }
  return silences;
}

/**
 * Fatia o áudio em blocos de ~targetChunkSec, mas SEMPRE cortando dentro de um
 * trecho de silêncio (evita cortar palavras no meio). Se a detecção de silêncio
 * falhar, cai no fatiamento de duração fixa.
 *
 * @returns {Promise<Array<{path: string, offset: number}>>} chunks com offset real em segundos
 */
async function splitAudioSmart(inputPath, chunksDir, totalDuration, targetChunkSec = 600) {
  if (!fs.existsSync(chunksDir)) fs.mkdirSync(chunksDir, { recursive: true });

  if (!totalDuration || totalDuration <= targetChunkSec) {
    return [{ path: inputPath, offset: 0 }];
  }

  // Constrói pontos de corte preferencialmente no meio de silêncios
  let cutPoints = [0];
  try {
    const silences = await detectSilences(inputPath);
    let target = targetChunkSec;
    while (target < totalDuration - 30) {
      // silêncio mais próximo do alvo (dentro de uma janela de +/- 120s)
      let best = null;
      let bestDist = Infinity;
      for (const s of silences) {
        const mid = (s.start + s.end) / 2;
        const dist = Math.abs(mid - target);
        if (dist < bestDist && dist < 120 && mid > cutPoints[cutPoints.length - 1] + 60) {
          best = mid;
          bestDist = dist;
        }
      }
      const cut = best !== null ? best : target;
      cutPoints.push(Number(cut.toFixed(3)));
      target = cut + targetChunkSec;
    }
  } catch (e) {
    console.warn('[audio] Falha na detecção de silêncio, usando cortes fixos:', e.message);
    cutPoints = [0];
    for (let t = targetChunkSec; t < totalDuration; t += targetChunkSec) cutPoints.push(t);
  }
  cutPoints.push(totalDuration);

  const chunks = [];
  for (let i = 0; i < cutPoints.length - 1; i++) {
    const start = cutPoints[i];
    const end = cutPoints[i + 1];
    const outPath = path.join(chunksDir, `chunk_${String(i).padStart(3, '0')}.flac`);
    await execPromise(
      `ffmpeg -y -ss ${start} -to ${end} -i "${inputPath}" -c:a flac "${outPath}"`
    );
    chunks.push({ path: outPath, offset: start });
  }
  return chunks;
}

// Saudações/agradecimentos/encerramentos que, quando são o segmento INTEIRO,
// quase sempre são alucinação em áudio esparso — removidos independente da duração.
const ALWAYS_DROP_WHOLE = new Set([
  'tchau', 'tchau tchau', 'obrigado', 'obrigada', 'muito obrigado', 'muito obrigada',
  'brigado', 'valeu', 'ate mais', 'ate a proxima', 'amem', 'e ai', 'fui',
  'musica', 'aplausos', 'risos', 'obrigado por assistir', 'legendas pela comunidade amara org',
  'legendado pela comunidade amara org', 'inscreva se no canal', 'deixe seu like'
]);

// Frases que o Whisper costuma inventar em trechos de silêncio, respiração ou música.
const HALLUCINATION_PHRASES = new Set([
  'tchau', 'tchau tchau', 'obrigado', 'obrigada', 'muito obrigado', 'muito obrigada',
  'brigado', 'valeu', 'ate mais', 'ate a proxima', 'amem', 'e ai', 'fui',
  'hum', 'ah', 'oi', 'alo', 'uh',
  'legendas pela comunidade amara org', 'legendado pela comunidade amara org',
  'inscreva se no canal', 'deixe seu like', 'obrigado por assistir'
]);

function normalizePhrase(text) {
  return (text || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Remove segmentos que são claramente alucinações do Whisper:
 *  - texto composto só de frases da blacklist E curto (< 2.5s), ou
 *  - repetição idêntica de um vizinho, ou
 *  - só símbolos musicais / reticências.
 * Também colapsa sequências de 3+ segmentos idênticos.
 *
 * @param {Array<{start:number,end:number,text:string,speaker?:string}>} segments
 */
function filterHallucinations(segments) {
  if (!Array.isArray(segments) || segments.length === 0) return segments || [];

  const kept = [];
  let repeatCount = 0;
  let lastNorm = null;

  for (const seg of segments) {
    const raw = (seg.text || '').trim();
    const norm = normalizePhrase(raw);
    const dur = (seg.end || 0) - (seg.start || 0);

    if (!norm) continue;

    // só música / reticências
    if (/^[\s♪♫\-.…]+$/.test(raw)) continue;

    // interjeições repetidas típicas de alucinação ("E aí E aí", "Ah Ah Ah", "Hum Hum")
    if (/^((e\s*a[ií]|ah+|hum+|uh+|hmm+|ei+)[\s,.!?]*){2,}$/i.test(raw.trim())) continue;

    // repetição imediata idêntica
    if (norm === lastNorm) {
      repeatCount++;
      if (repeatCount >= 2) continue; // mantém no máx. 2 repetições seguidas
    } else {
      repeatCount = 0;
    }

    // texto todo formado por frases-clichê e segmento curto
    const words = norm.split(' ');
    const allFiller =
      HALLUCINATION_PHRASES.has(norm) ||
      words.every(w => HALLUCINATION_PHRASES.has(w)) ||
      (words.length <= 4 && HALLUCINATION_PHRASES.has(words.join(' ')));

    if (allFiller && dur < 4.0) continue;

    // segmento inteiro é só saudação/agradecimento → alucinação, remove sempre
    if (ALWAYS_DROP_WHOLE.has(norm)) continue;

    // padrão repetido dentro do mesmo segmento ("E aí E aí E aí", "Tchau. Tchau.")
    const uniqWords = new Set(words);
    if (words.length >= 2 && uniqWords.size <= 2 && [...uniqWords].every(w => HALLUCINATION_PHRASES.has(w))) continue;

    kept.push(seg);
    lastNorm = norm;
  }

  return kept.length ? kept : segments; // nunca devolve vazio
}

module.exports = {
  execPromise,
  preprocessAudio,
  detectSilences,
  splitAudioSmart,
  filterHallucinations,
};
