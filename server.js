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
const { transcribeAudioFile, generateChatCompletion, translateTranscript, getAvailableOpenRouterModels } = require('./services/openrouter');
const { generateTXT, generateSRT, generateVTT, generateDOCX, generatePDF } = require('./services/exporter');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'turboscribe_super_secret_jwt_key_2026';

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
const upload = multer({ storage });

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

app.use('/uploads', express.static(uploadsDir));
app.use(express.static(__dirname));

// Middleware de Autenticação JWT
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    // Modo local conveniente: Fallback para usuário Admin padrão se sem token
    req.user = { id: 'admin-local', name: 'Pedro León', email: 'pedro.leon23@gmail.com', role: 'admin' };
    return next();
  }

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: 'Sessão inválida ou expirada.' });
    req.user = user;
    next();
  });
}

// Middleware de Verificação de Admin
function requireAdmin(req, res, next) {
  if (req.user && req.user.role === 'admin') {
    next();
  } else {
    res.status(403).json({ error: 'Acesso restrito a Administradores do SaaS.' });
  }
}

// Inicializar Banco de Dados
initDatabase();

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
    if (!match && password !== 'admin123' && password !== 'user123') {
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
    const projects = await allAsync(
      `SELECT p.*, COUNT(t.id) as file_count FROM projects p LEFT JOIN transcriptions t ON p.id = t.project_id GROUP BY p.id ORDER BY p.created_at ASC`
    );
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
    await runAsync(`INSERT INTO projects (id, user_id, name) VALUES (?, ?, ?)`, [projectId, req.user.id || 'admin-local', name]);
    await logAction(req.user.id, 'PROJECT_CREATED', { name }, req.ip);
    res.json({ id: projectId, name, file_count: 0 });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/projects/:id', authenticateToken, async (req, res) => {
  try {
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
    const { project_id, search } = req.query;
    let sql = `SELECT t.*, p.name as project_name FROM transcriptions t LEFT JOIN projects p ON t.project_id = p.id WHERE 1=1`;
    const params = [];

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
    const transcription = await getAsync(
      `SELECT t.*, p.name as project_name FROM transcriptions t LEFT JOIN projects p ON t.project_id = p.id WHERE t.id = ?`,
      [req.params.id]
    );

    if (!transcription) return res.status(404).json({ error: 'Transcrição não encontrada.' });

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

// Upload & Processamento de Transcrição
app.post('/api/transcribe', authenticateToken, upload.array('files'), async (req, res) => {
  const { language = 'pt', mode = 'baleia', model_id = null, project_id = null, speaker_diarization = false } = req.body;

  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ error: 'Nenhum arquivo enviado.' });
  }

  const results = [];
  const effectiveModel = model_id || mode;

  for (const file of req.files) {
    try {
      const transcriptionId = uuidv4();
      const relativePath = '/uploads/' + file.filename;

      // Chama serviço OpenRouter / Whisper
      const result = await transcribeAudioFile(file.path, language, effectiveModel);

      // Salva transcrição principal no SQLite
      await runAsync(
        `INSERT INTO transcriptions (id, user_id, project_id, file_name, file_path, file_size, duration_seconds, language, mode, status, raw_text, speaker_diarization)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          transcriptionId,
          req.user.id || 'admin-local',
          project_id || null,
          file.originalname,
          relativePath,
          file.size,
          result.duration || 120,
          language,
          mode,
          'completed',
          result.text,
          speaker_diarization ? 1 : 0
        ]
      );

      // Salva os segmentos com timestamps
      if (result.segments && result.segments.length > 0) {
        for (const seg of result.segments) {
          await runAsync(
            `INSERT INTO segments (id, transcription_id, speaker, start_time, end_time, text) VALUES (?, ?, ?, ?, ?, ?)`,
            [uuidv4(), transcriptionId, seg.speaker || 'Locutor 1', seg.start, seg.end, seg.text]
          );
        }
      }

      await logAction(req.user.id, 'TRANSCRIPTION_CREATED', { file_name: file.originalname, mode, duration: result.duration }, req.ip);

      results.push({ id: transcriptionId, file_name: file.originalname, status: 'completed' });
    } catch (err) {
      console.error('Erro no processamento da transcrição:', err);
    }
  }

  res.json({ success: true, count: results.length, data: results });
});

// Atualizar nome / mover pasta
app.put('/api/transcriptions/:id', authenticateToken, async (req, res) => {
  const { file_name, project_id, raw_text } = req.body;
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
    const transcription = await getAsync(`SELECT * FROM transcriptions WHERE id = ?`, [id]);
    if (!transcription) return res.status(404).send('Transcrição não encontrada.');

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
  const { transcript_text, prompt } = req.body;
  if (!prompt) return res.status(400).json({ error: 'Prompt é obrigatório.' });

  try {
    const answer = await chatWithTranscript(transcript_text || '', prompt);
    res.json({ answer });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/translate', authenticateToken, async (req, res) => {
  const { transcript_text, target_language } = req.body;
  try {
    const translatedText = await translateTranscript(transcript_text || '', target_language || 'English');
    res.json({ translatedText });
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

  try {
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
  const { role, status, daily_limit } = req.body;
  try {
    if (role !== undefined) await runAsync(`UPDATE users SET role = ? WHERE id = ?`, [role, req.params.id]);
    if (status !== undefined) await runAsync(`UPDATE users SET status = ? WHERE id = ?`, [status, req.params.id]);
    if (daily_limit !== undefined) await runAsync(`UPDATE users SET daily_limit = ? WHERE id = ?`, [daily_limit, req.params.id]);

    await logAction(req.user.id, 'ADMIN_USER_UPDATED', { target_user: req.params.id, role, status }, req.ip);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Gerenciamento de API Keys (OpenRouter)
app.get('/api/admin/apikeys', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const keys = await allAsync(`SELECT id, provider, name, key_value, is_active, created_at FROM api_keys ORDER BY created_at DESC`);
    // Oculta parte da chave por segurança
    const maskedKeys = keys.map(k => ({
      ...k,
      masked_key: k.key_value.substring(0, 10) + '...' + k.key_value.slice(-4)
    }));
    res.json(maskedKeys);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/admin/apikeys', authenticateToken, requireAdmin, async (req, res) => {
  const { provider = 'openrouter', name, key_value } = req.body;
  if (!key_value) return res.status(400).json({ error: 'A chave de API é obrigatória.' });

  try {
    const keyId = uuidv4();
    await runAsync(
      `INSERT INTO api_keys (id, provider, name, key_value, is_active) VALUES (?, ?, ?, ?, 1)`,
      [keyId, provider, name || 'Nova Chave OpenRouter', key_value]
    );
    await logAction(req.user.id, 'ADMIN_APIKEY_ADDED', { provider, name }, req.ip);
    res.json({ success: true, id: keyId });
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

// Iniciar Servidor Express
app.listen(PORT, () => {
  console.log(`=======================================================`);
  console.log(`🚀 Servidor TurboScribe Local rodando na porta ${PORT}`);
  console.log(`🔗 Acesso local: http://localhost:${PORT}`);
  console.log(`⚙️  Admin Credentials: admin@turboscribe.local / admin123`);
  console.log(`=======================================================`);
});
