const { runWithJobSignal } = require('./job-context');
function positiveNumber(name, fallback, integer = true, max = Infinity) {
  const n = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(n) || n <= 0 || (integer && !Number.isInteger(n)) || n > max) throw new Error(name + ' deve ser positivo' + (integer ? ' e inteiro' : '') + '.');
  return n;
}
const queuePositionSql = "CASE WHEN t.status = 'pending' THEN (SELECT COUNT(*) FROM transcriptions q WHERE q.status = 'pending' AND (q.created_at < t.created_at OR (q.created_at = t.created_at AND q.rowid <= t.rowid))) ELSE NULL END";

// Um supervisor por banco; slots locais + claim condicional impedem duplo processamento.
function createQueueWorker({runAsync, getAsync, allAsync, processJob, concurrency = 2, timeoutMs = 30 * 60000, maxAttempts = 3, pollMs = 5000}) {
  const activeJobIds = new Set();
  const running = new Map();
  let ticking = false, stopped = false, interval;
  async function recoverInterrupted() {
    // Executado uma vez no boot, antes de iniciar os slots. Blocos done ficam intactos.
    await runAsync("UPDATE transcriptions SET status = CASE WHEN worker_attempts >= ? THEN 'failed' ELSE 'pending' END, stage = NULL, worker_started_at = NULL, error_message = 'Execucao interrompida; recuperacao no boot' WHERE status = 'processing'", [maxAttempts]);
  }
  async function claimNext() {
    const task = await getAsync("SELECT * FROM transcriptions WHERE status = 'pending' ORDER BY created_at, rowid LIMIT 1");
    if (!task) return null;
    const result = await runAsync("UPDATE transcriptions SET status = 'processing', worker_started_at = CURRENT_TIMESTAMP, worker_attempts = worker_attempts + 1, error_message = NULL WHERE id = ? AND status = 'pending'", [task.id]);
    return result.changes === 1 ? {...task, worker_attempts: task.worker_attempts + 1} : null;
  }
  function launch(task) {
    activeJobIds.add(task.id);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error('Tempo limite do job excedido')), timeoutMs);
    const completion = runWithJobSignal(controller.signal, () => Promise.resolve().then(() => processJob(task)))
      .catch(async error => {
        const retry = controller.signal.aborted && task.worker_attempts < maxAttempts;
        const message = String(controller.signal.aborted ? controller.signal.reason.message : error.message || error).slice(0, 500);
        await runAsync("UPDATE transcriptions SET status = ?, stage = NULL, worker_started_at = NULL, error_message = ? WHERE id = ? AND status = 'processing'", [retry ? 'pending' : 'failed', message, task.id]);
        console.warn('[Queue] ' + task.id + ': ' + message + (retry ? ' — reenfileirado' : ''));
      })
      .catch(error => console.error('[Queue] Falha ao registrar resultado:', error.message))
      .finally(() => {
        clearTimeout(timeout); activeJobIds.delete(task.id); running.delete(task.id);
        if (!stopped) setImmediate(tick);
      });
    running.set(task.id, {controller, completion});
  }
  async function tick() {
    if (stopped || ticking) return;
    ticking = true;
    try {
      while (!stopped && activeJobIds.size < concurrency) {
        const task = await claimNext();
        if (!task) break;
        launch(task);
      }
    } catch (error) { console.error('[Queue] Falha no poll:', error.message); }
    finally { ticking = false; }
  }
  async function start() {
    if (interval) return;
    await recoverInterrupted();
    interval = setInterval(tick, pollMs);
    await tick();
  }
  async function stop() {
    stopped = true; clearInterval(interval);
    // Espera terminar um claim em andamento antes de abortar todos os slots.
    while (ticking) await new Promise(resolve => setImmediate(resolve));
    for (const job of running.values()) job.controller.abort(new Error('Worker encerrado; retomar na proxima inicializacao'));
    await Promise.allSettled([...running.values()].map(job => job.completion));
  }
  return {start, stop, tick, claimNext, recoverInterrupted, activeJobIds};
}
module.exports = { createQueueWorker, queuePositionSql, positiveNumber };
