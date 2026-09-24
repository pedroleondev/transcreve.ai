const fetch = require('node-fetch');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');
const { getAsync, allAsync } = require('./db');
const secrets = require('./services/secrets');

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
// Arquivo base versionado no repo (voz sintetica TTS, sem dado real de cliente) —
// nao depende de uploads/ (gitignored) nem de audio de atendimento real.
// Ver docs/workflow.md #Teste com arquivo base.
const SAMPLE_AUDIO_PATH = process.env.AUDIO_SAMPLE || path.join(__dirname, 'tests', 'fixtures', 'sample.ogg');

async function runTestSuite() {
  console.log('=======================================================');
  console.log('🧪 INICIANDO LOOP DE TESTES COMPLETO DO TURBOSCRIBE');
  console.log('=======================================================\n');

  let passedTests = 0;
  let totalTests = 0;

  function assert(condition, message) {
    totalTests++;
    if (condition) {
      console.log(`✅ [PASS ${totalTests}] ${message}`);
      passedTests++;
    } else {
      console.error(`❌ [FAIL ${totalTests}] ${message}`);
    }
  }

  // O pipeline de transcricao e ASSINCRONO: /api/transcribe responde 202 com a
  // linha em 'pending' e o worker processa em background. Precisamos aguardar a
  // conclusao antes de verificar raw_text/segments no SQLite.
  async function waitForCompletion(transId, timeoutMs = 180000) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const row = await getAsync(`SELECT status FROM transcriptions WHERE id = ?`, [transId]);
      if (row && ['completed', 'completed_with_errors', 'failed'].includes(row.status)) return row.status;
      await new Promise(r => setTimeout(r, 2000));
    }
    return 'timeout';
  }

  // SECURITY TESTS (T-01 Acceptance Criteria)
  let adminToken = '';
  let userToken = '';

  // 1. GET /api/transcriptions sem Authorization -> 401
  try {
    const res = await fetch(`${BASE_URL}/api/transcriptions`);
    assert(res.status === 401, `GET /api/transcriptions sem Authorization retornou 401 (status: ${res.status})`);
  } catch (e) {
    assert(false, `Falha ao testar GET /api/transcriptions sem token: ${e.message}`);
  }

  // 2. GET /api/admin/users sem token -> 401
  try {
    const res = await fetch(`${BASE_URL}/api/admin/users`);
    assert(res.status === 401, `GET /api/admin/users sem token retornou 401 (status: ${res.status})`);
  } catch (e) {
    assert(false, `Falha ao testar GET /api/admin/users sem token: ${e.message}`);
  }

  // 3. Login com senha errada -> 401 (senhas mestras removidas)
  try {
    const res = await fetch(`${BASE_URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'admin@turboscribe.local', password: 'senha_completamente_errada_999' })
    });
    assert(res.status === 401, `Login com senha errada retornou 401 (status: ${res.status})`);
  } catch (e) {
    assert(false, `Falha ao testar login com senha errada: ${e.message}`);
  }

  // Obter tokens de autenticação válidos
  try {
    const adminLoginRes = await fetch(`${BASE_URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'admin@turboscribe.local', password: 'admin123' })
    });
    const adminLoginData = await adminLoginRes.json();
    if (adminLoginRes.ok && adminLoginData.token) {
      adminToken = adminLoginData.token;
    }

    // Usuário COMUM dedicado da suíte: pedro.leon23@gmail.com virou admin
    // (decisão de produto T-17), então não serve mais como "userToken".
    const SUITE_USER = { name: 'Suite User', email: 'suite-user@test.local', password: 'suite123', role: 'user' };
    await fetch(`${BASE_URL}/api/admin/users`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${adminToken}` },
      body: JSON.stringify(SUITE_USER)
    }); // 201 ou 409 (já existe) — ambos OK

    const userLoginRes = await fetch(`${BASE_URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: SUITE_USER.email, password: SUITE_USER.password })
    });
    const userLoginData = await userLoginRes.json();
    if (userLoginRes.ok && userLoginData.token) {
      userToken = userLoginData.token;
    }
    assert(adminToken && userToken, 'Tokens de login para Admin e User gerados com sucesso');
  } catch (e) {
    assert(false, `Falha ao autenticar usuários de teste: ${e.message}`);
  }

  // 4. GET /api/admin/users com token de role='user' -> 403
  try {
    const res = await fetch(`${BASE_URL}/api/admin/users`, {
      headers: { 'Authorization': `Bearer ${userToken}` }
    });
    assert(res.status === 403, `GET /api/admin/users com token de usuário comum retornou 403 (status: ${res.status})`);
  } catch (e) {
    assert(false, `Falha ao testar GET /api/admin/users com token de usuário comum: ${e.message}`);
  }

  // TEST 1 (T-15): Chave OpenRouter CIFRADA em repouso e NUNCA exposta pela API.
  const UNMASKED_KEY_RE = /sk-or-v1-[A-Za-z0-9_-]{15,}/;
  try {
    const keyRow = await getAsync(`SELECT key_value FROM api_keys WHERE provider = 'openrouter' AND is_active = 1`);
    assert(keyRow && keyRow.key_value.length > 0, 'Chave OpenRouter ativa presente no banco SQLite.');
    assert(!keyRow.key_value.startsWith('sk-or-v1-'), 'Chave cifrada em repouso: key_value NAO comeca com sk-or-v1-.');
    assert(keyRow.key_value.startsWith('enc:v1:'), 'key_value no formato enc:v1:<iv>:<tag>:<ciphertext>.');
    const plainKey = secrets.decrypt(keyRow.key_value);
    assert(UNMASKED_KEY_RE.test(plainKey), 'Decifragem local com APP_SECRET_KEY devolve a chave real (sk-or-v1-...).');

    // Endpoint de teste responde 200 com a chave valida ativa (sem body = testa a ativa)
    const testRes = await fetch(`${BASE_URL}/api/admin/apikeys/test`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    const testData = await testRes.json();
    assert(testRes.status === 200 && testData.valid === true, `POST /api/admin/apikeys/test com a chave ativa retornou 200/valid (status: ${testRes.status}).`);

    // Status da sidebar: configured, mascarado, sem vazar a chave
    const statusRes = await fetch(`${BASE_URL}/api/admin/apikeys/status`, { headers: { 'Authorization': `Bearer ${adminToken}` } });
    const statusData = await statusRes.json();
    assert(statusRes.status === 200 && statusData.configured === true, 'GET /api/admin/apikeys/status retornou configured=true.');
    assert(!UNMASKED_KEY_RE.test(JSON.stringify(statusData)), 'Resposta de status nao expoe a chave em claro.');

    // Lista admin: so masked_key, nenhum campo key_value
    const listRes = await fetch(`${BASE_URL}/api/admin/apikeys`, { headers: { 'Authorization': `Bearer ${adminToken}` } });
    const listData = await listRes.json();
    assert(Array.isArray(listData) && listData.length > 0, 'GET /api/admin/apikeys listou as chaves.');
    assert(listData.every(k => !('key_value' in k) && typeof k.masked_key === 'string'), 'Lista expoe apenas masked_key (nenhum campo key_value).');
    assert(!UNMASKED_KEY_RE.test(JSON.stringify(listData)), 'Lista nao contem chave em claro.');
  } catch (e) {
    assert(false, 'Erro nos testes de cifra/vazamento da chave: ' + e.message);
  }

  // T-15 (revisao retomada): o diretorio do projeto NAO e publico
  for (const p of ['/turboscribe.sqlite', '/.env', '/server.js', '/services/secrets.js', '/db.js']) {
    try {
      const res = await fetch(`${BASE_URL}${p}`);
      assert(res.status === 404, `GET ${p} retornou 404 (status: ${res.status}).`);
    } catch (e) {
      assert(false, `Falha ao testar GET ${p}: ${e.message}`);
    }
  }

  // Sanity: a SPA continua servida com as rotas estaticas explicitas
  try {
    const resIndex = await fetch(`${BASE_URL}/`);
    assert(resIndex.status === 200, `GET / retornou 200 (status: ${resIndex.status}).`);
    const resApp = await fetch(`${BASE_URL}/app.js`);
    assert(resApp.status === 200, `GET /app.js retornou 200 (status: ${resApp.status}).`);
  } catch (e) {
    assert(false, 'Falha ao testar se a SPA continua servida: ' + e.message);
  }

  // T-15: salvar/trocar chave exige a senha do admin autenticado (com a propria chave ativa)
  try {
    const activeRow = await getAsync(`SELECT key_value FROM api_keys WHERE provider = 'openrouter' AND is_active = 1`);
    const saveRes = await fetch(`${BASE_URL}/api/admin/apikeys`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ key_value: secrets.decrypt(activeRow.key_value), admin_password: 'admin123' })
    });
    const saveData = await saveRes.json();
    assert(saveRes.status === 200 && saveData.success, `Salvar chave com senha de admin correta retornou 200 (status: ${saveRes.status}).`);
    assert(saveData.masked_key && saveData.masked_key.includes('…') && !UNMASKED_KEY_RE.test(saveData.masked_key), 'Salvar devolveu apenas a chave mascarada.');
  } catch (e) {
    assert(false, 'Erro no teste de salvamento da chave: ' + e.message);
  }

  // T-15: senha errada -> 401; 5 falhas em 10 min -> bloqueio 429 (por IP)
  try {
    let blockedStatus = null;
    for (let i = 1; i <= 6; i++) {
      const res = await fetch(`${BASE_URL}/api/admin/apikeys`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ key_value: 'sk-or-v1-invalida_para_teste_de_bloqueio', admin_password: 'senha_errada_de_proposito' })
      });
      if (i <= 5) {
        assert(res.status === 401, `Tentativa ${i} com senha errada retornou 401 (status: ${res.status}).`);
      } else {
        blockedStatus = res.status;
      }
    }
    assert(blockedStatus === 429, `Apos 5 falhas, a 6a tentativa foi bloqueada com 429 (status: ${blockedStatus}).`);
  } catch (e) {
    assert(false, 'Erro no teste de bloqueio por tentativas: ' + e.message);
  }

  // TEST 2, 3, 4: Transcrição nos 3 Níveis (Base, Pro, Max)
  const modes = [
    { mode: 'base', label: 'Nível 1 - Base' },
    { mode: 'pro', label: 'Nível 2 - Pro' },
    { mode: 'max', label: 'Nível 3 - Max' }
  ];

  const createdTranscriptionIds = [];

  for (const m of modes) {
    try {
      console.log(`\n🔹 Testando transcrição: ${m.label}...`);
      const formData = new FormData();
      formData.append('files', fs.createReadStream(SAMPLE_AUDIO_PATH));
      formData.append('language', 'pt');
      formData.append('mode', m.mode);
      formData.append('speaker_diarization', 'true');

      const res = await fetch(`${BASE_URL}/api/transcribe`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${adminToken}` },
        body: formData
      });

      assert(res.ok, `Requisição de transcrição para modo ${m.mode} retornou status ${res.status}`);
      const data = await res.json();
      assert(data.success && data.data.length > 0, `Transcrição concluída com sucesso para modo ${m.mode}`);

      if (data.data && data.data[0]) {
        const transId = data.data[0].id;
        createdTranscriptionIds.push(transId);

        const finalStatus = await waitForCompletion(transId);
        assert(finalStatus === 'completed', `Worker concluiu a transcricao ${transId} (status: ${finalStatus})`);

        // Checar gravação no banco SQLite
        const dbRecord = await getAsync(`SELECT * FROM transcriptions WHERE id = ?`, [transId]);
        assert(dbRecord && dbRecord.raw_text && dbRecord.raw_text.length > 0, `Texto armazenado com sucesso no SQLite para id ${transId}`);
        // Apos a conclusao, 'mode' guarda o MODELO REALMENTE USADO (services/openrouter.js
        // tem fallback automatico de modelo), e nao mais o apelido do nivel.
        assert(
          typeof dbRecord.mode === 'string' && dbRecord.mode.includes('/'),
          `Modelo realmente usado gravado no SQLite para o nivel ${m.mode}: ${dbRecord.mode}`
        );

        // Checar segmentos
        const segments = await allAsync(`SELECT * FROM segments WHERE transcription_id = ?`, [transId]);
        assert(segments.length > 0, `${segments.length} segmento(s) com carimbos de tempo criados no SQLite.`);
      }
    } catch (e) {
      assert(false, `Falha no teste de transcrição modo ${m.mode}: ${e.message}`);
    }
  }

  // TEST 5: Atualização de Descrição / Texto na Transcrição (PUT /api/transcriptions/:id)
  if (createdTranscriptionIds.length > 0) {
    const targetId = createdTranscriptionIds[0];
    try {
      const updatedText = 'Ah, tá ótimo. Eu queria saber sobre a carta de carência, porque é o seguinte. [Texto editado manualmente e persistido no SQLite]';
      const putRes = await fetch(`${BASE_URL}/api/transcriptions/${targetId}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${adminToken}`
        },
        body: JSON.stringify({ raw_text: updatedText })
      });
      assert(putRes.ok, `Atualização da descrição via API retornou HTTP status 200`);

      const dbUpdated = await getAsync(`SELECT raw_text FROM transcriptions WHERE id = ?`, [targetId]);
      assert(dbUpdated && dbUpdated.raw_text === updatedText, 'Texto da descrição devidamente persistido e atualizado no SQLite');
    } catch (e) {
      assert(false, 'Falha no teste de atualização da descrição: ' + e.message);
    }
  }

  // TEST 6: Testar Exportação em Todos os Formatos (PDF, DOCX, TXT, SRT, VTT)
  if (createdTranscriptionIds.length > 0) {
    const targetId = createdTranscriptionIds[0];
    const formats = ['pdf', 'docx', 'txt', 'srt', 'vtt'];

    for (const fmt of formats) {
      try {
        const expRes = await fetch(`${BASE_URL}/api/export/${targetId}/${fmt}?timestamps=true`, {
          headers: { 'Authorization': `Bearer ${adminToken}` }
        });
        assert(expRes.ok && expRes.headers.get('content-type'), `Exportação no formato .${fmt.toUpperCase()} gerada com sucesso (Status ${expRes.status})`);
      } catch (e) {
        assert(false, `Falha na exportação formato ${fmt}: ${e.message}`);
      }
    }
  }

  // T-04: editar segmentos reais desta execucao, reabrir e exportar.
  if (createdTranscriptionIds.length) {
    try {
      const id = createdTranscriptionIds[0];
      const headers = { Authorization: 'Bearer ' + adminToken, 'Content-Type': 'application/json' };
      const original = await (await fetch(BASE_URL + '/api/transcriptions/' + id, { headers })).json();
      const edits = original.segments.map((segment, index) => ({ id: segment.id, text: segment.text + ' [edicao T-04 ' + index + ']' }));
      const saved = await fetch(BASE_URL + '/api/transcriptions/' + id, { method: 'PUT', headers, body: JSON.stringify({segments: edits}) });
      assert(saved.status === 200, 'T-04: salvar segmentos responde 200');
      const reopened = await (await fetch(BASE_URL + '/api/transcriptions/' + id, { headers })).json();
      assert(reopened.raw_text === edits.map(s => s.text).join('\n\n') && reopened.segments.every((s,i) => s.text === edits[i].text), 'T-04: reabrir preserva texto e segmentos');
      assert(reopened.segments.every((s,i) => s.start_time === original.segments[i].start_time && s.end_time === original.segments[i].end_time && s.speaker === original.segments[i].speaker), 'T-04: tempos e falantes preservados');
      for (const format of ['txt', 'srt', 'vtt']) {
        const exported = await fetch(BASE_URL + '/api/export/' + id + '/' + format + '?timestamps=true', {headers});
        assert(exported.ok && (await exported.text()).includes('[edicao T-04 0]'), 'T-04: ' + format + ' exporta edicoes');
      }
      const rejected = await fetch(BASE_URL + '/api/transcriptions/' + id, {method:'PUT', headers, body:JSON.stringify({segments:[{id:'inexistente',text:'invalid'}]})});
      assert(rejected.status === 400, 'T-04: segmento estrangeiro/inexistente rejeitado');
    } catch(error) { assert(false, 'T-04: ' + error.message); }
  }

  // TEST 7: Testar Chat IA via OpenRouter API (POST /api/chat)
  try {
    const chatRes = await fetch(`${BASE_URL}/api/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${adminToken}`
      },
      body: JSON.stringify({
        transcript_text: 'O cliente perguntou sobre a carta de carência do plano de saúde para o exame de ultrassom.',
        prompt: 'Resuma a dúvida do cliente em 1 frase.'
      })
    });
    assert(chatRes.ok, 'Endpoint do ChatGPT via OpenRouter respondeu com sucesso');
    const chatData = await chatRes.json();
    assert(chatData.answer && chatData.answer.length > 0, 'Resposta gerada pelo ChatGPT recebida com sucesso');
  } catch (e) {
    assert(false, 'Falha no teste de Chat IA: ' + e.message);
  }

  // TEST 8: Testar Tradução via OpenRouter API (POST /api/translate)
  try {
    const transRes = await fetch(`${BASE_URL}/api/translate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${adminToken}`
      },
      body: JSON.stringify({
        transcript_text: 'Eu queria saber sobre a carta de carência.',
        target_language: 'English'
      })
    });
    assert(transRes.ok, 'Endpoint de Tradução via OpenRouter respondeu com sucesso');
    const transData = await transRes.json();
    assert(transData.translatedText && transData.translatedText.length > 0, 'Tradução recebida com sucesso');
  } catch (e) {
    assert(false, 'Falha no teste de Tradução: ' + e.message);
  }

  // TEST 9: Testar Métricas do Painel Admin (GET /api/admin/metrics)
  try {
    const adminRes = await fetch(`${BASE_URL}/api/admin/metrics`, {
      headers: { 'Authorization': `Bearer ${adminToken}` }
    });
    assert(adminRes.ok, 'Endpoint de métricas do Painel Admin respondeu com sucesso');
    const metrics = await adminRes.json();
    assert(metrics.users_total > 0 && metrics.transcriptions_count > 0, `Métricas calculadas: ${metrics.users_total} usuários, ${metrics.transcriptions_count} transcrições.`);
  } catch (e) {
    assert(false, 'Falha no teste de métricas do Admin: ' + e.message);
  }

  // ------------------------------------------------------------------
  // T-18: Aprimoramento de transcrição por IA (rotas, glossário, settings)
  // Atenção: estes testes NÃO disparam chamada paga à OpenRouter — cobrem
  // auth, CRUD do dicionário e persistência das configurações de análise.
  // ------------------------------------------------------------------

  // T-18a: rotas de análise exigem autenticação (401 sem token, sem custo)
  try {
    const noAuth1 = await fetch(`${BASE_URL}/api/glossary`);
    assert(noAuth1.status === 401, `GET /api/glossary sem token retornou 401 (status: ${noAuth1.status})`);
    if (createdTranscriptionIds.length > 0) {
      const tid = createdTranscriptionIds[0];
      const noAuth2 = await fetch(`${BASE_URL}/api/transcriptions/${tid}/analyses`);
      assert(noAuth2.status === 401, `GET analyses sem token retornou 401 (status: ${noAuth2.status})`);
      const noAuth3 = await fetch(`${BASE_URL}/api/transcriptions/${tid}/enhance`, { method: 'POST' });
      assert(noAuth3.status === 401, `POST enhance sem token retornou 401 (status: ${noAuth3.status})`);
    }
  } catch (e) {
    assert(false, 'Falha nos testes de auth das rotas T-18: ' + e.message);
  }

  // T-18b: CRUD do dicionário de correções (glossário)
  let glossaryTermId = null;
  try {
    const addRes = await fetch(`${BASE_URL}/api/admin/glossary`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${adminToken}` },
      body: JSON.stringify({ wrong: 'termoteste-t18', correct: 'Termo Teste T-18' })
    });
    assert(addRes.status === 200, `POST /api/admin/glossary adicionou termo (status: ${addRes.status})`);
    const addData = await addRes.json();
    glossaryTermId = addData.id;

    const dupRes = await fetch(`${BASE_URL}/api/admin/glossary`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${adminToken}` },
      body: JSON.stringify({ wrong: 'termoteste-t18', correct: 'Duplicado' })
    });
    assert(dupRes.status === 409, `Termo duplicado rejeitado com 409 (status: ${dupRes.status})`);

    const listRes = await fetch(`${BASE_URL}/api/glossary`, { headers: { 'Authorization': `Bearer ${adminToken}` } });
    const listData = await listRes.json();
    assert(Array.isArray(listData) && listData.some(g => g.wrong === 'termoteste-t18' && g.correct === 'Termo Teste T-18'), 'Termo persistido e listado no glossário');

    // usuário comum não pode adicionar (403)
    const userAddRes = await fetch(`${BASE_URL}/api/admin/glossary`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${userToken}` },
      body: JSON.stringify({ wrong: 'x', correct: 'y' })
    });
    assert(userAddRes.status === 403, `Usuário comum bloqueado (403) no POST do glossário (status: ${userAddRes.status})`);
  } catch (e) {
    assert(false, 'Falha no CRUD do glossário: ' + e.message);
  }

  // T-18c: configurações de análise (modelo + prompt) persistem via settings
  let savedAnalysisModel = null;
  try {
    const beforeRes = await fetch(`${BASE_URL}/api/admin/settings`, { headers: { 'Authorization': `Bearer ${adminToken}` } });
    const before = await beforeRes.json();
    savedAnalysisModel = before.analysis_model || 'openai/gpt-4o-mini';

    const putRes = await fetch(`${BASE_URL}/api/admin/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${adminToken}` },
      body: JSON.stringify({ settings: { analysis_model: 'openai/gpt-4o-mini', analysis_prompt: '' } })
    });
    assert(putRes.ok, 'PUT settings com analysis_model/analysis_prompt retornou sucesso');

    const afterRes = await fetch(`${BASE_URL}/api/admin/settings`, { headers: { 'Authorization': `Bearer ${adminToken}` } });
    const after = await afterRes.json();
    assert(after.analysis_model === 'openai/gpt-4o-mini', `analysis_model persistido: ${after.analysis_model}`);
    assert('analysis_prompt' in after, 'analysis_prompt presente nas settings');
  } catch (e) {
    assert(false, 'Falha nas settings de análise: ' + e.message);
  }

  // T-18d: limpeza do termo de teste do glossário
  try {
    if (glossaryTermId) {
      const delRes = await fetch(`${BASE_URL}/api/admin/glossary/${glossaryTermId}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${adminToken}` }
      });
      assert(delRes.ok, 'Termo de teste removido do glossário');
    }
  } catch (e) {
    assert(false, 'Falha ao limpar glossário: ' + e.message);
  }

  // Limpar usuário comum dedicado da suíte
  try {
    await runAsync(`DELETE FROM users WHERE email = 'suite-user@test.local'`);
  } catch (e) { /* usuário já removido ou ausente */ }

  console.log('\n=======================================================');
  console.log(`📊 RESULTADO FINAL: ${passedTests}/${totalTests} TESTES PASSARAM COM SUCESSO!`);
  console.log('=======================================================\n');

  process.exit(passedTests === totalTests ? 0 : 1);
}

runTestSuite();
