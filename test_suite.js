const fetch = require('node-fetch');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');
const { getAsync, allAsync } = require('./db');

const BASE_URL = 'http://localhost:3000';
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
      if (row && (row.status === 'completed' || row.status === 'failed')) return row.status;
      await new Promise(r => setTimeout(r, 2000));
    }
    return 'timeout';
  }

  // TEST 1: Verificação da Chave OpenRouter no Banco SQLite
  try {
    const keyRow = await getAsync(`SELECT key_value FROM api_keys WHERE provider = 'openrouter' AND is_active = 1`);
    assert(keyRow && keyRow.key_value.startsWith('sk-or-v1-'), 'Chave OpenRouter ativa e formatada no banco SQLite.');
  } catch (e) {
    assert(false, 'Erro ao verificar chave no banco: ' + e.message);
  }

  // TEST 2, 3, 4: Transcrição nos 3 Níveis (Chita, Golfinho, Baleia)
  const modes = [
    { mode: 'chita', label: 'Nível 1 - Chita (Fast)' },
    { mode: 'golfinho', label: 'Nível 2 - Golfinho (Balanced)' },
    { mode: 'baleia', label: 'Nível 3 - Baleia (High Precision)' }
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
        headers: { 'Content-Type': 'application/json' },
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
        const expRes = await fetch(`${BASE_URL}/api/export/${targetId}/${fmt}?timestamps=true`);
        assert(expRes.ok && expRes.headers.get('content-type'), `Exportação no formato .${fmt.toUpperCase()} gerada com sucesso (Status ${expRes.status})`);
      } catch (e) {
        assert(false, `Falha na exportação formato ${fmt}: ${e.message}`);
      }
    }
  }

  // TEST 7: Testar Chat IA via OpenRouter API (POST /api/chat)
  try {
    const chatRes = await fetch(`${BASE_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
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
      headers: { 'Content-Type': 'application/json' },
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
    const adminRes = await fetch(`${BASE_URL}/api/admin/metrics`);
    assert(adminRes.ok, 'Endpoint de métricas do Painel Admin respondeu com sucesso');
    const metrics = await adminRes.json();
    assert(metrics.users_total > 0 && metrics.transcriptions_count > 0, `Métricas calculadas: ${metrics.users_total} usuários, ${metrics.transcriptions_count} transcrições.`);
  } catch (e) {
    assert(false, 'Falha no teste de métricas do Admin: ' + e.message);
  }

  console.log('\n=======================================================');
  console.log(`📊 RESULTADO FINAL: ${passedTests}/${totalTests} TESTES PASSARAM COM SUCESSO!`);
  console.log('=======================================================\n');

  process.exit(passedTests === totalTests ? 0 : 1);
}

runTestSuite();
