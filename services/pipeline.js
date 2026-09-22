const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { runAsync, getAsync, allAsync, logAction } = require('../db');
const { createQueueWorker, positiveNumber, queuePositionSql } = require('./queue');
const { jobSleep } = require('./job-context');
const { transcribeAudioFile, generateChatCompletion } = require('./openrouter');
const { preprocessAudio, splitAudioSmart, filterHallucinations, measureMeanVolume, splitFixed } = require('./audio');

const ROOT = path.join(__dirname, '..');
const CHUNK_TARGET_SEC = Number(process.env.CHUNK_TARGET_SEC || 600);
const CHUNK_CONCURRENCY = Math.max(1, Number(process.env.CHUNK_CONCURRENCY || 3));
const CHUNK_MAX_ATTEMPTS = Math.max(1, Number(process.env.CHUNK_MAX_ATTEMPTS || 3));
const RETRY_BACKOFF_MS = [2000, 8000, 30000];
const POLL_INTERVAL_MS = 5000;
const MIN_FREE_DISK_FACTOR = 2; // original + FLAC + blocos no pico

// Guarda de qualidade: Whisper as vezes "colapsa" no meio de um bloco longo e
// devolve quase nada ("E a") para minutos de fala. Fala normal rende ~10-15
// caracteres/s; abaixo de LOW_DENSITY com audio audivel, o bloco e suspeito.
const LOW_DENSITY_CHARS_PER_SEC = Number(process.env.LOW_DENSITY_CHARS_PER_SEC || 0.5);
const SILENCE_MEAN_DB = -50;   // abaixo disso o bloco e silencio de verdade
const SUBCHUNK_SEC = 120;      // janelas menores quebram o colapso
const SUSPECT_MIN_SEC = 90;    // blocos curtos nao valem a re-transcricao

const STAGES = {
  PREPROCESSING: 'preprocessing',
  SPLITTING: 'splitting',
  TRANSCRIBING: 'transcribing',
  ASSEMBLING: 'assembling',
  ANALYZING: 'analyzing'
};

// Erros que valem nova tentativa: limite de taxa, instabilidade do provedor, rede.
function isTransientError(err) {
  const msg = String((err && err.message) || err);
  if (/HTTP (429|5\d\d)/.test(msg)) return true;
  if (/ECONNRESET|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN|ENOTFOUND|socket hang up|network timeout|request-timeout|fetch failed/i.test(msg)) return true;
  return false;
}

async function setStage(id, stage, progress) {
  await runAsync(`UPDATE transcriptions SET status = 'processing', stage = ?, progress = ? WHERE id = ?`, [stage, progress, id]);
}

async function freeDiskBytes(dir) {
  try {
    const st = await fs.promises.statfs(dir);
    return st.bfree * st.bsize;
  } catch (_) {
    return Infinity; // plataforma sem statfs: nao bloqueia
  }
}

// ---------------------------------------------------------------------------
// Etapa 1+2: pre-processa e fatia. Idempotente: se ja existem blocos no banco,
// pula direto (retomada). Blocos ficam em uploads/chunks_<id>/ ate o fim do job.
// ---------------------------------------------------------------------------
async function ensureChunks(task) {
  const existing = await allAsync(
    `SELECT * FROM transcription_chunks WHERE transcription_id = ? ORDER BY idx`, [task.id]
  );
  if (existing.length > 0) {
    const missing = existing.filter(c => c.status !== 'done' && !fs.existsSync(c.path));
    if (missing.length === 0) {
      console.log(`[Pipeline] ${task.id}: retomando com ${existing.length} bloco(s) ja fatiados.`);
      return existing;
    }
    // Arquivos de bloco sumiram (limpeza manual, outro host) — refatia do zero,
    // preservando o que ja foi transcrito.
    console.warn(`[Pipeline] ${task.id}: ${missing.length} bloco(s) sem arquivo em disco; refatiando.`);
    await runAsync(`DELETE FROM transcription_chunks WHERE transcription_id = ? AND status != 'done'`, [task.id]);
  }

  const filePath = path.join(ROOT, task.file_path);
  if (!fs.existsSync(filePath)) {
    throw new Error(`Arquivo original nao encontrado em disco: ${task.file_path}`);
  }

  const size = (await fs.promises.stat(filePath)).size;
  const free = await freeDiskBytes(path.dirname(filePath));
  if (free < size * MIN_FREE_DISK_FACTOR) {
    throw new Error(`Espaco em disco insuficiente: livre ${(free / 1e9).toFixed(1)} GB, necessario ~${(size * MIN_FREE_DISK_FACTOR / 1e9).toFixed(1)} GB`);
  }

  await setStage(task.id, STAGES.PREPROCESSING, 5);
  console.log(`[Pipeline] ${task.id}: pre-processando ${task.file_name}...`);
  const preprocessedPath = path.join(path.dirname(filePath), `pp_${task.id}.flac`);
  const pp = await preprocessAudio(filePath, preprocessedPath);
  const duration = pp.duration || 0;

  await setStage(task.id, STAGES.SPLITTING, 10);
  const chunksDir = path.join(path.dirname(filePath), `chunks_${task.id}`);
  const pieces = await splitAudioSmart(preprocessedPath, chunksDir, duration, CHUNK_TARGET_SEC);
  console.log(`[Pipeline] ${task.id}: ${Math.round(duration)}s em ${pieces.length} bloco(s).`);

  // Audio curto: splitAudioSmart devolve o proprio FLAC pre-processado como bloco unico.
  // Move para dentro de chunks_<id>/ para que a limpeza seja uniforme.
  if (pieces.length === 1 && pieces[0].path === preprocessedPath) {
    if (!fs.existsSync(chunksDir)) fs.mkdirSync(chunksDir, { recursive: true });
    const single = path.join(chunksDir, 'chunk_000.flac');
    await fs.promises.rename(preprocessedPath, single);
    pieces[0].path = single;
  } else {
    await fs.promises.unlink(preprocessedPath).catch(() => {});
  }

  const doneIdx = new Set(existing.filter(c => c.status === 'done').map(c => c.idx));
  for (let i = 0; i < pieces.length; i++) {
    if (doneIdx.has(i)) continue;
    await runAsync(
      `INSERT INTO transcription_chunks (id, transcription_id, idx, offset_sec, duration_sec, path, status)
       VALUES (?, ?, ?, ?, ?, ?, 'pending')`,
      [uuidv4(), task.id, i, pieces[i].offset, pieces[i].duration || 0, pieces[i].path]
    );
  }
  await runAsync(`UPDATE transcriptions SET duration_seconds = ? WHERE id = ?`, [duration, task.id]);

  return allAsync(`SELECT * FROM transcription_chunks WHERE transcription_id = ? ORDER BY idx`, [task.id]);
}

// ---------------------------------------------------------------------------
// Etapa 3: transcreve os blocos pendentes em paralelo (pool com limite), com
// retry por bloco. Cada bloco concluido e persistido na hora.
// ---------------------------------------------------------------------------
function textDensity(segments, durationSec) {
  const chars = segments.reduce((n, s) => n + (s.text || '').trim().length, 0);
  return durationSec > 0 ? chars / durationSec : 0;
}

// Re-transcreve um bloco suspeito em janelas fixas menores e devolve os
// segmentos mesclados (offsets relativos ao bloco). Retorna null se nao ajudou.
async function rescueChunk(task, chunk, firstResult) {
  const subDir = path.join(path.dirname(chunk.path), `rescue_${chunk.idx}`);
  try {
    const pieces = await splitFixed(chunk.path, subDir, chunk.duration_sec, SUBCHUNK_SEC);
    const merged = [];
    let model = firstResult.model_used;
    for (const p of pieces) {
      const r = await transcribeAudioFile(p.path, task.language, task.mode, {
        chunkIndex: chunk.idx, durationHint: p.duration
      });
      model = r.model_used || model;
      for (const s of r.segments || []) {
        merged.push({ speaker: s.speaker, start: s.start + p.offset, end: s.end + p.offset, text: s.text });
      }
    }
    const before = textDensity(firstResult.segments || [], chunk.duration_sec);
    const after = textDensity(merged, chunk.duration_sec);
    console.log(`[Pipeline] ${task.id}: bloco ${chunk.idx} re-transcrito em ${pieces.length} sub-blocos: densidade ${before.toFixed(2)} -> ${after.toFixed(2)} chars/s`);
    return after > before * 2 && after >= LOW_DENSITY_CHARS_PER_SEC ? { segments: merged, model_used: model } : null;
  } finally {
    await fs.promises.rm(subDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function transcribeOneChunk(task, chunk) {
  const attempt = chunk.attempts + 1;
  await runAsync(
    `UPDATE transcription_chunks SET status = 'processing', attempts = ?, started_at = CURRENT_TIMESTAMP, error = NULL WHERE id = ?`,
    [attempt, chunk.id]
  );
  try {
    let result = await transcribeAudioFile(chunk.path, task.language, task.mode, {
      chunkIndex: chunk.idx,
      durationHint: chunk.duration_sec
    });
    let segments = (result.segments || []).map(s => ({
      speaker: s.speaker, start: s.start, end: s.end, text: s.text
    }));

    // Guarda de qualidade: pouco texto num bloco longo com som = colapso do modelo?
    if (chunk.duration_sec >= SUSPECT_MIN_SEC && textDensity(segments, chunk.duration_sec) < LOW_DENSITY_CHARS_PER_SEC) {
      const meanDb = await measureMeanVolume(chunk.path);
      if (meanDb > SILENCE_MEAN_DB) {
        console.warn(`[Pipeline] ${task.id}: bloco ${chunk.idx} suspeito (${textDensity(segments, chunk.duration_sec).toFixed(2)} chars/s, volume ${meanDb.toFixed(0)} dB). Tentando sub-blocos...`);
        const rescued = await rescueChunk(task, chunk, result);
        if (rescued) {
          segments = rescued.segments;
          result = { ...result, model_used: rescued.model_used };
        } else {
          throw Object.assign(
            new Error(`sem texto reconhecivel apesar de haver audio (volume medio ${meanDb.toFixed(0)} dB); possivel colapso do modelo`),
            { definitive: true }
          );
        }
      }
    }

    await runAsync(
      `UPDATE transcription_chunks SET status = 'done', model_used = ?, segments_json = ?, finished_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [result.model_used, JSON.stringify(segments), chunk.id]
    );
    return { ok: true };
  } catch (err) {
    const transient = !err.definitive && isTransientError(err);
    const exhausted = attempt >= CHUNK_MAX_ATTEMPTS;
    const finalStatus = transient && !exhausted ? 'pending' : 'failed';
    await runAsync(
      `UPDATE transcription_chunks SET status = ?, error = ?, finished_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [finalStatus, String(err.message || err).slice(0, 500), chunk.id]
    );
    console.warn(`[Pipeline] ${task.id}: bloco ${chunk.idx} tentativa ${attempt}/${CHUNK_MAX_ATTEMPTS} falhou (${transient ? 'transitorio' : 'definitivo'}): ${err.message}`);
    return { ok: false, transient, exhausted };
  }
}

async function updateProgress(task) {
  const row = await getAsync(
    `SELECT COUNT(*) AS total, SUM(status = 'done') AS done FROM transcription_chunks WHERE transcription_id = ?`, [task.id]
  );
  const pct = row.total ? 15 + Math.round((row.done / row.total) * 75) : 15;
  await runAsync(`UPDATE transcriptions SET progress = ? WHERE id = ?`, [pct, task.id]);
}

async function transcribeChunks(task) {
  await setStage(task.id, STAGES.TRANSCRIBING, 15);

  // Bloco preso em 'processing' e resto de uma execucao interrompida: volta para a fila.
  await runAsync(
    `UPDATE transcription_chunks SET status = 'pending' WHERE transcription_id = ? AND status = 'processing'`, [task.id]
  );

  for (let round = 0; round < CHUNK_MAX_ATTEMPTS; round++) {
    const pending = await allAsync(
      `SELECT * FROM transcription_chunks WHERE transcription_id = ? AND status = 'pending' ORDER BY idx`, [task.id]
    );
    if (pending.length === 0) break;
    if (round > 0) {
      const wait = RETRY_BACKOFF_MS[Math.min(round - 1, RETRY_BACKOFF_MS.length - 1)];
      console.log(`[Pipeline] ${task.id}: ${pending.length} bloco(s) para nova tentativa em ${wait / 1000}s...`);
      await jobSleep(wait);
    }
    console.log(`[Pipeline] ${task.id}: transcrevendo ${pending.length} bloco(s), ${CHUNK_CONCURRENCY} por vez.`);

    let cursor = 0;
    const worker = async () => {
      while (cursor < pending.length) {
        const chunk = pending[cursor++];
        await transcribeOneChunk(task, chunk);
        await updateProgress(task);
      }
    };
    const results = await Promise.allSettled(Array.from({ length: Math.min(CHUNK_CONCURRENCY, pending.length) }, worker));
    const rejected = results.find(result => result.status === 'rejected');
    if (rejected) throw rejected.reason;
  }
}

// ---------------------------------------------------------------------------
// Etapa 4: monta o texto final na ordem dos blocos. Bloco que falhou vira uma
// marcacao explicita no lugar do trecho — nunca texto inventado.
// ---------------------------------------------------------------------------
async function assemble(task) {
  await setStage(task.id, STAGES.ASSEMBLING, 92);
  const chunks = await allAsync(
    `SELECT * FROM transcription_chunks WHERE transcription_id = ? ORDER BY idx`, [task.id]
  );

  let segments = [];
  let modelUsed = task.mode;
  const failed = [];
  for (const c of chunks) {
    if (c.status === 'done') {
      const segs = JSON.parse(c.segments_json || '[]');
      for (const s of segs) {
        segments.push({ speaker: s.speaker, start: s.start + c.offset_sec, end: s.end + c.offset_sec, text: s.text });
      }
      if (c.model_used) modelUsed = c.model_used;
    } else {
      failed.push(c);
      segments.push({
        speaker: 'Sistema',
        start: c.offset_sec,
        end: c.offset_sec + (c.duration_sec || 0),
        text: `[bloco ${c.idx + 1} falhou: ${c.error || 'erro desconhecido'}]`
      });
    }
  }

  const before = segments.length;
  segments = filterHallucinations(segments);
  console.log(`[Pipeline] ${task.id}: filtro de alucinacoes ${before} -> ${segments.length} segmentos.`);
  const rawText = segments.map(s => (s.text || '').trim()).filter(Boolean).join(' ');

  return { segments, rawText, modelUsed, failed };
}

async function analyze(task, rawText) {
  if (!task.ai_summary || !task.ai_summary.trim()) return null;
  await setStage(task.id, STAGES.ANALYZING, 96);
  try {
    return await generateChatCompletion(
      rawText,
      `O usuário gostaria de focar a análise na seguinte instrução ou assunto a procurar: "${task.ai_summary}".
Gere um resumo estruturado no formato Markdown destacando apenas as partes que mencionam esse assunto, listando os tópicos e estimando a marcação de tempo (ex: [01:23:45]) se possível.`
    );
  } catch (e) {
    console.warn(`[Pipeline] ${task.id}: falha no resumo IA:`, e.message);
    return `Não foi possível gerar o resumo automático para o assunto. Erro: ${e.message}`;
  }
}

async function cleanup(task, chunks) {
  const dirs = new Set(chunks.map(c => path.dirname(c.path)));
  for (const d of dirs) {
    if (path.basename(d).startsWith('chunks_')) {
      await fs.promises.rm(d, { recursive: true, force: true }).catch(() => {});
    }
  }
}

// ---------------------------------------------------------------------------
// Job completo. Cada etapa e idempotente, entao rodar de novo apos uma queda
// retoma de onde parou.
// ---------------------------------------------------------------------------
async function processJob(task) {
  console.log(`[Pipeline] Iniciando ${task.id} (${task.file_name})`);
  const chunks = await ensureChunks(task);
  await transcribeChunks(task);
  const { segments, rawText, modelUsed, failed } = await assemble(task);
  const summary = await analyze(task, rawText);

  await runAsync(`DELETE FROM segments WHERE transcription_id = ?`, [task.id]);
  for (const seg of segments) {
    await runAsync(
      `INSERT INTO segments (id, transcription_id, speaker, start_time, end_time, text) VALUES (?, ?, ?, ?, ?, ?)`,
      [uuidv4(), task.id, seg.speaker || 'Locutor 1', seg.start, seg.end, seg.text]
    );
  }

  const duration = (await getAsync(`SELECT duration_seconds FROM transcriptions WHERE id = ?`, [task.id])).duration_seconds;
  const status = failed.length ? 'completed_with_errors' : 'completed';
  const errorMessage = failed.length
    ? `${failed.length} de ${chunks.length} bloco(s) falharam: ${failed.map(c => c.idx + 1).join(', ')}`
    : null;

  await runAsync(
    `UPDATE transcriptions SET status = ?, stage = NULL, progress = 100, raw_text = ?, ai_summary = ?, mode = ?, error_message = ? WHERE id = ?`,
    [status, rawText, summary, modelUsed, errorMessage, task.id]
  );
  await cleanup(task, chunks);
  await logAction(task.user_id, 'TRANSCRIPTION_CREATED_ASYNC', {
    file_name: task.file_name, duration, model: modelUsed, chunks: chunks.length, failed: failed.length
  }, '127.0.0.1');
  console.log(`[Pipeline] ${task.id}: ${status} (${chunks.length} bloco(s), ${failed.length} falha(s)).`);
}

// Reprocessar so os blocos que falharam de um job concluido com erros.
async function retryFailedChunks(transcriptionId) {
  const res = await runAsync(
    `UPDATE transcription_chunks SET status = 'pending', attempts = 0, error = NULL WHERE transcription_id = ? AND status = 'failed'`,
    [transcriptionId]
  );
  if (res.changes > 0) {
    await runAsync(`UPDATE transcriptions SET status = 'pending', error_message = NULL, worker_attempts = 0, worker_started_at = NULL WHERE id = ?`, [transcriptionId]);
  }
  return res.changes;
}

// ---------------------------------------------------------------------------
// Slots de arquivos independentes; cada um preserva o pool de blocos de T-19.
async function startQueueWorker() {
  const concurrency = positiveNumber('WORKER_CONCURRENCY', 2, true, 32);
  const timeoutMs = positiveNumber('WORKER_TIMEOUT_MINUTES', 30, false) * 60000;
  const maxAttempts = positiveNumber('WORKER_MAX_ATTEMPTS', 3, true, 10);
  const queue = createQueueWorker({runAsync, getAsync, allAsync, processJob, concurrency, timeoutMs, maxAttempts, pollMs: POLL_INTERVAL_MS});
  console.log('[Pipeline] Worker ativo: ' + concurrency + ' jobs, ' + CHUNK_CONCURRENCY + ' blocos/job, timeout ' + timeoutMs / 60000 + ' min, ate ' + maxAttempts + ' tentativas/job.');
  await queue.start();
  return queue;
}

// Estado detalhado para GET /api/transcriptions/:id/status
async function getJobProgress(transcriptionId) {
  const queue = await getAsync('SELECT ' + queuePositionSql + ' AS queue_position, worker_attempts FROM transcriptions t WHERE t.id = ?', [transcriptionId]);
  const stats = await getAsync(
    `SELECT COUNT(*) AS total, SUM(status = 'done') AS done, SUM(status = 'failed') AS failed,
            AVG(CASE WHEN status = 'done' AND started_at IS NOT NULL
                     THEN (julianday(finished_at) - julianday(started_at)) * 86400 END) AS avg_sec
     FROM transcription_chunks WHERE transcription_id = ?`, [transcriptionId]
  );
  if (!stats || !stats.total) return { ...queue, chunks_total: 0, chunks_done: 0, chunks_failed: 0, eta_seconds: null };
  const remaining = stats.total - stats.done - (stats.failed || 0);
  const eta = stats.avg_sec !== null && remaining > 0 ? Math.round((stats.avg_sec * remaining) / CHUNK_CONCURRENCY) : null;
  return { ...queue, chunks_total: stats.total, chunks_done: stats.done || 0, chunks_failed: stats.failed || 0, eta_seconds: eta };
}

module.exports = { startQueueWorker, getJobProgress, retryFailedChunks, isTransientError };
