require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');

const { initDatabase, runAsync, getAsync, allAsync, logAction } = require('./db');
const { transcribeAudioFile, generateChatCompletion, runAnalysisChat, translateTranscript, getAvailableOpenRouterModels, testOpenRouterKey } = require('./services/openrouter');
const { isValidLanguage } = require('./services/languages');
const { DEFAULT_ENHANCE_SYSTEM_PROMPT, buildEnhanceUserContent, splitTextIntoChunks, PROMPT_VERSION } = require('./services/prompts');
const { enhanceWithJudge } = require('./services/judge');
const secrets = require('./services/secrets');
const { queuePositionSql } = require('./services/queue');
const { saveTranscriptSegments } = require('./services/transcript-editor');
const { generateTXT, generateSRT, generateVTT, generateDOCX, generatePDF } = require('./services/exporter');
const { probeMedia } = require('./services/audio');
const { startQueueWorker, getJobProgress, retryFailedChunks } = require('./services/pipeline');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'turboscribe_super_secret_jwt_key_2026';

if (process.env.NODE_ENV === 'production' && (!process.env.JWT_SECRET || process.env.JWT_SECRET === 'turboscribe_super_secret_jwt_key_2026')) {
  console.error('ERRO CRÍTICO: JWT_SECRET não definido ou usando valor padrão em ambiente de produção (NODE_ENV=production).');
  process.exit(1);
}

// Configuração do Upload de Áudios/Vídeos
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, uniqueSuffix + '-' + file.originalname);
  }
});
const MAX_UPLOAD_GB = Number(process.env.MAX_UPLOAD_GB || 5);
const MAX_FILES_PER_UPLOAD = Number(process.env.MAX_FILES_PER_UPLOAD || 50);
const MAX_AUDIO_HOURS = Number(process.env.MAX_AUDIO_HOURS || 10);
const upload = multer({
  storage,
  limits: { fileSize: MAX_UPLOAD_GB * 1024 * 1024 * 1024, files: MAX_FILES_PER_UPLOAD }
});

// Multer aborta a requisicao inteira ao estourar um limite; traduz para JSON claro.
function uploadErrorHandler(err, req, res, next) {
  if (!(err instanceof multer.MulterError)) return next(err);
  const map = {
    LIMIT_FILE_SIZE: [413, `Arquivo maior que o limite de ${MAX_UPLOAD_GB} GB.`],
    LIMIT_FILE_COUNT: [400, `No maximo ${MAX_FILES_PER_UPLOAD} arquivos por envio.`],
    LIMIT_UNEXPECTED_FILE: [400, `Campo de arquivo inesperado: use "files".`]
  };
  const [status, message] = map[err.code] || [400, err.message];
  res.status(status).json({ success: false, error: message, code: err.code });
}

// Middlewares
app.use(cors());
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ extended: true, limit: '100mb' }));

// Desabilitar Cache do Navegador para desenvolvimento/atualizações dinâmicas
app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  next();
});

// T-02: /uploads deixou de ser estático público. Cada áudio só é servido ao
// dono (admin precisa de ?all=true, como nas rotas de dados). O player usa
// ?token= porque <audio> não envia header Authorization. Nome sanitizado com
// path.basename para não sair do diretório de uploads.
app.get('/uploads/:file', authenticateToken, async (req, res) => {
  try {
    const fileName = path.basename(req.params.file);
    const row = await getAsync('SELECT user_id FROM transcriptions WHERE file_path = ?', ['/uploads/' + fileName]);
    const all = req.user.role === 'admin' && req.query.all === 'true';
    if (!row || (!all && row.user_id !== req.user.id)) {
      return res.status(404).send('Arquivo não encontrado.');
    }
    res.sendFile(path.join(uploadsDir, fileName));
  } catch (e) {
    res.status(500).send('Erro ao servir arquivo.');
  }
});

// Estáticos explícitos: o diretório do projeto NÃO é publicado como um todo.
// (com express.static(__dirname), /turboscribe.sqlite, /.env e o próprio
// server.js ficavam baixáveis por qualquer cliente sem autenticação)
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/index.html', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/app.js', (req, res) => res.sendFile(path.join(__dirname, 'app.js')));
// T-20: lista canônica de idiomas do Whisper — usada pelo backend (validação)
// e pelo frontend (select do modal de upload). UMD, mesmo arquivo.
app.get('/languages.js', (req, res) => res.sendFile(path.join(__dirname, 'services', 'languages.js')));

// Middleware de Autenticação JWT
// Aceita Authorization: Bearer <token> (API/padrão) ou ?token= (elementos de
// mídia como <audio>, que não enviam header — T-02).
//
// VALIDAÇÃO DE CONTA A CADA REQUEST (25/09): após verificar a assinatura do
// JWT, o middleware lê role/status FRESH do banco. Sem isso, um usuário
// suspenso (T-23) continuava usando a API normal até o token expirar (30d),
// e um usuário promovido a admin só ganhava o escopo ampliado após novo
// login. Suspenso ou deletado = 403 imediato, em qualquer rota.
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = (authHeader && authHeader.split(' ')[1]) || (typeof req.query.token === 'string' ? req.query.token : null);

  if (!token) {
    return res.status(401).json({ error: 'Acesso negado. Token de autenticação não fornecido.' });
  }

  jwt.verify(token, JWT_SECRET, async (err, user) => {
    if (err) return res.status(403).json({ error: 'Sessão inválida ou expirada.' });
    try {
      const row = await getAsync(`SELECT role, status FROM users WHERE id = ?`, [user.id]);
      if (!row) return res.status(403).json({ error: 'Conta não encontrada.' });
      if (row.status !== 'active') {
        return res.status(403).json({ error: 'Conta suspensa. Contate o administrador.' });
      }
      req.user = { ...user, role: row.role };
      next();
    } catch (e) {
      res.status(500).json({ error: 'Falha ao validar sessão.' });
    }
  });
}

// Middleware de Verificação de Admin. O role JÁ vem fresco do banco via
// authenticateToken (que também garante status='active'), então aqui basta
// conferir o papel — sem nova query.
function requireAdmin(req, res, next) {
  if (req.user && req.user.role === 'admin') {
    next();
  } else {
    res.status(403).json({ error: 'Acesso restrito a Administradores do SaaS.' });
  }
}

// T-02 — Isolamento multi-tenant.
// Escopo do usuário autenticado: admin só enxerga tudo com ?all=true EXPLÍCITO;
// qualquer outro usuário enxerga apenas o que é seu. Acesso a recurso alheio
// responde 404 (não 403) — não revela nem a existência do recurso.
function scopeOf(req) {
  return { userId: req.user.id, all: req.user.role === 'admin' && req.query.all === 'true' };
}

// Resolve a transcrição se — e somente se — existir E pertencer ao escopo.
async function ownedTranscription(id, scope) {
  const row = await getAsync('SELECT id, user_id, status FROM transcriptions WHERE id = ?', [id]);
  if (!row || (!scope.all && row.user_id !== scope.userId)) return null;
  return row;
}

// Inicializar Banco de Dados
secrets.loadMasterKey(); // em producao, recusa subir sem APP_SECRET_KEY
const databaseReady = initDatabase();

// ----------------------------------------------------
// ROTAS DE AUTENTICAÇÃO
// ----------------------------------------------------
app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  try {
    const user = await getAsync(`SELECT * FROM users WHERE email = ?`, [email]);
    if (!user) {
      return res.status(401).json({ error: 'Credenciais inválidas.' });
    }

    if (user.status !== 'active') {
      return res.status(403).json({ error: 'Conta suspensa pelo Administrador.' });
    }

    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) {
      return res.status(401).json({ error: 'Credenciais inválidas.' });
    }

    const token = jwt.sign(
      { id: user.id, name: user.name, email: user.email, role: user.role },
      JWT_SECRET,
      { expiresIn: '30d' }
    );

    await logAction(user.id, 'LOGIN', { email: user.email }, req.ip);

    res.json({
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        daily_limit: user.daily_limit
      }
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/auth/me', authenticateToken, async (req, res) => {
  try {
    const user = await getAsync(`SELECT id, name, email, role, daily_limit, status FROM users WHERE email = ? OR id = ?`, [req.user.email, req.user.id]);
    if (!user) {
      return res.json({ user: req.user });
    }
    res.json({ user });
  } catch (e) {
    res.json({ user: req.user });
  }
});

// ----------------------------------------------------
// ROTAS DE PROJETOS (PROJECTS)
// ----------------------------------------------------
app.get('/api/projects', authenticateToken, async (req, res) => {
  try {
    const scope = scopeOf(req);
    let sql = `SELECT p.*, COUNT(t.id) as file_count FROM projects p LEFT JOIN transcriptions t ON p.id = t.project_id`;
    const params = [];
    if (!scope.all) {
      sql += ` WHERE p.user_id = ?`;
      params.push(scope.userId);
    }
    sql += ` GROUP BY p.id ORDER BY p.created_at ASC`;
    const projects = await allAsync(sql, params);
    res.json(projects);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/projects', authenticateToken, async (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'Nome do projeto é obrigatório.' });

  try {
    const projectId = uuidv4();
    await runAsync(`INSERT INTO projects (id, user_id, name) VALUES (?, ?, ?)`, [projectId, req.user.id, name]);
    await logAction(req.user.id, 'PROJECT_CREATED', { name }, req.ip);
    res.json({ id: projectId, name, file_count: 0 });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/projects/:id', authenticateToken, async (req, res) => {
  try {
    const scope = scopeOf(req);
    const row = await getAsync('SELECT user_id FROM projects WHERE id = ?', [req.params.id]);
    if (!row || (!scope.all && row.user_id !== scope.userId)) {
      return res.status(404).json({ error: 'Projeto não encontrado.' });
    }
    await runAsync(`DELETE FROM projects WHERE id = ?`, [req.params.id]);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ----------------------------------------------------
// ROTAS DE TRANSCRIÇÃO (CLIENT)
// ----------------------------------------------------
app.get('/api/transcriptions', authenticateToken, async (req, res) => {
  try {
    const scope = scopeOf(req);
    const { project_id, search } = req.query;
    let sql = `SELECT t.*, ${queuePositionSql} AS queue_position, p.name as project_name FROM transcriptions t LEFT JOIN projects p ON t.project_id = p.id WHERE 1=1`;
    const params = [];

    if (!scope.all) {
      sql += ` AND t.user_id = ?`;
      params.push(scope.userId);
    }

    if (project_id === 'uncategorized') {
      sql += ` AND t.project_id IS NULL`;
    } else if (project_id) {
      sql += ` AND t.project_id = ?`;
      params.push(project_id);
    }

    if (search) {
      sql += ` AND (t.file_name LIKE ? OR t.raw_text LIKE ?)`;
      params.push(`%${search}%`, `%${search}%`);
    }

    sql += ` ORDER BY t.created_at DESC`;
    const transcriptions = await allAsync(sql, params);
    res.json(transcriptions);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/transcriptions/:id', authenticateToken, async (req, res) => {
  try {
    const scope = scopeOf(req);
    const transcription = await getAsync(
      `SELECT t.*, p.name as project_name FROM transcriptions t LEFT JOIN projects p ON t.project_id = p.id WHERE t.id = ?`,
      [req.params.id]
    );

    if (!transcription || (!scope.all && transcription.user_id !== scope.userId)) {
      return res.status(404).json({ error: 'Transcrição não encontrada.' });
    }

    const segments = await allAsync(
      `SELECT * FROM segments WHERE transcription_id = ? ORDER BY start_time ASC`,
      [req.params.id]
    );

    res.json({ ...transcription, segments });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Endpoint para obter modelos OpenRouter com taxas e nível de precisão
app.get('/api/openrouter/models', (req, res) => {
  res.json(getAvailableOpenRouterModels());
});

// Upload & Processamento de Transcrição (Assíncrono)
app.post('/api/transcribe', authenticateToken, upload.array('files'), uploadErrorHandler, async (req, res) => {
  const { mode: rawMode = 'max', model_id = null, project_id = null, speaker_diarization = false, ai_focus = null } = req.body;

  // T-20: idioma padrão é 'auto' (detecção automática pelo Whisper). Códigos
  // válidos vêm da lista canônica em services/languages.js; qualquer outro
  // valor é rejeitado com 400 antes de tocar em arquivo.
  const rawLanguage = String(req.body.language || 'auto').toLowerCase();
  const language = rawLanguage === 'auto' ? 'auto' : rawLanguage;
  if (language !== 'auto' && !isValidLanguage(language)) {
    return res.status(400).json({ error: `Idioma inválido: '${req.body.language}'. Use 'auto' ou um código ISO-639-1 da lista (ex.: pt, en, es, ja).` });
  }

  // T-16: aliases legados (chita/golfinho/baleia) aceitos por uma versão, com aviso de deprecação
  const LEGACY_MODE_ALIASES = { chita: 'base', golfinho: 'pro', baleia: 'max' };
  let mode = rawMode;
  if (LEGACY_MODE_ALIASES[rawMode]) {
    console.warn(`[T-16] Modo legado '${rawMode}' recebido em /api/transcribe; use '${LEGACY_MODE_ALIASES[rawMode]}'. Alias será removido na próxima versão.`);
    mode = LEGACY_MODE_ALIASES[rawMode];
  }

  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ error: 'Nenhum arquivo enviado.' });
  }

  const results = [];
  const errors = [];
  const effectiveModel = model_id || mode;

  // Valida cada arquivo com ffprobe ANTES de enfileirar: um invalido nao derruba os outros.
  for (const file of req.files) {
    const reject = async (message) => {
      errors.push({ file_name: file.originalname, error: message });
      await fs.promises.unlink(file.path).catch(() => {});
    };
    try {
      let probe;
      try {
        probe = await probeMedia(file.path);
      } catch (e) {
        await reject('Arquivo nao reconhecido como audio/video (ffprobe falhou).');
        continue;
      }
      if (!probe.hasAudio) {
        await reject('O arquivo nao contem trilha de audio.');
        continue;
      }
      if (probe.duration > MAX_AUDIO_HOURS * 3600) {
        await reject(`Duracao de ${(probe.duration / 3600).toFixed(1)} h excede o limite de ${MAX_AUDIO_HOURS} h.`);
        continue;
      }

      const transcriptionId = uuidv4();
      const relativePath = '/uploads/' + file.filename;

      await runAsync(
        `INSERT INTO transcriptions (id, user_id, project_id, file_name, file_path, file_size, duration_seconds, language, mode, status, raw_text, speaker_diarization, progress, ai_summary)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          transcriptionId,
          req.user.id || 'admin-local',
          project_id || null,
          file.originalname,
          relativePath,
          file.size,
          probe.duration,
          language,
          effectiveModel,
          'pending',
          '',
          speaker_diarization ? 1 : 0,
          0,
          ai_focus || null
        ]
      );

      results.push({ id: transcriptionId, file_name: file.originalname, status: 'pending', progress: 0, duration_seconds: probe.duration });
    } catch (err) {
      console.error('Erro ao registrar áudio para transcrição na fila:', err);
      await reject(err.message);
    }
  }

  if (results.length === 0) {
    return res.status(400).json({
      success: false,
      error: 'Nenhum arquivo valido para transcrever.',
      errors
    });
  }

  res.status(202).json({ success: true, count: results.length, data: results, errors });
});

// Reprocessa so os blocos que falharam (job em completed_with_errors ou failed)
app.post('/api/transcriptions/:id/retry', authenticateToken, async (req, res) => {
  try {
    const row = await ownedTranscription(req.params.id, scopeOf(req));
    if (!row) return res.status(404).json({ error: 'Transcrição não encontrada.' });
    if (!['failed', 'completed_with_errors'].includes(row.status)) return res.status(409).json({error: 'O job nao esta disponivel para reprocessamento.'});
    const reset = await retryFailedChunks(row.id);
    if (reset === 0 && row.status === 'failed') {
      // Falhou antes de fatiar (ex.: ffmpeg): recomeca do zero
      await runAsync(`UPDATE transcriptions SET status = 'pending', error_message = NULL, progress = 0, worker_attempts = 0, worker_started_at = NULL WHERE id = ?`, [row.id]);
    }
    res.json({ success: true, chunks_reset: reset });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Atualizar nome / mover pasta
app.put('/api/transcriptions/:id', authenticateToken, async (req, res) => {
  const { file_name, project_id, raw_text, segments } = req.body;
  const scope = scopeOf(req);
  const owned = await ownedTranscription(req.params.id, scope);
  if (!owned) return res.status(404).json({ error: 'Transcrição não encontrada.' });
  if (segments !== undefined) {
    try {
      if (file_name !== undefined || project_id !== undefined) return res.status(400).json({ error: 'Salve os metadados separadamente da edicao dos segmentos.' });
      return res.json(await saveTranscriptSegments(req.params.id, segments));
    } catch (error) {
      return res.status(error.status || 500).json({ error: error.status ? error.message : 'Nao foi possivel salvar a transcricao.' });
    }
  }
  try {
    if (file_name !== undefined) {
      await runAsync(`UPDATE transcriptions SET file_name = ? WHERE id = ?`, [file_name, req.params.id]);
    }
    if (project_id !== undefined) {
      await runAsync(`UPDATE transcriptions SET project_id = ? WHERE id = ?`, [project_id || null, req.params.id]);
    }
    if (raw_text !== undefined) {
      await runAsync(`UPDATE transcriptions SET raw_text = ? WHERE id = ?`, [raw_text, req.params.id]);
    }
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Excluir transcrição
app.delete('/api/transcriptions/:id', authenticateToken, async (req, res) => {
  try {
    const owned = await ownedTranscription(req.params.id, scopeOf(req));
    if (!owned) return res.status(404).json({ error: 'Transcrição não encontrada.' });
    await runAsync(`DELETE FROM transcriptions WHERE id = ?`, [req.params.id]);
    await runAsync(`DELETE FROM segments WHERE transcription_id = ?`, [req.params.id]);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ----------------------------------------------------
// EXPORTAÇÃO MULTI-FORMATO (PDF, DOCX, TXT, SRT, VTT)
// ----------------------------------------------------
app.get('/api/export/:id/:format', authenticateToken, async (req, res) => {
  const { id, format } = req.params;
  const includeTimestamps = req.query.timestamps === 'true';

  try {
    const scope = scopeOf(req);
    const transcription = await getAsync(`SELECT * FROM transcriptions WHERE id = ?`, [id]);
    if (!transcription || (!scope.all && transcription.user_id !== scope.userId)) {
      return res.status(404).send('Transcrição não encontrada.');
    }

    const segments = await allAsync(`SELECT * FROM segments WHERE transcription_id = ? ORDER BY start_time ASC`, [id]);
    const baseName = transcription.file_name.replace(/\.[^/.]+$/, '');

    switch (format.toLowerCase()) {
      case 'txt':
        const txtData = generateTXT(transcription, segments, includeTimestamps);
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${baseName}.txt"`);
        return res.send(txtData);

      case 'srt':
        const srtData = generateSRT(segments);
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${baseName}.srt"`);
        return res.send(srtData);

      case 'vtt':
        const vttData = generateVTT(segments);
        res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${baseName}.vtt"`);
        return res.send(vttData);

      case 'docx':
        const docxBuffer = await generateDOCX(transcription, segments, includeTimestamps);
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
        res.setHeader('Content-Disposition', `attachment; filename="${baseName}.docx"`);
        return res.send(docxBuffer);

      case 'pdf':
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="${baseName}.pdf"`);
        return generatePDF(transcription, segments, includeTimestamps, (err, pdfBuffer) => {
          if (err) return res.status(500).send('Erro ao gerar PDF');
          res.send(pdfBuffer);
        });

      default:
        return res.status(400).send('Formato de exportação não suportado.');
    }
  } catch (e) {
    res.status(500).send('Erro ao exportar arquivo: ' + e.message);
  }
});

// ----------------------------------------------------
// CHAT IA & TRADUÇÃO (OPENROUTER)
// ----------------------------------------------------
app.post('/api/chat', authenticateToken, async (req, res) => {
  const { transcript_text, prompt, transcription_id } = req.body;
  if (!prompt) return res.status(400).json({ error: 'Prompt é obrigatório.' });

  try {
    // T-02: quando o texto vem de uma transcrição, o dono precisa ser o usuário.
    if (transcription_id) {
      const owned = await ownedTranscription(transcription_id, scopeOf(req));
      if (!owned) return res.status(404).json({ error: 'Transcrição não encontrada.' });
    }
    const answer = await generateChatCompletion(transcript_text || '', prompt);
    res.json({ answer });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/translate', authenticateToken, async (req, res) => {
  const { transcript_text, target_language, transcription_id } = req.body;
  try {
    // T-02: idem — escopo por dono quando transcription_id é enviado.
    if (transcription_id) {
      const owned = await ownedTranscription(transcription_id, scopeOf(req));
      if (!owned) return res.status(404).json({ error: 'Transcrição não encontrada.' });
    }
    const translatedText = await translateTranscript(transcript_text || '', target_language || 'English');
    res.json({ translatedText });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ----------------------------------------------------
// T-18: APRIMORAMENTO DE TRANSCRIÇÃO POR IA (análise estruturada)
// System prompt e modelo configuráveis pelo admin; dicionário (glossary) aplicado.
// ----------------------------------------------------

// Lista os aprimoramentos de uma transcrição (mais recente primeiro)
app.get('/api/transcriptions/:id/analyses', authenticateToken, async (req, res) => {
  try {
    const owned = await ownedTranscription(req.params.id, scopeOf(req));
    if (!owned) return res.status(404).json({ error: 'Transcrição não encontrada.' });
    const rows = await allAsync(
      `SELECT id, kind, model, prompt_used, glossary_used, result_md, tokens_in, tokens_out, cost_usd, created_at,
              judge_model, judge_approved, judge_feedback, attempts
       FROM ai_analyses WHERE transcription_id = ? ORDER BY created_at DESC`,
      [req.params.id]
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Roda o aprimoramento: corrige palavras (dicionário), ortografia, concordância
// e estrutura o texto. Síncrono e em blocos para textos longos. Custo: tokens registrados.
app.post('/api/transcriptions/:id/enhance', authenticateToken, async (req, res) => {
  try {
    // T-02: recurso alheio → 404 (não 403), como nas demais rotas.
    const owned = await ownedTranscription(req.params.id, scopeOf(req));
    if (!owned) return res.status(404).json({ error: 'Transcrição não encontrada.' });
    const transcription = await getAsync(`SELECT * FROM transcriptions WHERE id = ?`, [req.params.id]);
    const sourceText = (transcription.raw_text || '').trim();
    if (!sourceText) return res.status(400).json({ error: 'Transcrição sem texto para aprimorar.' });

    const settings = await allAsync(`SELECT key, value FROM system_settings`);
    const settingsMap = {};
    settings.forEach(s => settingsMap[s.key] = s.value);
    const systemPrompt = (settingsMap.analysis_prompt || '').trim() || DEFAULT_ENHANCE_SYSTEM_PROMPT;
    const model = (settingsMap.analysis_model || '').trim() || 'openai/gpt-4o-mini';
    // T-25 (JEV): juiz de validação — modelos configuráveis no painel admin.
    // Desligado explicitamente com judge_enabled='0' (fluxo T-18 puro).
    const judgeEnabled = (settingsMap.judge_enabled || '1').trim() !== '0';
    const judgeModel = (settingsMap.judge_model || '').trim() || 'openai/gpt-4o-mini';

    const glossary = await allAsync(`SELECT wrong, correct FROM glossary ORDER BY wrong`);
    const glossaryJson = JSON.stringify(glossary);

    const chunks = splitTextIntoChunks(sourceText, 12000).map((original, index) => ({
      index,
      original,
      userContent: buildEnhanceUserContent(original, glossary)
    }));

    // T-25: geração + validação do juiz (retry com feedback se reprovar).
    const generate = async (userContent) => runAnalysisChat({ systemPrompt, userContent, model });
    const { results, tokensIn, tokensOut, attempts, judge } = await enhanceWithJudge({
      chunks, generate, glossary, judgeModel, judgeEnabled
    });
    const resultText = results.join('\n\n');

    const analysisId = uuidv4();
    await runAsync(
      `INSERT INTO ai_analyses (id, transcription_id, kind, model, prompt_used, glossary_used, result_md, tokens_in, tokens_out, judge_model, judge_approved, judge_feedback, attempts, created_at)
       VALUES (?, ?, 'enhance', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
      [analysisId, req.params.id, model, systemPrompt, glossaryJson, resultText, tokensIn, tokensOut,
       judgeEnabled ? judgeModel : null, judge ? (judge.approved ? 1 : 0) : null,
       judge && judge.issues.length ? JSON.stringify(judge.issues) : null, attempts]
    );
    res.json({ success: true, analysis: { id: analysisId, model, result_md: resultText, tokens_in: tokensIn, tokens_out: tokensOut, prompt_version: PROMPT_VERSION, attempts, judge } });
  } catch (e) {
    console.error('[T-18 Enhance Error]', e);
    // Sem texto inventado: falha de API/LLM retorna erro explícito, nada é persistido.
    res.status(502).json({ error: 'Falha ao aprimorar com IA: ' + e.message });
  }
});

// Dicionário de correções (glossário) — CRUD admin
app.get('/api/glossary', authenticateToken, async (req, res) => {
  try {
    const rows = await allAsync(`SELECT id, wrong, correct FROM glossary ORDER BY wrong`);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/admin/glossary', authenticateToken, requireAdmin, async (req, res) => {
  const { wrong, correct } = req.body || {};
  if (!wrong || !correct || !String(wrong).trim() || !String(correct).trim()) {
    return res.status(400).json({ error: 'Informe a forma errada e a forma correta.' });
  }
  try {
    const existing = await getAsync(`SELECT id FROM glossary WHERE wrong = ?`, [String(wrong).trim().toLowerCase()]);
    if (existing) return res.status(409).json({ error: 'Esse termo já existe no dicionário.' });
    const id = uuidv4();
    await runAsync(`INSERT INTO glossary (id, wrong, correct) VALUES (?, ?, ?)`, [id, String(wrong).trim().toLowerCase(), String(correct).trim()]);
    await logAction(req.user.id, 'GLOSSARY_ADD', { wrong, correct }, req.ip);
    res.json({ success: true, id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/admin/glossary/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    await runAsync(`DELETE FROM glossary WHERE id = ?`, [req.params.id]);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ----------------------------------------------------
// PAINEL DE ADMINISTRAÇÃO SAAS (ADMIN ROUTES)
// ----------------------------------------------------

// Métricas Gerais do SaaS
app.get('/api/admin/metrics', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const userCount = await getAsync(`SELECT COUNT(*) as count FROM users`);
    const totalTranscriptions = await getAsync(`SELECT COUNT(*) as count, SUM(duration_seconds) as total_duration, SUM(file_size) as total_size FROM transcriptions`);
    const apiKeyCount = await getAsync(`SELECT COUNT(*) as count FROM api_keys WHERE is_active = 1`);
    const recentLogs = await allAsync(`SELECT l.*, u.email as user_email FROM system_logs l LEFT JOIN users u ON l.user_id = u.id ORDER BY l.timestamp DESC LIMIT 10`);

    res.json({
      users_total: userCount.count || 0,
      transcriptions_count: totalTranscriptions.count || 0,
      hours_transcribed: ((totalTranscriptions.total_duration || 0) / 3600).toFixed(1),
      storage_used_mb: ((totalTranscriptions.total_size || 0) / (1024 * 1024)).toFixed(1),
      active_api_keys: apiKeyCount.count || 0,
      recent_logs: recentLogs
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Gerenciamento de Usuários
app.get('/api/admin/users', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const users = await allAsync(`SELECT id, name, email, role, daily_limit, status, created_at FROM users ORDER BY created_at DESC`);
    res.json(users);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/admin/users', authenticateToken, requireAdmin, async (req, res) => {
  const { name, email, password, role = 'user', daily_limit = 3 } = req.body;
  if (!name || !email || !password) return res.status(400).json({ error: 'Preencha todos os campos obrigatórios.' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'E-mail inválido.' });
  if (String(password).length < 6) return res.status(400).json({ error: 'A senha deve ter ao menos 6 caracteres.' });
  if (!['user', 'admin'].includes(role)) return res.status(400).json({ error: 'Função inválida (use "user" ou "admin").' });

  try {
    const existing = await getAsync('SELECT id FROM users WHERE email = ?', [email]);
    if (existing) return res.status(409).json({ error: 'Já existe um usuário com este e-mail.' });

    const userId = uuidv4();
    const passHash = await bcrypt.hash(password, 10);
    await runAsync(
      `INSERT INTO users (id, name, email, password_hash, role, daily_limit, status) VALUES (?, ?, ?, ?, ?, ?, 'active')`,
      [userId, name, email, passHash, role, daily_limit]
    );
    await logAction(req.user.id, 'ADMIN_USER_CREATED', { created_email: email, role }, req.ip);
    res.json({ success: true, id: userId });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/admin/users/:id', authenticateToken, requireAdmin, async (req, res) => {
  const { role, status, daily_limit, password } = req.body;
  try {
    const target = await getAsync('SELECT id FROM users WHERE id = ?', [req.params.id]);
    if (!target) return res.status(404).json({ error: 'Usuário não encontrado.' });
    const isSelf = req.params.id === req.user.id;

    if (role !== undefined) {
      if (!['user', 'admin'].includes(role)) return res.status(400).json({ error: 'Função inválida (use "user" ou "admin").' });
      if (isSelf && role !== 'admin') return res.status(400).json({ error: 'Você não pode rebaixar a si mesmo.' });
      await runAsync(`UPDATE users SET role = ? WHERE id = ?`, [role, req.params.id]);
    }
    if (status !== undefined) {
      if (!['active', 'suspended'].includes(status)) return res.status(400).json({ error: 'Status inválido (use "active" ou "suspended").' });
      if (isSelf && status !== 'active') return res.status(400).json({ error: 'Você não pode suspender a si mesmo.' });
      await runAsync(`UPDATE users SET status = ? WHERE id = ?`, [status, req.params.id]);
    }
    if (daily_limit !== undefined) {
      const limit = parseInt(daily_limit, 10);
      if (!Number.isInteger(limit) || limit < 0) return res.status(400).json({ error: 'Limite diário inválido.' });
      await runAsync(`UPDATE users SET daily_limit = ? WHERE id = ?`, [limit, req.params.id]);
    }
    if (password !== undefined && password !== '') {
      if (String(password).length < 6) return res.status(400).json({ error: 'A senha deve ter ao menos 6 caracteres.' });
      await runAsync(`UPDATE users SET password_hash = ? WHERE id = ?`, [await bcrypt.hash(String(password), 10), req.params.id]);
    }

    await logAction(req.user.id, 'ADMIN_USER_UPDATED', { target_user: req.params.id, role, status }, req.ip);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------------------------------------------------------------------------
// Chaves de API (OpenRouter). A chave e cifrada em repouso (services/secrets.js)
// e NUNCA sai do servidor: as rotas devolvem so a versao mascarada.
// Salvar/trocar exige a senha do admin; 5 falhas em 10 min bloqueiam o IP.
// ---------------------------------------------------------------------------
const keyAuthFailures = new Map(); // ip -> [timestamps]
const KEY_AUTH_MAX_FAILURES = 5;
const KEY_AUTH_WINDOW_MS = 10 * 60 * 1000;

function keyAuthBlocked(ip) {
  const now = Date.now();
  const recent = (keyAuthFailures.get(ip) || []).filter(t => now - t < KEY_AUTH_WINDOW_MS);
  keyAuthFailures.set(ip, recent);
  return recent.length >= KEY_AUTH_MAX_FAILURES;
}

async function verifyAdminPassword(req, password) {
  if (!password) return false;
  // Somente o admin autenticado no token valida a PROPRIA senha.
  // Sem fallback para "qualquer outro admin" — senao a senha de um admin
  // validaria troca de chave feita por outro (ou por token forjado de role).
  if (!req.user || !req.user.id || req.user.id === 'admin-local') return false;
  const user = await getAsync(`SELECT password_hash FROM users WHERE id = ? AND role = 'admin' AND status = 'active'`, [req.user.id]);
  return user ? bcrypt.compare(password, user.password_hash) : false;
}

function publicKeyRow(k) {
  let masked = '';
  try { masked = secrets.mask(secrets.decrypt(k.key_value)); } catch (_) { masked = '(indecifravel — cadastre de novo)'; }
  return {
    id: k.id,
    provider: k.provider,
    name: k.name,
    is_active: k.is_active,
    created_at: k.created_at,
    masked_key: masked,
    last_check_at: k.last_check_at,
    last_check_ok: k.last_check_ok === null ? null : Boolean(k.last_check_ok),
    last_check_info: k.last_check_info ? JSON.parse(k.last_check_info) : null
  };
}

app.get('/api/admin/apikeys', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const keys = await allAsync(`SELECT * FROM api_keys ORDER BY created_at DESC`);
    res.json(keys.map(publicKeyRow));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Estado da chave ativa, para o indicador da sidebar (nunca inclui a chave).
app.get('/api/admin/apikeys/status', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const active = await getAsync(`SELECT * FROM api_keys WHERE provider = 'openrouter' AND is_active = 1 LIMIT 1`);
    if (!active) return res.json({ configured: false });
    res.json({ configured: true, ...publicKeyRow(active) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Testa uma chave informada (sem salvar) ou, sem body, a chave ativa atual.
app.post('/api/admin/apikeys/test', authenticateToken, requireAdmin, async (req, res) => {
  try {
    let candidate = (req.body && req.body.key_value || '').trim();
    let activeId = null;
    if (!candidate) {
      const active = await getAsync(`SELECT id, key_value FROM api_keys WHERE provider = 'openrouter' AND is_active = 1 LIMIT 1`);
      if (!active) return res.status(404).json({ valid: false, error: 'Nenhuma chave configurada.' });
      candidate = secrets.decrypt(active.key_value);
      activeId = active.id;
    }
    if (!/^sk-or-v1-/.test(candidate)) {
      return res.status(400).json({ valid: false, error: 'Formato invalido: a chave da OpenRouter comeca com sk-or-v1-.' });
    }
    const result = await testOpenRouterKey(candidate);
    if (activeId) {
      await runAsync(
        `UPDATE api_keys SET last_check_at = CURRENT_TIMESTAMP, last_check_ok = ?, last_check_info = ? WHERE id = ?`,
        [result.valid ? 1 : 0, JSON.stringify(result.info || { error: result.error }), activeId]
      );
    }
    res.status(result.valid ? 200 : 422).json({ valid: result.valid, info: result.info, error: result.error, masked_key: secrets.mask(candidate) });
  } catch (e) {
    res.status(500).json({ valid: false, error: e.message });
  }
});

app.post('/api/admin/apikeys', authenticateToken, requireAdmin, async (req, res) => {
  const { name, key_value, admin_password } = req.body || {};
  const ip = req.ip || '0.0.0.0';
  if (keyAuthBlocked(ip)) {
    return res.status(429).json({ error: 'Muitas tentativas com senha incorreta. Aguarde 10 minutos.' });
  }
  const candidate = String(key_value || '').trim();
  if (!/^sk-or-v1-/.test(candidate)) return res.status(400).json({ error: 'Formato invalido: a chave da OpenRouter comeca com sk-or-v1-.' });

  try {
    if (!(await verifyAdminPassword(req, admin_password))) {
      keyAuthFailures.set(ip, [...(keyAuthFailures.get(ip) || []), Date.now()]);
      await logAction(req.user.id, 'ADMIN_APIKEY_AUTH_FAILED', { ip }, ip);
      return res.status(401).json({ error: 'Senha do administrador incorreta.' });
    }
    const check = await testOpenRouterKey(candidate);
    if (!check.valid) {
      return res.status(422).json({ error: `A chave nao passou no teste: ${check.error}` });
    }
    keyAuthFailures.delete(ip);

    const keyId = uuidv4();
    await runAsync(`UPDATE api_keys SET is_active = 0 WHERE provider = 'openrouter'`);
    await runAsync(
      `INSERT INTO api_keys (id, provider, name, key_value, is_active, last_check_at, last_check_ok, last_check_info)
       VALUES (?, 'openrouter', ?, ?, 1, CURRENT_TIMESTAMP, 1, ?)`,
      [keyId, name || 'Chave OpenRouter', secrets.encrypt(candidate), JSON.stringify(check.info)]
    );
    await logAction(req.user.id, 'ADMIN_APIKEY_ADDED', { name, masked: secrets.mask(candidate) }, ip);
    res.json({ success: true, id: keyId, masked_key: secrets.mask(candidate), info: check.info });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/admin/apikeys/:id/activate', authenticateToken, requireAdmin, async (req, res) => {
  try {
    await runAsync(`UPDATE api_keys SET is_active = 0 WHERE provider = 'openrouter'`);
    await runAsync(`UPDATE api_keys SET is_active = 1 WHERE id = ?`, [req.params.id]);
    await logAction(req.user.id, 'ADMIN_APIKEY_ACTIVATED', { key_id: req.params.id }, req.ip);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/admin/apikeys/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    await runAsync(`DELETE FROM api_keys WHERE id = ?`, [req.params.id]);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Logs do Sistema e Auditoria
app.get('/api/admin/logs', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const logs = await allAsync(
      `SELECT l.*, u.email as user_email FROM system_logs l LEFT JOIN users u ON l.user_id = u.id ORDER BY l.timestamp DESC LIMIT 100`
    );
    res.json(logs);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Configurações Globais do SaaS (Públicas e Admin)
app.get('/api/settings', async (req, res) => {
  try {
    const settings = await allAsync(`SELECT * FROM system_settings`);
    const settingsMap = {};
    settings.forEach(s => settingsMap[s.key] = s.value);
    res.json(settingsMap);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/admin/settings', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const settings = await allAsync(`SELECT * FROM system_settings`);
    const settingsMap = {};
    settings.forEach(s => settingsMap[s.key] = s.value);
    res.json(settingsMap);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/admin/settings', authenticateToken, requireAdmin, async (req, res) => {
  const { settings } = req.body;
  try {
    for (const [key, value] of Object.entries(settings || {})) {
      await runAsync(`INSERT OR REPLACE INTO system_settings (key, value) VALUES (?, ?)`, [key, String(value)]);
    }
    await logAction(req.user.id, 'ADMIN_SETTINGS_UPDATED', settings, req.ip);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Endpoint para obter progresso da transcrição
app.get('/api/transcriptions/:id/status', authenticateToken, async (req, res) => {
  try {
    const owned = await ownedTranscription(req.params.id, scopeOf(req));
    if (!owned) {
      return res.status(404).json({ error: 'Transcrição não encontrada.' });
    }
    const row = await getAsync(`SELECT status, stage, progress, error_message, ai_summary FROM transcriptions WHERE id = ?`, [req.params.id]);
    const chunks = await getJobProgress(req.params.id);
    res.json({
      success: true,
      status: row.status,
      stage: row.stage,
      progress: row.progress,
      error_message: row.error_message,
      ...chunks,
      ai_summary: row.status.startsWith('completed') ? row.ai_summary : null
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Iniciar Servidor Express
databaseReady.then(async () => {
  const queue = await startQueueWorker();
  const server = app.listen(PORT, () => {
  console.log(`=======================================================`);
  console.log(`🚀 Servidor TurboScribe Local rodando na porta ${PORT}`);
  console.log(`🔗 Acesso local: http://localhost:${PORT}`);
  console.log(`🔑 Configure a chave OpenRouter em: sidebar → CONFIGURAR CHAVE`);
  console.log(`=======================================================`);
  });
  const shutdown = () => { server.close(); queue.stop().finally(() => process.exit(0)); };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}).catch(error => { console.error('Falha ao iniciar servidor:', error.message); process.exit(1); });
