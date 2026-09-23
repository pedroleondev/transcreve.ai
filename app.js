// Estado Global da Aplicação Frontend
const state = {
  currentUser: { id: 'admin-local', name: 'Pedro León', email: 'pedro.leon23@gmail.com', role: 'user' },
  token: localStorage.getItem('turboscribe_token') || '',
  currentView: 'dashboard',
  projects: [],
  transcriptions: [],
  currentProjectId: null,
  activeTranscription: null,
  selectedFiles: [],
  selectedMode: 'max', // SELEÇÃO PADRÃO SISTEMA = MAX (SOLICITAÇÃO CEO)
  selectedModelId: 'openai/whisper-large-v3',
  openRouterModels: [],
  totalAudioSeconds: 0,
  systemSettings: {},
  // Gravador de Voz
  mediaRecorder: null,
  audioChunks: [],
  recordingInterval: null,
  recordingSeconds: 0,
  recordedBlob: null,
  // Polling de progresso
  pollingInterval: null,
  activeJobIds: [], // IDs de transcrições em pending/processing para polling
  // Preferências de Leitura (T-04)
  readingMode: localStorage.getItem('transcreveai_reading_mode') || 'transcript', // 'transcript' | 'reading' | 'summary'
  fontSize: localStorage.getItem('transcreveai_font_size') || 'md', // 'sm' | 'md' | 'lg'
  columnWidth: localStorage.getItem('transcreveai_column_width') || 'normal' // 'narrow' | 'normal' | 'wide'
};

// Garantir token válido de autenticação (auto-login fallback se necessário)
async function ensureAuthToken() {
  if (state.token) return true;
  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'pedro.leon23@gmail.com', password: 'user123' })
    });
    const data = await res.json();
    if (res.ok && data.token) {
      state.token = data.token;
      state.currentUser = data.user;
      localStorage.setItem('turboscribe_token', data.token);
      return true;
    }
  } catch (e) {
    console.warn('Auto-login fallback falhou:', e);
  }
  return false;
}

// Inicialização
document.addEventListener('DOMContentLoaded', async () => {
  if (window.lucide) lucide.createIcons();
  await ensureAuthToken();
  fetchSystemSettings();
  fetchOpenRouterModels();
  fetchProjects();
  fetchTranscriptions();
  setupDragAndDrop();
  await checkAuthUser(); // papel real ANTES de consultar o estado da chave
  loadApiKeyStatus();
});

// Buscar catálogo de modelos OpenRouter com precificação e acurácia
async function fetchOpenRouterModels() {
  try {
    const res = await fetch('/api/openrouter/models');
    const data = await res.json();
    state.openRouterModels = Array.isArray(data) ? data : [];
    populateOpenRouterModelsSelect();
  } catch (e) {
    console.warn('Erro ao buscar modelos OpenRouter:', e);
  }
}

function populateOpenRouterModelsSelect() {
  const select = document.getElementById('openrouter-model-select');
  if (!select) return;

  if (state.openRouterModels.length === 0) return;

  select.innerHTML = state.openRouterModels.map(m => `
    <option value="${m.id}" ${m.id === state.selectedModelId ? 'selected' : ''}>
      ${m.name} — $${m.price_per_minute_usd.toFixed(4)}/min (${m.precision_percentage} PT-BR ⭐${m.precision_rating})
    </option>
  `).join('');

  updatePriceAndPrecisionEstimate();
}

// Buscar configurações globais (modelos, modos ativos)
async function fetchSystemSettings() {
  try {
    const res = await fetch('/api/settings');
    const data = await res.json();
    state.systemSettings = data || {};
    applySystemSettingsUI();
  } catch (e) {
    console.warn('Usando modelos padrão.');
  }
}

function applySystemSettingsUI() {
  const baseModelEl = document.getElementById('base-model-name');
  const proModelEl = document.getElementById('pro-model-name');
  const maxModelEl = document.getElementById('max-model-name');

  if (baseModelEl) baseModelEl.innerText = state.systemSettings.base_model || 'openai/whisper-1';
  if (proModelEl) proModelEl.innerText = state.systemSettings.pro_model || 'openai/whisper-large-v3-turbo';
  if (maxModelEl) maxModelEl.innerText = state.systemSettings.max_model || 'openai/whisper-large-v3';

  // Ocultar modos se desabilitados pelo Admin
  const modeBaseCard = document.getElementById('mode-base');
  const modeProCard = document.getElementById('mode-pro');
  const modeMaxCard = document.getElementById('mode-max');

  if (modeBaseCard && state.systemSettings.base_enabled === 'false') modeBaseCard.style.display = 'none';
  if (modeProCard && state.systemSettings.pro_enabled === 'false') modeProCard.style.display = 'none';
  if (modeMaxCard && state.systemSettings.max_enabled === 'false') modeMaxCard.style.display = 'none';

  selectMode(state.selectedMode);
}

// Checar Usuário Autenticado
async function checkAuthUser() {
  try {
    const res = await fetch('/api/auth/me', {
      headers: { 'Authorization': `Bearer ${state.token}` }
    });
    const data = await res.json();
    if (data.user) {
      state.currentUser = data.user;
      document.getElementById('current-user-email').innerText = data.user.email;
      document.getElementById('user-dropdown-name').innerText = data.user.name;
      document.getElementById('user-dropdown-role').innerText = data.user.role === 'admin' ? 'Admin SaaS' : 'Usuário';

      const adminLink = document.getElementById('admin-menu-link');
      if (adminLink) {
        adminLink.style.display = data.user.role === 'admin' ? 'flex' : 'none';
      }
    }
  } catch (e) {
    console.warn('Usando usuário padrão local.');
  }
}

// Drag & Drop Setup (Suporta arrastar da barra de downloads do navegador, SO e Explorer)
function setupDragAndDrop() {
  window.addEventListener('dragover', (e) => {
    e.preventDefault();
  }, false);

  window.addEventListener('drop', (e) => {
    e.preventDefault();
    const files = e.dataTransfer.files;
    if (files && files.length > 0) {
      state.selectedFiles = Array.from(files);
      openTranscribeModal();
      calculateSelectedFilesDuration();
    }
  }, false);

  const dropZone = document.getElementById('drop-zone');
  if (!dropZone) return;

  ['dragenter', 'dragover'].forEach(eventName => {
    dropZone.addEventListener(eventName, (e) => {
      e.preventDefault();
      dropZone.classList.add('drop-active');
    }, false);
  });

  ['dragleave', 'drop'].forEach(eventName => {
    dropZone.addEventListener(eventName, (e) => {
      e.preventDefault();
      dropZone.classList.remove('drop-active');
    }, false);
  });

  dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    const dt = e.dataTransfer;
    const files = dt.files;
    if (files && files.length > 0) {
      state.selectedFiles = Array.from(files);
      calculateSelectedFilesDuration();
    }
  });
}

// Calcular Duração Real dos Áudios Selecionados
function calculateSelectedFilesDuration() {
  const preview = document.getElementById('selected-files-preview');
  if (preview) {
    preview.innerText = `${state.selectedFiles.length} arquivo(s) selecionado(s): ` + state.selectedFiles.map(f => f.name).join(', ');
  }

  state.totalAudioSeconds = 0;
  let filesLoaded = 0;

  if (state.selectedFiles.length === 0) {
    updatePriceAndPrecisionEstimate();
    return;
  }

  state.selectedFiles.forEach(file => {
    const audio = new Audio();
    const objectUrl = URL.createObjectURL(file);
    audio.src = objectUrl;

    audio.onloadedmetadata = () => {
      if (audio.duration && !isNaN(audio.duration)) {
        state.totalAudioSeconds += audio.duration;
      }
      filesLoaded++;
      URL.revokeObjectURL(objectUrl);
      if (filesLoaded === state.selectedFiles.length) {
        updatePriceAndPrecisionEstimate();
      }
    };

    audio.onerror = () => {
      filesLoaded++;
      URL.revokeObjectURL(objectUrl);
      if (filesLoaded === state.selectedFiles.length) {
        updatePriceAndPrecisionEstimate();
      }
    };
  });
}

// Atualiza a estimativa de preço aproximado e precisão PT-BR no modal
function updatePriceAndPrecisionEstimate() {
  const select = document.getElementById('openrouter-model-select');
  if (select) {
    state.selectedModelId = select.value;
  }

  const model = state.openRouterModels.find(m => m.id === state.selectedModelId) || {
    id: state.selectedModelId,
    name: 'OpenAI Whisper Large v3',
    price_per_minute_usd: 0.006,
    precision_rating: 5.0,
    precision_percentage: '99.2%',
    description: 'Maior acurácia do mercado para português do Brasil.'
  };

  const totalSecs = Math.round(state.totalAudioSeconds || 0);
  const minutes = totalSecs / 60;
  const priceUSD = minutes * model.price_per_minute_usd;
  const priceBRL = priceUSD * 5.80; // Taxa aproximada USD -> BRL

  const durationEl = document.getElementById('estimate-duration');
  const priceUsdEl = document.getElementById('estimate-price-usd');
  const priceBrlEl = document.getElementById('estimate-price-brl');
  const precisionEl = document.getElementById('estimate-precision');
  const modelDescEl = document.getElementById('estimate-model-desc');

  if (durationEl) durationEl.innerText = `Duração: ${formatSRTTimeShort(totalSecs)} (${totalSecs}s)`;
  if (priceUsdEl) priceUsdEl.innerHTML = `$${priceUSD.toFixed(4)} <span id="estimate-price-brl" class="text-[10px] text-slate-300 font-normal">(~R$ ${priceBRL.toFixed(3)})</span>`;
  if (precisionEl) precisionEl.innerText = `⭐ ${model.precision_rating} (${model.precision_percentage} PT-BR)`;
  if (modelDescEl) modelDescEl.innerText = model.description;
}

// Alternar Views da SPA (dashboard, details, admin)
function showView(viewName) {
  state.currentView = viewName;
  document.getElementById('view-dashboard').classList.add('hidden');
  document.getElementById('view-details').classList.add('hidden');
  document.getElementById('view-admin').classList.add('hidden');
  closeSidebar(); // T-17: drawer fecha ao navegar (mobile)

  if (viewName === 'dashboard') {
    document.getElementById('view-dashboard').classList.remove('hidden');
    fetchTranscriptions();
  } else if (viewName === 'details') {
    document.getElementById('view-details').classList.remove('hidden');
  } else if (viewName === 'admin') {
    document.getElementById('view-admin').classList.remove('hidden');
    loadAdminMetrics();
  }
}

// ---------------------------------------------------
// T-17: SIDEBAR DRAWER (off-canvas no mobile, fixa no desktop)
// ---------------------------------------------------
function openSidebar() {
  const sb = document.getElementById('app-sidebar');
  const ov = document.getElementById('sidebar-overlay');
  if (sb) sb.classList.remove('-translate-x-full');
  if (ov) ov.classList.remove('hidden');
}

function closeSidebar() {
  const sb = document.getElementById('app-sidebar');
  const ov = document.getElementById('sidebar-overlay');
  if (sb) sb.classList.add('-translate-x-full');
  if (ov) ov.classList.add('hidden');
}

// Busca em Tempo Real (tabela no desktop + cards no mobile)
function handleSearch() {
  const query = (document.getElementById('search-input')?.value || '').toLowerCase().trim();
  const rows = document.querySelectorAll('#transcriptions-tbody tr');
  const cards = document.querySelectorAll('#transcriptions-cards .transcription-card');

  rows.forEach(row => {
    const text = row.innerText.toLowerCase();
    row.style.display = (!query || text.includes(query)) ? '' : 'none';
  });
  cards.forEach(card => {
    const text = card.innerText.toLowerCase();
    card.style.display = (!query || text.includes(query)) ? '' : 'none';
  });
}

// ---------------------------------------------------
// GERENCIAMENTO DE PROJETOS & TRANSCRIÇÕES
// ---------------------------------------------------

async function fetchProjects() {
  try {
    let res = await fetch('/api/projects', {
      headers: { 'Authorization': `Bearer ${state.token}` }
    });
    if (res.status === 401 || res.status === 403) {
      state.token = '';
      localStorage.removeItem('turboscribe_token');
      const relogged = await ensureAuthToken();
      if (relogged) {
        res = await fetch('/api/projects', {
          headers: { 'Authorization': `Bearer ${state.token}` }
        });
      }
    }
    const projects = await res.json();
    state.projects = Array.isArray(projects) ? projects : [];
    renderProjectsSidebar();
    populateProjectSelects();
  } catch (e) {
    console.error('Erro ao buscar projetos:', e);
  }
}

function renderProjectsSidebar() {
  const container = document.getElementById('projects-list');
  if (!container) return;

  container.innerHTML = state.projects.map(p => `
    <div class="group/project flex items-center justify-between px-3 py-2 rounded-lg text-xs font-semibold ${state.currentProjectId === p.id ? 'bg-slate-800 text-blue-400' : 'text-slate-400 hover:bg-slate-800 hover:text-slate-200'} transition cursor-pointer">
      <button onclick="filterByProject('${p.id}')" class="flex items-center space-x-2.5 truncate flex-1 text-left">
        <i data-lucide="folder" class="w-4 h-4 text-slate-400 shrink-0"></i>
        <span class="truncate">${escapeHtml(p.name)}</span>
      </button>
      <div class="flex items-center space-x-1">
        <button onclick="openEditProjectModal('${p.id}', '${escapeHtml(p.name)}'); event.stopPropagation();" class="opacity-0 group-hover/project:opacity-100 text-slate-400 hover:text-blue-400 p-1 transition" title="Editar Projeto">
          <i data-lucide="pencil" class="w-3.5 h-3.5"></i>
        </button>
        <button onclick="deleteProject('${p.id}', '${escapeHtml(p.name)}'); event.stopPropagation();" class="opacity-0 group-hover/project:opacity-100 text-slate-400 hover:text-red-400 p-1 transition" title="Excluir Projeto">
          <i data-lucide="trash-2" class="w-3.5 h-3.5"></i>
        </button>
      </div>
    </div>
  `).join('');

  if (window.lucide) lucide.createIcons();
}

async function openNewProjectModal() {
  const name = prompt('Nome do novo projeto:');
  if (!name || !name.trim()) return;

  try {
    const res = await fetch('/api/projects', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${state.token}`
      },
      body: JSON.stringify({ name: name.trim() })
    });
    if (res.ok) {
      fetchProjects();
    } else {
      const err = await res.json();
      alert('Erro ao criar projeto: ' + (err.error || 'Erro desconhecido'));
    }
  } catch (e) {
    alert('Erro ao criar projeto: ' + e.message);
  }
}

async function openEditProjectModal(id, currentName) {
  const newName = prompt('Editar nome do projeto:', currentName);
  if (!newName || !newName.trim() || newName.trim() === currentName) return;

  try {
    const res = await fetch(`/api/projects/${id}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${state.token}`
      },
      body: JSON.stringify({ name: newName.trim() })
    });
    if (res.ok) {
      fetchProjects();
    } else {
      const err = await res.json();
      alert('Erro ao atualizar projeto: ' + (err.error || 'Erro desconhecido'));
    }
  } catch (e) {
    alert('Erro ao atualizar projeto: ' + e.message);
  }
}

async function deleteProject(id, name) {
  if (!confirm(`Tem certeza que deseja excluir o projeto "${name}"?\nAs transcrições associadas NÃO serão apagadas (ficarão sem projeto).`)) return;

  try {
    const res = await fetch(`/api/projects/${id}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${state.token}` }
    });
    if (res.ok) {
      if (state.currentProjectId === id) state.currentProjectId = null;
      fetchProjects();
      fetchTranscriptions();
    } else {
      const err = await res.json();
      alert('Erro ao excluir projeto: ' + (err.error || 'Erro desconhecido'));
    }
  } catch (e) {
    alert('Erro ao excluir projeto: ' + e.message);
  }
}

function filterByProject(projectId) {
  state.currentProjectId = projectId;
  renderProjectsSidebar();
  closeSidebar(); // T-17: drawer fecha ao escolher filtro (mobile)

  const titleEl = document.getElementById('dashboard-title');
  if (projectId === 'uncategorized') {
    titleEl.innerText = 'Sem projeto';
  } else if (projectId) {
    const project = state.projects.find(p => p.id === projectId);
    titleEl.innerText = project ? project.name : 'Arquivos recentes';
  } else {
    titleEl.innerText = 'Arquivos recentes';
  }

  // Sincronizar o valor selecionado nos modais
  const transcribeSelect = document.getElementById('transcribe-project-select');
  const recordSelect = document.getElementById('record-project-select');
  if (transcribeSelect) transcribeSelect.value = projectId || "";
  if (recordSelect) recordSelect.value = projectId || "";

  fetchTranscriptions();
}

function populateProjectSelects() {
  const transcribeSelect = document.getElementById('transcribe-project-select');
  const recordSelect = document.getElementById('record-project-select');
  const detailSelect = document.getElementById('detail-project-select');

  const optionsHTML = `
    <option value="">(Nenhum projeto)</option>
    ${state.projects.map(p => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join('')}
  `;

  if (transcribeSelect) {
    transcribeSelect.innerHTML = optionsHTML;
    transcribeSelect.value = state.currentProjectId || "";
  }
  if (recordSelect) {
    recordSelect.innerHTML = optionsHTML;
    recordSelect.value = state.currentProjectId || "";
  }
  if (detailSelect) {
    detailSelect.innerHTML = optionsHTML;
    if (state.activeTranscription) {
      detailSelect.value = state.activeTranscription.project_id || "";
    }
  }
}

async function updateTranscriptionProject() {
  if (!state.activeTranscription) return;
  const select = document.getElementById('detail-project-select');
  if (!select) return;

  const projectId = select.value || null;

  try {
    const res = await fetch(`/api/transcriptions/${state.activeTranscription.id}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${state.token}`
      },
      body: JSON.stringify({ project_id: projectId })
    });

    if (res.ok) {
      state.activeTranscription.project_id = projectId;
      // Atualizar o nome do projeto no meta da visualização de detalhes
      const projectObj = state.projects.find(p => p.id === projectId);
      state.activeTranscription.project_name = projectObj ? projectObj.name : null;
      
      const MODE_NAMES = { base: 'Base', pro: 'Pro', max: 'Max' };
      const MODE_DEFAULT_MODELS = { base: 'openai/whisper-1', pro: 'openai/whisper-large-v3-turbo', max: 'openai/whisper-large-v3' };
      const modeName = MODE_NAMES[state.activeTranscription.mode] || 'Max';
      const modelUsed = state.systemSettings[`${state.activeTranscription.mode}_model`] || MODE_DEFAULT_MODELS[state.activeTranscription.mode] || 'openai/whisper-large-v3';
      const projectDisplay = projectObj ? ` • Projeto: ${projectObj.name}` : '';
      document.getElementById('detail-meta').innerText = `${new Date(state.activeTranscription.created_at).toLocaleString('pt-BR')} • ${formatDuration(state.activeTranscription.duration_seconds)} • Modo ${modeName} (${modelUsed})${projectDisplay}`;

      await fetchProjects();
      await fetchTranscriptions();
    } else {
      alert('Erro ao atualizar projeto da transcrição.');
    }
  } catch (e) {
    alert('Erro ao salvar projeto: ' + e.message);
  }
}

async function fetchTranscriptions() {
  try {
    let url = '/api/transcriptions';
    if (state.currentProjectId) {
      url += `?project_id=${state.currentProjectId}`;
    }
    const res = await fetch(url, {
      headers: { 'Authorization': `Bearer ${state.token}` }
    });
    const data = await res.json();
    state.transcriptions = Array.isArray(data) ? data : [];
    renderTranscriptionsTable();
  } catch (e) {
    console.error('Erro ao buscar transcrições:', e);
  }
}

function renderTranscriptionsTable() {
  const masterCheckbox = document.getElementById('select-all-checkbox');
  if (masterCheckbox) masterCheckbox.checked = false;
  const bar = document.getElementById('bulk-actions-bar');
  if (bar) bar.classList.add('hidden');

  const tbody = document.getElementById('transcriptions-tbody');
  if (!tbody) return;

  if (state.transcriptions.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="7" class="text-center p-12 text-brand-muted dark:text-brand-muted">
          <i data-lucide="file-audio" class="w-12 h-12 mx-auto mb-3 opacity-40"></i>
          <p class="font-bold text-sm text-brand-copy dark:text-brand-copy">Nenhum arquivo transcrito ainda</p>
          <p class="text-xs text-brand-muted dark:text-brand-muted mt-1">Clique em "+ TRANSCREVER ARQUIVOS" no topo para enviar o seu primeiro áudio.</p>
        </td>
      </tr>
    `;
    const cardsEmpty = document.getElementById('transcriptions-cards');
    if (cardsEmpty) {
      cardsEmpty.innerHTML = `
        <div class="text-center p-12 text-brand-muted dark:text-brand-muted">
          <i data-lucide="file-audio" class="w-12 h-12 mx-auto mb-3 opacity-40"></i>
          <p class="font-bold text-sm text-brand-copy dark:text-brand-copy">Nenhum arquivo transcrito ainda</p>
          <p class="text-xs text-brand-muted dark:text-brand-muted mt-1">Toque em "+ TRANSCREVER ARQUIVOS" para enviar o seu primeiro áudio.</p>
        </div>`;
    }
    if (window.lucide) lucide.createIcons();
    return;
  }

  // Badges compartilhados entre a tabela (desktop) e os cards (mobile)
  function buildModeBadge(item) {
    if (item.mode === 'base' || item.mode === 'openai/whisper-1') {
      return `<span class="inline-flex items-center space-x-1.5 bg-amber-900 text-amber-100 border-2 border-amber-500 shadow-md font-black text-[11px] px-3 py-1 rounded-xl tracking-wide" title="Modelo: openai/whisper-1">
        <i data-lucide="zap" class="w-3.5 h-3.5"></i><span>Base</span>
      </span>`;
    } else if (item.mode === 'pro' || item.mode === 'openai/whisper-large-v3-turbo') {
      return `<span class="inline-flex items-center space-x-1.5 bg-teal-900 text-teal-100 border-2 border-teal-500 shadow-md font-black text-[11px] px-3 py-1 rounded-xl tracking-wide" title="Modelo: openai/whisper-large-v3-turbo">
        <i data-lucide="gauge" class="w-3.5 h-3.5"></i><span>Pro</span>
      </span>`;
    }
    return `<span class="inline-flex items-center space-x-1.5 bg-indigo-900 text-indigo-100 border-2 border-indigo-500 shadow-md font-black text-[11px] px-3 py-1 rounded-xl tracking-wide" title="Modelo: openai/whisper-large-v3">
      <i data-lucide="award" class="w-3.5 h-3.5"></i><span>Max</span>
    </span>`;
  }

  function buildStatusBadge(item) {
    const progress = item.progress || 0;
    if (item.status === 'completed') {
      return `
        <span class="inline-flex items-center space-x-1 text-emerald-600 dark:text-emerald-300 font-bold text-xs bg-emerald-50 dark:bg-emerald-950 px-2 py-0.5 rounded-full border border-emerald-200 dark:border-emerald-800">
          <i data-lucide="check-circle-2" class="w-3.5 h-3.5"></i>
          <span>Concluído</span>
        </span>`;
    } else if (item.status === 'completed_with_errors') {
      return `
        <div class="flex flex-col items-start space-y-1">
          <span title="${escapeHtml(item.error_message || '')}" class="inline-flex items-center space-x-1 text-amber-700 dark:text-amber-300 font-bold text-xs bg-amber-50 dark:bg-amber-950 px-2 py-0.5 rounded-full border border-amber-200 dark:border-amber-800 cursor-help">
            <i data-lucide="alert-triangle" class="w-3.5 h-3.5"></i>
            <span>Com falhas</span>
          </span>
          <button onclick="retryTranscription('${item.id}')" class="text-[10px] text-blue-600 dark:text-blue-300 hover:underline font-bold">Reprocessar blocos</button>
        </div>`;
    } else if (item.status === 'processing') {
      const stageLabel = {
        preprocessing: 'Normalizando', splitting: 'Fatiando', transcribing: 'Transcrevendo',
        assembling: 'Montando', analyzing: 'Resumindo'
      }[item.stage] || 'Processando';
      return `
        <div class="flex flex-col items-start space-y-1 min-w-[80px]">
          <div class="flex items-center space-x-1.5">
            <div class="w-2 h-2 bg-blue-500 rounded-full animate-pulse"></div>
            <span class="text-blue-700 dark:text-blue-300 font-bold text-xs">${stageLabel}</span>
          </div>
          <div class="w-full bg-brand-line dark:bg-brand-line rounded-full h-1.5 overflow-hidden">
            <div class="bg-gradient-to-r from-blue-500 to-indigo-500 h-1.5 rounded-full transition-all duration-700" style="width: ${progress}%"></div>
          </div>
          <span class="text-[10px] text-brand-muted dark:text-brand-muted font-mono font-bold">${progress}%</span>
        </div>`;
    } else if (item.status === 'pending') {
      return `
        <div class="flex flex-col items-start space-y-1">
          <div class="flex items-center space-x-1.5">
            <div class="w-2 h-2 bg-amber-400 rounded-full animate-pulse"></div>
            <span class="text-amber-700 dark:text-amber-300 font-bold text-xs">Na Fila</span>
          </div>
          <div class="w-full bg-brand-line dark:bg-brand-line rounded-full h-1.5 overflow-hidden">
            <div class="bg-amber-400 h-1.5 rounded-full animate-pulse" style="width: 8%"></div>
          </div>
        </div>`;
    } else if (item.status === 'failed') {
      return `
        <div class="flex flex-col items-start space-y-1">
          <span title="${escapeHtml(item.error_message || 'Erro desconhecido')}" class="inline-flex items-center space-x-1 text-red-600 dark:text-red-300 font-bold text-xs bg-red-50 dark:bg-red-950 px-2 py-0.5 rounded-full border border-red-200 dark:border-red-800 cursor-help">
            <i data-lucide="alert-circle" class="w-3.5 h-3.5"></i>
            <span>Falhou</span>
          </span>
          <button onclick="retryTranscription('${item.id}')" class="text-[10px] text-blue-600 dark:text-blue-300 hover:underline font-bold">Tentar de novo</button>
        </div>`;
    }
    return '';
  }

  tbody.innerHTML = state.transcriptions.map(item => {
    const modeBadge = buildModeBadge(item);
    const statusBadge = buildStatusBadge(item);
    const durationFormatted = formatDuration(item.duration_seconds || 0);
    const dateFormatted = new Date(item.created_at).toLocaleDateString('pt-BR', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });

    return `
      <tr class="hover:bg-brand-canvas dark:hover:bg-brand-canvas transition border-b border-brand-line dark:border-brand-line group">
        <td class="p-4"><input type="checkbox" value="${item.id}" onchange="handleRowCheckboxChange()" class="row-checkbox rounded text-blue-600 dark:text-blue-300 focus:ring-blue-500"></td>
        <td class="p-4 font-bold text-brand-ink dark:text-brand-ink">
          <div class="flex items-center space-x-2">
            <button onclick="openTranscriptionDetail('${item.id}')" class="hover:text-blue-600 dark:hover:text-blue-300 text-left truncate max-w-xs">
              ${item.project_name ? `<span class="text-[10px] text-brand-muted dark:text-brand-muted block font-normal">📁 ${escapeHtml(item.project_name)}</span>` : ''}
              <span class="font-bold">${escapeHtml(item.file_name)}</span>
            </button>
          </div>
        </td>
        <td class="p-4 text-brand-muted dark:text-brand-muted text-xs">${dateFormatted}</td>
        <td class="p-4 text-brand-copy dark:text-brand-copy font-medium text-xs">${durationFormatted}</td>
        <td class="p-4 text-xs font-semibold">${modeBadge}</td>
        <td class="p-4">
          ${statusBadge}
        </td>
        <td class="p-4 text-right relative">
          <div class="inline-block text-left group/menu">
            <button class="p-1.5 hover:bg-brand-line dark:hover:bg-brand-line rounded-lg text-brand-muted dark:text-brand-muted">
              <i data-lucide="more-horizontal" class="w-4 h-4"></i>
            </button>

            <!-- Dropdown Context Menu -->
            <div class="hidden group-hover/menu:block absolute right-0 mt-1 w-48 bg-brand-surface dark:bg-brand-surface text-brand-ink dark:text-brand-ink text-xs font-semibold rounded-xl shadow-xl border border-brand-line dark:border-brand-line py-1.5 z-30">
              <button onclick="openTranscriptionDetail('${item.id}')" class="w-full text-left px-3.5 py-2 hover:bg-brand-canvas dark:hover:bg-brand-canvas flex items-center space-x-2">
                <i data-lucide="external-link" class="w-3.5 h-3.5 text-blue-600 dark:text-blue-300"></i>
                <span>Abrir transcrição</span>
              </button>
              <button onclick="openTranscriptionDetail('${item.id}')" class="w-full text-left px-3.5 py-2 hover:bg-brand-canvas dark:hover:bg-brand-canvas flex items-center space-x-2">
                <i data-lucide="download" class="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-300"></i>
                <span>Exportar transcrição</span>
              </button>
              <button onclick="deleteTranscription('${item.id}')" class="w-full text-left px-3.5 py-2 hover:bg-brand-canvas dark:hover:bg-brand-canvas text-red-600 dark:text-red-300 flex items-center space-x-2 border-t border-brand-line dark:border-brand-line">
                <i data-lucide="trash-2" class="w-3.5 h-3.5"></i>
                <span>Excluir arquivo</span>
              </button>
            </div>
          </div>
        </td>
      </tr>
    `;
  }).join('');

  renderTranscriptionsCards(buildModeBadge, buildStatusBadge);

  if (window.lucide) lucide.createIcons();

  // Inicia polling se houver jobs ativos
  const activeJobs = state.transcriptions.filter(t => t.status === 'pending' || t.status === 'processing');
  state.activeJobIds = activeJobs.map(t => t.id);
  if (activeJobs.length > 0) {
    startProgressPolling();
  } else {
    stopProgressPolling();
  }
}

// ---------------------------------------------------
// T-17: LISTA EM CARDS (mobile < md) — mesmos dados, ações diretas de toque
// ---------------------------------------------------
function renderTranscriptionsCards(buildModeBadge, buildStatusBadge) {
  const container = document.getElementById('transcriptions-cards');
  if (!container) return;

  if (state.transcriptions.length === 0) {
    container.innerHTML = `
      <div class="text-center p-12 text-brand-muted dark:text-brand-muted">
        <i data-lucide="file-audio" class="w-12 h-12 mx-auto mb-3 opacity-40"></i>
        <p class="font-bold text-sm text-brand-copy dark:text-brand-copy">Nenhum arquivo transcrito ainda</p>
        <p class="text-xs text-brand-muted dark:text-brand-muted mt-1">Toque em "+ TRANSCREVER ARQUIVOS" para enviar o seu primeiro áudio.</p>
      </div>`;
    return;
  }

  container.innerHTML = state.transcriptions.map(item => {
    const modeBadge = buildModeBadge(item);
    const statusBadge = buildStatusBadge(item);
    const durationFormatted = formatDuration(item.duration_seconds || 0);
    const dateFormatted = new Date(item.created_at).toLocaleDateString('pt-BR', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });

    return `
      <div class="transcription-card p-4 space-y-3 hover:bg-brand-canvas dark:hover:bg-brand-canvas transition">
        <div class="flex items-start gap-3">
          <input type="checkbox" value="${item.id}" onchange="handleRowCheckboxChange()" class="row-checkbox rounded text-blue-600 dark:text-blue-300 focus:ring-blue-500 mt-1" aria-label="Selecionar ${escapeHtml(item.file_name)}">
          <button onclick="openTranscriptionDetail('${item.id}')" class="flex-1 min-w-0 text-left touch-target">
            ${item.project_name ? `<span class="text-[10px] text-brand-muted dark:text-brand-muted block font-normal">📁 ${escapeHtml(item.project_name)}</span>` : ''}
            <span class="font-bold text-sm text-brand-ink dark:text-brand-ink break-words">${escapeHtml(item.file_name)}</span>
            <span class="block text-[11px] text-brand-muted dark:text-brand-muted mt-0.5">${dateFormatted} · ${durationFormatted}</span>
          </button>
          <button onclick="deleteTranscription('${item.id}')" class="touch-target p-2 text-red-500 dark:text-red-300 hover:bg-red-50 dark:hover:bg-red-950 rounded-lg shrink-0" title="Excluir arquivo" aria-label="Excluir ${escapeHtml(item.file_name)}">
            <i data-lucide="trash-2" class="w-4 h-4"></i>
          </button>
        </div>
        <div class="flex items-center justify-between gap-2 pl-8">
          ${modeBadge}
          ${statusBadge}
        </div>
      </div>`;
  }).join('');
}

// ---------------------------------------------------
// POLLING DE PROGRESSO EM TEMPO REAL
// ---------------------------------------------------

function startProgressPolling() {
  if (state.pollingInterval) return; // já está rodando
  state.pollingInterval = setInterval(async () => {
    if (state.activeJobIds.length === 0) {
      stopProgressPolling();
      return;
    }
    // Busca novamente a lista para ver o progresso atualizado
    await fetchTranscriptions();
  }, 3000); // a cada 3 segundos
}

function stopProgressPolling() {
  if (state.pollingInterval) {
    clearInterval(state.pollingInterval);
    state.pollingInterval = null;
  }
}

// Reprocessa so os blocos que falharam (ou o job inteiro, se falhou antes de fatiar)
async function retryTranscription(id) {
  try {
    const res = await fetch(`/api/transcriptions/${id}/retry`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${state.token}` }
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Falha ao reprocessar');
    await fetchTranscriptions(); // a lista ja mostra "Na Fila" e liga o polling
  } catch (e) {
    alert('Erro ao reprocessar: ' + e.message); // T-14 troca alert() por modal proprio
  }
}

// ---------------------------------------------------
// VISUALIZADOR DE TRANSCRIÇÃO DETALHADA
// ---------------------------------------------------

async function openTranscriptionDetail(id) {
  try {
    const res = await fetch(`/api/transcriptions/${id}`, {
      headers: { 'Authorization': `Bearer ${state.token}` }
    });
    const data = await res.json();
    state.activeTranscription = data;

    const filenameText = document.getElementById('detail-filename-text');
    if (filenameText) filenameText.innerText = data.file_name;

    const MODE_NAMES = { base: 'Base', pro: 'Pro', max: 'Max' };
    const MODE_DEFAULT_MODELS = { base: 'openai/whisper-1', pro: 'openai/whisper-large-v3-turbo', max: 'openai/whisper-large-v3' };
    const modeName = MODE_NAMES[data.mode] || 'Max';
    const modelUsed = state.systemSettings[`${data.mode}_model`] || MODE_DEFAULT_MODELS[data.mode] || 'openai/whisper-large-v3';
    const projectDisplay = data.project_name ? ` • Projeto: ${data.project_name}` : '';
    document.getElementById('detail-meta').innerText = `${new Date(data.created_at).toLocaleString('pt-BR')} • ${formatDuration(data.duration_seconds)} • Modo ${modeName} (${modelUsed})${projectDisplay}`;

    // Configurar áudio player
    const audioPlayer = document.getElementById('audio-player');
    if (audioPlayer) {
      audioPlayer.src = data.file_path || '';
    }

    // Atualizar seletor de projeto na barra lateral de detalhes
    const detailSelect = document.getElementById('detail-project-select');
    if (detailSelect) {
      detailSelect.value = data.project_id || "";
    }

    renderCurrentTranscript();
    showView('details');
  } catch (e) {
    alert('Erro ao carregar detalhes: ' + e.message);
  }
}

// Edição Inline do Título
function enableInlineTitleEdit() {
  if (!state.activeTranscription) return;
  const h2El = document.getElementById('detail-filename');
  const inputEl = document.getElementById('detail-filename-input');

  if (!inputEl) return;
  inputEl.value = state.activeTranscription.file_name;
  h2El.classList.add('hidden');
  inputEl.classList.remove('hidden');
  inputEl.focus();
  inputEl.select();
}

function handleTitleInputKeydown(e) {
  if (e.key === 'Enter') {
    saveInlineTitleEdit();
  } else if (e.key === 'Escape') {
    const h2El = document.getElementById('detail-filename');
    const inputEl = document.getElementById('detail-filename-input');
    if (inputEl && h2El) {
      inputEl.classList.add('hidden');
      h2El.classList.remove('hidden');
    }
  }
}

async function saveInlineTitleEdit() {
  if (!state.activeTranscription) return;
  const h2El = document.getElementById('detail-filename');
  const textEl = document.getElementById('detail-filename-text');
  const inputEl = document.getElementById('detail-filename-input');

  if (!inputEl || inputEl.classList.contains('hidden')) return;

  const newName = inputEl.value.trim();
  inputEl.classList.add('hidden');
  h2El.classList.remove('hidden');

  if (!newName || newName === state.activeTranscription.file_name) return;

  try {
    const res = await fetch(`/api/transcriptions/${state.activeTranscription.id}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${state.token}`
      },
      body: JSON.stringify({ file_name: newName })
    });

    if (res.ok) {
      state.activeTranscription.file_name = newName;
      if (textEl) textEl.innerText = newName;
      fetchTranscriptions();
    }
  } catch (e) {
    alert('Erro ao salvar novo nome: ' + e.message);
  }
}

const SPEAKER_PALETTES = [
  { bg: 'bg-blue-100 dark:bg-blue-950', text: 'text-blue-800 dark:text-blue-300', border: 'border-blue-200 dark:border-blue-800' },
  { bg: 'bg-purple-100 dark:bg-purple-950', text: 'text-purple-800 dark:text-purple-300', border: 'border-purple-200 dark:border-purple-800' },
  { bg: 'bg-emerald-100 dark:bg-emerald-950', text: 'text-emerald-800 dark:text-emerald-300', border: 'border-emerald-200 dark:border-emerald-800' },
  { bg: 'bg-amber-100 dark:bg-amber-950', text: 'text-amber-800 dark:text-amber-300', border: 'border-amber-200 dark:border-amber-800' },
  { bg: 'bg-rose-100 dark:bg-rose-950', text: 'text-rose-800 dark:text-rose-300', border: 'border-rose-200 dark:border-rose-800' },
  { bg: 'bg-cyan-100 dark:bg-cyan-950', text: 'text-cyan-800 dark:text-cyan-300', border: 'border-cyan-200 dark:border-cyan-800' },
  { bg: 'bg-indigo-100 dark:bg-indigo-950', text: 'text-indigo-800 dark:text-indigo-300', border: 'border-indigo-200 dark:border-indigo-800' }
];

function getSpeakerColor(speaker) {
  if (!speaker) return SPEAKER_PALETTES[0];
  let hash = 0;
  for (let i = 0; i < speaker.length; i++) {
    hash = speaker.charCodeAt(i) + ((hash << 5) - hash);
  }
  const index = Math.abs(hash) % SPEAKER_PALETTES.length;
  return SPEAKER_PALETTES[index];
}

function renderMarkdown(md) {
  if (!md) {
    return `
      <div class="text-center py-10 text-brand-muted dark:text-brand-muted">
        <i data-lucide="sparkles" class="w-8 h-8 mx-auto mb-2 opacity-50"></i>
        <p class="font-medium text-sm">Nenhum resumo por IA foi gerado para esta transcrição ainda.</p>
        <p class="text-xs mt-1">Use o painel lateral de IA para gerar um resumo executivo.</p>
      </div>
    `;
  }

  let html = escapeHtml(md);

  // Headers
  html = html.replace(/^### (.*$)/gim, '<h3 class="text-base font-bold text-brand-ink dark:text-brand-ink mt-4 mb-2">$1</h3>');
  html = html.replace(/^## (.*$)/gim, '<h2 class="text-lg font-extrabold text-brand-ink dark:text-brand-ink mt-5 mb-2 border-b pb-1">$1</h2>');
  html = html.replace(/^# (.*$)/gim, '<h1 class="text-xl font-extrabold text-brand-ink dark:text-brand-ink mt-6 mb-3 border-b pb-1">$1</h1>');

  // Blockquotes
  html = html.replace(/^&gt; (.*$)/gim, '<blockquote class="border-l-4 border-blue-500 pl-4 py-1.5 my-3 bg-blue-50/50 dark:bg-blue-950/50 text-brand-copy dark:text-brand-copy italic rounded-r-lg">$1</blockquote>');

  // Bold & Italic
  html = html.replace(/\*\*(.*?)\*\*/g, '<strong class="font-bold text-brand-ink dark:text-brand-ink">$1</strong>');
  html = html.replace(/\*(.*?)\*/g, '<em class="italic text-brand-ink dark:text-brand-ink">$1</em>');

  // Bullet Lists
  html = html.replace(/^\s*[\-\*]\s+(.*$)/gim, '<li class="ml-4 list-disc text-brand-ink dark:text-brand-ink my-0.5">$1</li>');

  // Checkbox lists
  html = html.replace(/<li class="ml-4 list-disc text-brand-ink dark:text-brand-ink my-0.5">\[ \] (.*?)<\/li>/g, '<li class="ml-4 list-none text-brand-ink dark:text-brand-ink my-1 flex items-center space-x-2"><input type="checkbox" disabled class="rounded border-brand-line dark:border-brand-line"> <span>$1</span></li>');
  html = html.replace(/<li class="ml-4 list-disc text-brand-ink dark:text-brand-ink my-0.5">\[x\] (.*?)<\/li>/g, '<li class="ml-4 list-none text-brand-ink dark:text-brand-ink my-1 flex items-center space-x-2"><input type="checkbox" checked disabled class="rounded border-brand-line dark:border-brand-line text-blue-600 dark:text-blue-300"> <span>$1</span></li>');

  // Wrap contiguous <li> in <ul>
  html = html.replace(/(<li.*?>.*?<\/li>\n?)+/g, '<ul class="my-3 space-y-1">$&</ul>');

  // Code blocks
  html = html.replace(/```([\s\S]*?)```/g, '<pre class="bg-slate-900 text-slate-100 p-4 rounded-xl text-xs overflow-x-auto my-3 font-mono"><code>$1</code></pre>');

  // Paragraphs
  const paragraphs = html.split(/\n{2,}/);
  html = paragraphs.map(p => {
    const trimmed = p.trim();
    if (!trimmed) return '';
    if (trimmed.startsWith('<h') || trimmed.startsWith('<ul') || trimmed.startsWith('<blockquote') || trimmed.startsWith('<pre') || trimmed.startsWith('<div')) {
      return trimmed;
    }
    return `<p class="mb-3 leading-relaxed text-brand-ink dark:text-brand-ink">${trimmed.replace(/\n/g, '<br>')}</p>`;
  }).join('');

  return html;
}

function buildReadingParagraphs(segments) {
  if (!segments || segments.length === 0) return [];
  const paragraphs = [];
  let currentGroup = [];

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (currentGroup.length === 0) {
      currentGroup.push(seg);
      continue;
    }

    const prevSeg = currentGroup[currentGroup.length - 1];
    const speakerChanged = seg.speaker !== prevSeg.speaker;
    const pauseExceeded = (seg.start_time - prevSeg.end_time) > 1.5;

    if (speakerChanged || pauseExceeded) {
      paragraphs.push(currentGroup);
      currentGroup = [seg];
    } else {
      currentGroup.push(seg);
    }
  }

  if (currentGroup.length > 0) {
    paragraphs.push(currentGroup);
  }

  return paragraphs;
}

function setReadingMode(mode) {
  if (!['transcript', 'reading', 'summary'].includes(mode)) return;
  if (state.readingMode === 'transcript' && state.activeTranscription) {
    const payload = collectTranscriptEdits();
    const current = state.activeTranscription;
    const changed = payload.segments ? payload.segments.some((s, i) => s.text !== current.segments[i].text) : payload.raw_text !== (current.raw_text || '');
    if (changed && !confirm('Ha edicoes nao salvas. Descartar e trocar o modo de leitura?')) return;
  }
  state.readingMode = mode;
  localStorage.setItem('transcreveai_reading_mode', mode);
  renderCurrentTranscript();
}

function setFontSize(size) {
  state.fontSize = size;
  localStorage.setItem('transcreveai_font_size', size);
  applyReadingPreferences();
}

function setColumnWidth(width) {
  state.columnWidth = width;
  localStorage.setItem('transcreveai_column_width', width);
  applyReadingPreferences();
}

function applyReadingPreferences() {
  const container = document.getElementById('transcript-content');
  if (!container) return;

  // Tamanho da Fonte
  container.classList.remove('text-xs', 'text-sm', 'text-base');
  if (state.fontSize === 'sm') container.classList.add('text-xs');
  else if (state.fontSize === 'lg') container.classList.add('text-base');
  else container.classList.add('text-sm');

  // Largura da Coluna
  container.classList.remove('max-w-xl', 'max-w-3xl', 'max-w-5xl');
  if (state.columnWidth === 'narrow') container.classList.add('max-w-xl');
  else if (state.columnWidth === 'wide') container.classList.add('max-w-5xl');
  else container.classList.add('max-w-3xl');

  // Destaque nos Botões do Modo de Leitura
  ['transcript', 'reading', 'summary'].forEach(m => {
    const btn = document.getElementById(`btn-mode-${m}`);
    if (btn) {
      if (state.readingMode === m) {
        btn.className = 'px-3 py-1.5 font-bold rounded-lg transition bg-brand-surface dark:bg-brand-surface text-blue-600 dark:text-blue-300 shadow-sm';
      } else {
        btn.className = 'px-3 py-1.5 font-bold rounded-lg transition text-brand-copy dark:text-brand-copy hover:text-brand-ink dark:hover:text-brand-ink';
      }
    }
  });

  // Destaque nos Botões de Fonte
  ['sm', 'md', 'lg'].forEach(s => {
    const btn = document.getElementById(`btn-font-${s}`);
    if (btn) {
      if (state.fontSize === s) {
        btn.className = 'px-2 py-0.5 font-bold rounded bg-brand-surface dark:bg-brand-surface text-blue-600 dark:text-blue-300 shadow-sm';
      } else {
        btn.className = 'px-2 py-0.5 font-bold rounded text-brand-copy dark:text-brand-copy hover:bg-brand-surface dark:hover:bg-brand-surface hover:shadow-sm';
      }
    }
  });

  // Destaque nos Botões de Coluna
  ['narrow', 'normal', 'wide'].forEach(w => {
    const btn = document.getElementById(`btn-col-${w}`);
    if (btn) {
      if (state.columnWidth === w) {
        btn.className = 'px-2 py-0.5 font-bold rounded bg-brand-surface dark:bg-brand-surface text-blue-600 dark:text-blue-300 shadow-sm';
      } else {
        btn.className = 'px-2 py-0.5 font-bold rounded text-brand-copy dark:text-brand-copy hover:bg-brand-surface dark:hover:bg-brand-surface hover:shadow-sm';
      }
    }
  });

  if (window.lucide) lucide.createIcons();
}

function renderCurrentTranscript() {
  const container = document.getElementById('transcript-content');
  if (!container || !state.activeTranscription) return;

  applyReadingPreferences();
  const saveButton = document.getElementById('save-transcript-button');
  if (saveButton) {
    saveButton.disabled = state.readingMode !== 'transcript';
    saveButton.classList.toggle('hidden', state.readingMode !== 'transcript');
  }

  const segments = state.activeTranscription.segments || [];

  // MODO RESUMO IA
  if (state.readingMode === 'summary') {
    container.contentEditable = "false";
    container.innerHTML = renderMarkdown(state.activeTranscription.ai_summary);
    if (window.lucide) lucide.createIcons();
    return;
  }

  // MODO LEITURA (Parágrafos Agrupados por Pausa/Falante)
  if (state.readingMode === 'reading') {
    container.contentEditable = "false";
    if (segments.length === 0) {
      container.innerHTML = `<p class="leading-relaxed text-brand-ink dark:text-brand-ink">${escapeHtml(state.activeTranscription.raw_text || '')}</p>`;
      return;
    }

    const paragraphs = buildReadingParagraphs(segments);
    container.innerHTML = paragraphs.map(group => {
      const firstSeg = group[0];
      const combinedText = group.map(s => s.text.trim()).join(' ');
      const color = getSpeakerColor(firstSeg.speaker);

      return `
        <div class="mb-6 p-4 rounded-xl bg-brand-canvas/80 dark:bg-brand-canvas/80 border border-brand-line/60 dark:border-brand-line/60 hover:border-brand-line dark:hover:border-brand-line transition">
          <div class="flex items-center space-x-2 mb-2">
            <button onclick="seekAudio(${firstSeg.start_time})" class="text-xs font-bold text-blue-600 dark:text-blue-300 hover:underline bg-blue-100/80 dark:bg-blue-950/80 hover:bg-blue-200 px-2 py-0.5 rounded-md transition shrink-0">
              [${formatSRTTimeShort(firstSeg.start_time)}]
            </button>
            ${firstSeg.speaker ? `
              <span class="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold ${color.bg} ${color.text} ${color.border} border">
                ${escapeHtml(firstSeg.speaker)}
              </span>
            ` : ''}
          </div>
          <p class="leading-relaxed text-brand-ink dark:text-brand-ink">${escapeHtml(combinedText)}</p>
        </div>
      `;
    }).join('');
    return;
  }

  // MODO TRANSCRIÇÃO (Padrão: Segmento por Segmento com edições habilitadas)
  container.contentEditable = "false";

  if (segments.length === 0) {
    container.innerHTML = `<p data-transcript-text contenteditable="plaintext-only" class="leading-relaxed text-brand-ink dark:text-brand-ink whitespace-pre-wrap">${escapeHtml(state.activeTranscription.raw_text || '')}</p>`;
    return;
  }

  container.innerHTML = segments.map(seg => {
    const color = getSpeakerColor(seg.speaker);
    return `
      <div class="mb-4 flex items-start space-x-3 group hover:bg-blue-50/50 dark:hover:bg-blue-950/50 p-2 rounded-xl transition">
        <button onclick="seekAudio(${seg.start_time})" class="text-xs font-bold text-blue-600 dark:text-blue-300 hover:underline bg-blue-100 dark:bg-blue-950 px-2 py-0.5 rounded shrink-0">
          [${formatSRTTimeShort(seg.start_time)}]
        </button>
        <div class="flex-1">
          ${seg.speaker ? `<span class="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold ${color.bg} ${color.text} ${color.border} border mb-1 block w-fit">${escapeHtml(seg.speaker)}</span>` : ''}
          <p data-segment-id="${escapeHtml(seg.id)}" contenteditable="plaintext-only" role="textbox" aria-label="Texto do segmento" class="text-brand-ink dark:text-brand-ink leading-relaxed whitespace-pre-wrap">${escapeHtml(seg.text)}</p>
        </div>
      </div>
    `;
  }).join('');
}

function copyTranscriptAsMarkdown() {
  if (!state.activeTranscription) return;
  const t = state.activeTranscription;
  const segments = t.segments || [];

  let md = `# ${t.file_name || 'Transcrição'}\n`;
  md += `**Data:** ${new Date(t.created_at).toLocaleString('pt-BR')} | **Duração:** ${Math.round(t.duration_seconds || 0)}s\n\n`;

  if (state.readingMode === 'summary' && t.ai_summary) {
    md += `## Resumo IA\n\n${t.ai_summary}\n`;
  } else if (segments.length > 0) {
    md += `## Transcrição\n\n`;
    md += segments.map(seg => {
      const timeTag = `[${formatSRTTimeShort(seg.start_time)}]`;
      const speakerTag = seg.speaker ? `**${seg.speaker}:** ` : '';
      return `${timeTag} ${speakerTag}${seg.text}`;
    }).join('\n\n');
  } else {
    md += `## Transcrição\n\n${t.raw_text || ''}\n`;
  }

  navigator.clipboard.writeText(md).then(() => {
    alert('Conteúdo copiado em formato Markdown com sucesso!');
  }).catch(err => {
    console.error('Erro ao copiar Markdown:', err);
  });
}

function seekAudio(seconds) {
  const audio = document.getElementById('audio-player');
  if (audio) {
    audio.currentTime = seconds;
    audio.play();
  }
}

function collectTranscriptEdits() {
  const container = document.getElementById('transcript-content');
  if (state.activeTranscription?.segments?.length) {
    return { segments: Array.from(container.querySelectorAll('[data-segment-id]')).map(el => ({ id: el.dataset.segmentId, text: el.innerText })) };
  }
  return { raw_text: container.querySelector('[data-transcript-text]')?.innerText || '' };
}

async function saveTranscriptChanges() {
  const current = state.activeTranscription;
  if (!current || state.readingMode !== 'transcript') return;
  const button = document.getElementById('save-transcript-button');
  if (button?.disabled) return;
  if (button) button.disabled = true;
  const payload = collectTranscriptEdits();
  try {
    const res = await fetch('/api/transcriptions/' + current.id, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + state.token },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Falha ao salvar (HTTP ' + res.status + ').');
    current.raw_text = data.raw_text ?? payload.raw_text;
    if (data.segments) current.segments = data.segments;
    alert('Transcricao salva com sucesso.');
  } catch (error) {
    alert('Erro ao salvar edicoes: ' + error.message);
  } finally {
    if (button) button.disabled = state.readingMode !== 'transcript';
  }
}

async function deleteTranscription(id) {
  if (!confirm('Tem certeza que deseja excluir esta transcrição?')) return;
  try {
    await fetch(`/api/transcriptions/${id}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${state.token}` }
    });
    fetchTranscriptions();
    if (state.activeTranscription && state.activeTranscription.id === id) {
      showView('dashboard');
    }
  } catch (e) {
    alert('Erro ao excluir: ' + e.message);
  }
}

// ---------------------------------------------------
// EXPORTAÇÃO DE ARQUIVOS
// ---------------------------------------------------
function exportCurrentFile(format) {
  if (!state.activeTranscription) return;
  const showTimestamps = document.getElementById('toggle-timestamps')?.checked ?? false;
  window.open(`/api/export/${state.activeTranscription.id}/${format}?timestamps=${showTimestamps}`, '_blank');
}

// ---------------------------------------------------
// MODAL DE TRANSCRIÇÃO & UPLOAD DE ARQUIVOS
// ---------------------------------------------------
function openTranscribeModal() {
  document.getElementById('transcribe-modal').classList.remove('hidden');
  selectMode(state.selectedMode);
}

function closeTranscribeModal() {
  document.getElementById('transcribe-modal').classList.add('hidden');
  state.selectedFiles = [];
  state.totalAudioSeconds = 0;
  const preview = document.getElementById('selected-files-preview');
  if (preview) preview.innerText = '';
  updatePriceAndPrecisionEstimate();

  // Reseta o painel de progresso e restaura o conteúdo original do modal
  const modalContent = document.getElementById('transcribe-modal-content');
  const progressPanel = document.getElementById('transcribe-progress-panel');
  if (modalContent) modalContent.classList.remove('hidden');
  if (progressPanel) progressPanel.classList.add('hidden');

  // Restaura o botão de transcrição
  const btn = document.getElementById('btn-submit-transcribe');
  if (btn) {
    btn.disabled = false;
    btn.innerText = 'TRANSCREVER';
    btn.onclick = submitTranscription;
  }

  // Limpa campo ai_focus
  const aiFocusInput = document.getElementById('ai-focus-input');
  if (aiFocusInput) aiFocusInput.value = '';
}

function selectMode(mode) {
  state.selectedMode = mode;

  if (mode === 'base') state.selectedModelId = 'openai/whisper-1';
  else if (mode === 'pro') state.selectedModelId = 'openai/whisper-large-v3-turbo';
  else if (mode === 'max') state.selectedModelId = 'openai/whisper-large-v3';

  const select = document.getElementById('openrouter-model-select');
  if (select) select.value = state.selectedModelId;

  ['base', 'pro', 'max'].forEach(m => {
    const el = document.getElementById(`mode-${m}`);
    if (el) {
      if (m === mode) {
        el.className = 'border-2 border-indigo-600 bg-indigo-50/95 dark:bg-indigo-950/95 p-3.5 rounded-2xl text-center cursor-pointer shadow-lg transform scale-[1.03] transition duration-200';
      } else {
        el.className = 'border-2 border-brand-line dark:border-brand-line bg-brand-canvas dark:bg-brand-canvas p-3.5 rounded-2xl text-center cursor-pointer hover:border-brand-line dark:hover:border-brand-line transition duration-200';
      }
    }
  });

  updatePriceAndPrecisionEstimate();
}

function handleFileSelect(e) {
  state.selectedFiles = Array.from(e.target.files);
  calculateSelectedFilesDuration();
}

async function submitTranscription() {
  if (state.selectedFiles.length === 0) {
    alert('Por favor, selecione ao menos um arquivo de áudio ou vídeo.');
    return;
  }

  const btn = document.getElementById('btn-submit-transcribe');
  btn.disabled = true;
  btn.innerText = 'ENVIANDO...';

  const select = document.getElementById('openrouter-model-select');
  const chosenModel = select ? select.value : state.selectedModelId;

  const formData = new FormData();
  state.selectedFiles.forEach(f => formData.append('files', f));
  formData.append('language', document.getElementById('transcribe-language').value);
  formData.append('mode', state.selectedMode);
  formData.append('model_id', chosenModel);

  const projectSelect = document.getElementById('transcribe-project-select');
  const chosenProjectId = projectSelect ? projectSelect.value : state.currentProjectId;
  if (chosenProjectId) formData.append('project_id', chosenProjectId);

  if (document.getElementById('diarization-check').checked) formData.append('speaker_diarization', 'true');

  // Campo opcional: Assunto para focar / instrução de busca
  const aiFocusInput = document.getElementById('ai-focus-input');
  const aiFocusVal = aiFocusInput ? aiFocusInput.value.trim() : '';
  if (aiFocusVal) formData.append('ai_focus', aiFocusVal);

  try {
    const res = await fetch('/api/transcribe', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${state.token}` },
      body: formData
    });
    const data = await res.json();

    if (data.success && data.data && data.data[0]) {
      const jobId = data.data[0].id;
      const fileName = data.data[0].file_name || state.selectedFiles[0].name;

      // Transiciona o modal para o painel de acompanhamento
      showTranscriptionProgressPanel(jobId, fileName);
      await fetchTranscriptions(); // Atualiza a tabela imediatamente
    } else {
      alert('Erro ao enviar para a fila: ' + (data.error || 'Desconhecido'));
      btn.disabled = false;
      btn.innerText = 'TRANSCREVER';
    }
  } catch (e) {
    alert('Erro ao enviar áudio: ' + e.message);
    btn.disabled = false;
    btn.innerText = 'TRANSCREVER';
  }
}

function isFinalStatus(status) {
  return status === 'completed' || status === 'completed_with_errors' || status === 'failed';
}

function formatEta(seconds) {
  if (seconds === null || seconds === undefined) return '';
  if (seconds < 60) return 'menos de 1 min restante';
  const m = Math.round(seconds / 60);
  return `~${m} min restante${m > 1 ? 's' : ''}`;
}

// Mensagem de etapa a partir do estado REAL do job (stage + blocos + ETA),
// nao de faixas de porcentagem adivinhadas.
function describeJobProgress(s) {
  switch (s.stage) {
    case 'preprocessing': return '🔍 Normalizando o áudio (16 kHz, volume)...';
    case 'splitting': return '✂️ Fatiando o áudio nos silêncios...';
    case 'transcribing': {
      const total = s.chunks_total || 0;
      const done = s.chunks_done || 0;
      const eta = formatEta(s.eta_seconds);
      if (total <= 1) return '🎙️ Transcrevendo...';
      return `🎙️ Bloco ${Math.min(done + 1, total)} de ${total}${eta ? ' · ' + eta : ''}`;
    }
    case 'assembling': return '🧩 Montando a transcrição...';
    case 'analyzing': return '🤖 Gerando resumo com foco no assunto...';
    default:
      return s.status === 'pending' ? '⏳ Na fila, aguardando o worker...' : 'Processando...';
  }
}

// Exibe o painel de progresso no modal após o upload ser aceito
function showTranscriptionProgressPanel(jobId, fileName) {
  const modalContent = document.getElementById('transcribe-modal-content');
  const progressPanel = document.getElementById('transcribe-progress-panel');
  const jobNameEl = document.getElementById('progress-job-name');
  const progressBar = document.getElementById('modal-progress-bar');
  const progressPct = document.getElementById('modal-progress-pct');
  const progressMsg = document.getElementById('modal-progress-msg');

  if (modalContent) modalContent.classList.add('hidden');
  if (progressPanel) progressPanel.classList.remove('hidden');
  if (jobNameEl) jobNameEl.innerText = fileName;

  const btnClose = document.getElementById('btn-submit-transcribe');
  if (btnClose) {
    btnClose.disabled = false;
    btnClose.innerText = 'ACOMPANHAR EM SEGUNDO PLANO';
    btnClose.onclick = () => closeTranscribeModal();
  }

  // Polling do progresso do job específico
  const pollJob = setInterval(async () => {
    try {
      const res = await fetch(`/api/transcriptions/${jobId}/status`, {
        headers: { 'Authorization': `Bearer ${state.token}` }
      });
      const statusData = await res.json();

      if (!statusData.success) {
        clearInterval(pollJob);
        return;
      }

      const pct = statusData.progress || 0;
      if (progressBar) progressBar.style.width = `${pct}%`;
      if (progressPct) progressPct.innerText = `${pct}%`;
      if (progressMsg) progressMsg.innerText = describeJobProgress(statusData);

      if (isFinalStatus(statusData.status)) {
        clearInterval(pollJob);
        await fetchTranscriptions();

        if (statusData.status === 'completed' || statusData.status === 'completed_with_errors') {
          if (progressMsg) {
            progressMsg.innerText = statusData.status === 'completed'
              ? '✅ Transcrição concluída! Clique em fechar para ver o resultado.'
              : `⚠️ Concluída com falhas: ${statusData.error_message || ''}. Você pode reprocessar só os blocos que falharam na lista.`;
          }
          if (btnClose) {
            btnClose.innerText = 'VER TRANSCRIÇÃO';
            btnClose.onclick = () => {
              closeTranscribeModal();
              openTranscriptionDetail(jobId);
            };
          }
        } else {
          if (progressMsg) progressMsg.innerText = `❌ Falha no processamento: ${statusData.error_message || 'erro desconhecido'}`;
        }
      }
    } catch (e) {
      console.warn('Erro no polling do progresso:', e);
    }
  }, 2000);
}

// ---------------------------------------------------
// GRAVADOR DE VOZ DO NAVEGADOR (MICROPHONE RECORDING)
// ---------------------------------------------------
function openRecordModal() {
  document.getElementById('record-modal').classList.remove('hidden');
}

function closeRecordModal() {
  stopRecording();
  document.getElementById('record-modal').classList.add('hidden');
  state.recordedBlob = null;
}

async function startRecording() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    state.mediaRecorder = new MediaRecorder(stream);
    state.audioChunks = [];

    state.mediaRecorder.ondataavailable = (event) => {
      if (event.data.size > 0) {
        state.audioChunks.push(event.data);
      }
    };

    state.mediaRecorder.onstop = () => {
      state.recordedBlob = new Blob(state.audioChunks, { type: 'audio/ogg; codecs=opus' });
      document.getElementById('btn-submit-recorded').classList.remove('hidden');
      const audioUrl = URL.createObjectURL(state.recordedBlob);
      const preview = document.getElementById('recorded-audio-preview');
      if (preview) {
        preview.src = audioUrl;
        preview.classList.remove('hidden');
      }
    };

    state.mediaRecorder.start();
    state.recordingSeconds = 0;
    document.getElementById('btn-start-record').classList.add('hidden');
    document.getElementById('btn-stop-record').classList.remove('hidden');
    document.getElementById('recording-status-text').innerText = 'Gravando áudio... (Fale no microfone)';

    state.recordingInterval = setInterval(() => {
      state.recordingSeconds++;
      document.getElementById('recording-timer').innerText = formatSRTTimeShort(state.recordingSeconds);
    }, 1000);
  } catch (err) {
    alert('Erro ao acessar microfone: ' + err.message);
  }
}

function stopRecording() {
  if (state.mediaRecorder && state.mediaRecorder.state !== 'inactive') {
    state.mediaRecorder.stop();
    state.mediaRecorder.stream.getTracks().forEach(track => track.stop());
  }
  if (state.recordingInterval) {
    clearInterval(state.recordingInterval);
  }
  document.getElementById('btn-start-record').classList.remove('hidden');
  document.getElementById('btn-stop-record').classList.add('hidden');
  document.getElementById('recording-status-text').innerText = 'Gravação concluída. Ouça ou envie para transcrição.';
}

async function submitRecordedAudio() {
  if (!state.recordedBlob) return;

  const btn = document.getElementById('btn-submit-recorded');
  btn.disabled = true;
  btn.innerText = 'TRANSCREVENDO GRAVAÇÃO...';

  const file = new File([state.recordedBlob], `gravacao-${Date.now()}.ogg`, { type: 'audio/ogg' });
  const formData = new FormData();
  formData.append('files', file);
  formData.append('language', 'pt');
  formData.append('mode', state.selectedMode);
  formData.append('model_id', state.selectedModelId);

  const projectSelect = document.getElementById('record-project-select');
  const chosenProjectId = projectSelect ? projectSelect.value : state.currentProjectId;
  if (chosenProjectId) formData.append('project_id', chosenProjectId);

  try {
    const res = await fetch('/api/transcribe', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${state.token}` },
      body: formData
    });
    const data = await res.json();
    if (data.success && data.data && data.data[0]) {
      closeRecordModal();
      await fetchTranscriptions();
      openTranscriptionDetail(data.data[0].id);
    }
  } catch (e) {
    alert('Erro ao transcrever gravação: ' + e.message);
  } finally {
    btn.disabled = false;
    btn.innerText = 'ENVIAR PARA TRANSCRIÇÃO';
  }
}

// ---------------------------------------------------
// MODAIS INFORMATIVOS & AUTENTICAÇÃO
// ---------------------------------------------------
function openPlansModal() {
  document.getElementById('plans-modal').classList.remove('hidden');
}

function closePlansModal() {
  document.getElementById('plans-modal').classList.add('hidden');
}

function openFaqsModal() {
  document.getElementById('faqs-modal').classList.remove('hidden');
}

function closeFaqsModal() {
  document.getElementById('faqs-modal').classList.add('hidden');
}

function openBlogModal() {
  document.getElementById('blog-modal').classList.remove('hidden');
}

function closeBlogModal() {
  document.getElementById('blog-modal').classList.add('hidden');
}

function openLoginModal() {
  document.getElementById('login-modal').classList.remove('hidden');
}

function closeLoginModal() {
  document.getElementById('login-modal').classList.add('hidden');
}

async function handleLoginSubmit(e) {
  e.preventDefault();
  const email = document.getElementById('login-email').value;
  const password = document.getElementById('login-password').value;

  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    });
    const data = await res.json();
    if (res.ok && data.token) {
      localStorage.setItem('turboscribe_token', data.token);
      state.token = data.token;
      state.currentUser = data.user;
      closeLoginModal();
      checkAuthUser();
      fetchTranscriptions();
      alert(`Autenticado com sucesso como: ${data.user.name} (${data.user.role})`);
    } else {
      alert('Erro no login: ' + (data.error || 'Credenciais inválidas'));
    }
  } catch (err) {
    alert('Erro no servidor de autenticação: ' + err.message);
  }
}

// ---------------------------------------------------
// CHATGPT & TRADUÇÃO VIA OPENROUTER
// ---------------------------------------------------
function openAIChatDrawer() {
  document.getElementById('ai-chat-drawer').classList.remove('hidden');
}

function closeAIChatDrawer() {
  document.getElementById('ai-chat-drawer').classList.add('hidden');
}

async function sendAIChatPrompt(e) {
  e.preventDefault();
  const input = document.getElementById('chat-input');
  const prompt = input.value.trim();
  if (!prompt || !state.activeTranscription) return;

  const messagesDiv = document.getElementById('chat-messages');
  messagesDiv.innerHTML += `
    <div class="bg-blue-600 text-white p-3 rounded-xl ml-6 shadow-sm">
      <p class="font-bold">Você:</p>
      <p class="mt-1">${escapeHtml(prompt)}</p>
    </div>
  `;
  input.value = '';
  messagesDiv.scrollTop = messagesDiv.scrollHeight;

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${state.token}`
      },
      body: JSON.stringify({
        transcript_text: state.activeTranscription.raw_text,
        prompt: prompt
      })
    });
    const data = await res.json();

    messagesDiv.innerHTML += `
      <div class="bg-brand-surface dark:bg-brand-surface p-3 rounded-xl border border-brand-line dark:border-brand-line shadow-sm mr-6">
        <p class="font-bold text-emerald-700 dark:text-emerald-300">ChatGPT:</p>
        <div class="text-brand-ink dark:text-brand-ink mt-1 leading-relaxed">${escapeHtml(data.answer)}</div>
      </div>
    `;
    messagesDiv.scrollTop = messagesDiv.scrollHeight;
  } catch (err) {
    alert('Erro no ChatGPT: ' + err.message);
  }
}

async function openTranslateModal() {
  const targetLang = prompt('Traduzir esta transcrição para qual idioma? (ex: English, Español, Français, Deutsch)', 'English');
  if (!targetLang || !state.activeTranscription) return;

  try {
    const res = await fetch('/api/translate', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${state.token}`
      },
      body: JSON.stringify({
        transcript_text: state.activeTranscription.raw_text,
        target_language: targetLang
      })
    });
    const data = await res.json();
    alert(`Tradução para ${targetLang}:\n\n` + data.translatedText);
  } catch (e) {
    alert('Erro ao traduzir: ' + e.message);
  }
}

// ---------------------------------------------------
// PAINEL DE ADMINISTRAÇÃO SAAS (ADMIN DASHBOARD)
// ---------------------------------------------------

function switchAdminTab(tabName) {
  ['metrics', 'users', 'apikeys', 'settings', 'logs'].forEach(t => {
    const tabContent = document.getElementById(`admin-tab-${t}`);
    const tabBtn = document.getElementById(`tab-btn-${t}`);
    if (tabContent && tabBtn) {
      if (t === tabName) {
        tabContent.classList.remove('hidden');
        tabBtn.className = 'px-4 py-2.5 text-xs font-bold text-blue-600 dark:text-blue-300 border-b-2 border-blue-600 transition';
      } else {
        tabContent.classList.add('hidden');
        tabBtn.className = 'px-4 py-2.5 text-xs font-bold text-brand-muted dark:text-brand-muted hover:text-brand-ink dark:hover:text-brand-ink transition';
      }
    }
  });

  if (tabName === 'users') loadAdminUsers();
  else if (tabName === 'apikeys') loadAdminApiKeys();
  else if (tabName === 'settings') loadAdminSettingsForm();
  else if (tabName === 'logs') loadAdminLogs();
  else if (tabName === 'metrics') loadAdminMetrics();
}

async function loadAdminMetrics() {
  try {
    const res = await fetch('/api/admin/metrics', {
      headers: { 'Authorization': `Bearer ${state.token}` }
    });
    const data = await res.json();
    document.getElementById('metric-users').innerText = data.users_total;
    document.getElementById('metric-hours').innerText = data.hours_transcribed + 'h';
    document.getElementById('metric-storage').innerText = data.storage_used_mb + ' MB';
    document.getElementById('metric-apikeys').innerText = data.active_api_keys;
  } catch (e) {
    console.error('Erro ao carregar métricas:', e);
  }
}

async function loadAdminUsers() {
  try {
    const res = await fetch('/api/admin/users', {
      headers: { 'Authorization': `Bearer ${state.token}` }
    });
    const users = await res.json();
    const tbody = document.getElementById('admin-users-tbody');
    tbody.innerHTML = users.map(u => `
      <tr class="hover:bg-brand-canvas dark:hover:bg-brand-canvas">
        <td class="p-4 font-bold text-brand-ink dark:text-brand-ink">${escapeHtml(u.name)}</td>
        <td class="p-4 text-brand-copy dark:text-brand-copy">${escapeHtml(u.email)}</td>
        <td class="p-4"><span class="px-2 py-0.5 text-[10px] font-bold rounded ${u.role === 'admin' ? 'bg-purple-100 dark:bg-purple-950 text-purple-800 dark:text-purple-300' : 'bg-brand-raised dark:bg-brand-raised text-brand-copy dark:text-brand-copy'}">${u.role}</span></td>
        <td class="p-4 text-brand-copy dark:text-brand-copy font-semibold">${u.daily_limit} transcrições</td>
        <td class="p-4"><span class="px-2 py-0.5 text-[10px] font-bold rounded ${u.status === 'active' ? 'bg-emerald-100 dark:bg-emerald-950 text-emerald-800 dark:text-emerald-300' : 'bg-red-100 dark:bg-red-950 text-red-800 dark:text-red-300'}">${u.status}</span></td>
        <td class="p-4 text-right">
          <button onclick="toggleUserStatus('${u.id}', '${u.status === 'active' ? 'suspended' : 'active'}')" class="text-blue-600 dark:text-blue-300 hover:underline font-semibold text-xs">
            ${u.status === 'active' ? 'Suspender' : 'Ativar'}
          </button>
        </td>
      </tr>
    `).join('');
  } catch (e) {
    console.error('Erro ao carregar usuários:', e);
  }
}

async function toggleUserStatus(userId, newStatus) {
  try {
    await fetch(`/api/admin/users/${userId}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${state.token}`
      },
      body: JSON.stringify({ status: newStatus })
    });
    loadAdminUsers();
  } catch (e) {
    alert('Erro ao atualizar usuário: ' + e.message);
  }
}

async function openCreateUserModal() {
  const name = prompt('Nome do novo usuário:');
  if (!name) return;
  const email = prompt('E-mail do novo usuário:');
  if (!email) return;
  const password = prompt('Senha inicial:');
  if (!password) return;
  const role = confirm('Este usuário será Administrador?') ? 'admin' : 'user';

  try {
    await fetch('/api/admin/users', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${state.token}`
      },
      body: JSON.stringify({ name, email, password, role, daily_limit: role === 'admin' ? 99999 : 3 })
    });
    loadAdminUsers();
  } catch (e) {
    alert('Erro ao criar usuário: ' + e.message);
  }
}

async function loadAdminApiKeys() {
  try {
    const res = await fetch('/api/admin/apikeys', {
      headers: { 'Authorization': `Bearer ${state.token}` }
    });
    const keys = await res.json();
    const tbody = document.getElementById('admin-keys-tbody');
    tbody.innerHTML = keys.map(k => `
      <tr class="hover:bg-brand-canvas dark:hover:bg-brand-canvas">
        <td class="p-4 font-bold text-purple-700 dark:text-purple-300 uppercase text-[11px]">${k.provider}</td>
        <td class="p-4 text-brand-ink dark:text-brand-ink font-semibold">${escapeHtml(k.name || 'Sem nome')}</td>
        <td class="p-4 font-mono text-brand-copy dark:text-brand-copy">${k.masked_key}</td>
        <td class="p-4"><span class="px-2 py-0.5 text-[10px] font-bold rounded ${k.is_active ? 'bg-emerald-100 dark:bg-emerald-950 text-emerald-800 dark:text-emerald-300' : 'bg-brand-raised dark:bg-brand-raised text-brand-copy dark:text-brand-copy'}">${k.is_active ? 'Ativa' : 'Inativa'}</span></td>
        <td class="p-4 text-right">
          ${!k.is_active ? `<button onclick="activateApiKey('${k.id}')" class="text-blue-600 dark:text-blue-300 hover:underline font-semibold text-xs mr-3">Tornar Ativa</button>` : ''}
          <button onclick="deleteApiKey('${k.id}')" class="text-red-600 dark:text-red-300 hover:underline font-semibold text-xs">Excluir</button>
        </td>
      </tr>
    `).join('');
  } catch (e) {
    console.error('Erro ao carregar chaves:', e);
  }
}

function openAddKeyModal() {
  openApiKeyModal();
}

// ---------------------------------------------------
// CHAVE OPENROUTER — indicador na sidebar + modal
// ---------------------------------------------------
const apiKeyUi = { testedValue: null, testedOk: false };

function describeKeyInfo(info) {
  if (!info) return '';
  if (info.error) return info.error;
  const parts = [];
  if (info.label) parts.push(info.label);
  if (info.limit_remaining !== null && info.limit_remaining !== undefined) parts.push(`restante US$ ${Number(info.limit_remaining).toFixed(2)}`);
  else if (info.limit === null) parts.push('sem limite de crédito');
  if (info.usage !== null && info.usage !== undefined) parts.push(`usado US$ ${Number(info.usage).toFixed(2)}`);
  return parts.join(' · ');
}

function renderApiKeyManagedByAdmin() {
  const dot = document.getElementById('apikey-dot');
  const text = document.getElementById('apikey-state-text');
  const masked = document.getElementById('apikey-masked');
  if (!dot || !text || !masked) return;
  dot.className = 'w-2 h-2 rounded-full bg-slate-400';
  text.textContent = 'gerenciada pelo admin';
  masked.textContent = 'Chave do sistema em uso — fale com o administrador para trocar';
  const btn = document.getElementById('apikey-config-btn');
  if (btn) btn.classList.add('hidden');
}

function renderApiKeyState(status) {
  const dot = document.getElementById('apikey-dot');
  const text = document.getElementById('apikey-state-text');
  const masked = document.getElementById('apikey-masked');
  if (!dot || !text || !masked) return;
  if (!status || !status.configured) {
    dot.className = 'w-2 h-2 rounded-full bg-amber-400';
    text.textContent = 'não configurada';
    masked.textContent = 'Cadastre sua chave para transcrever';
    return;
  }
  masked.textContent = status.masked_key || '—';
  if (status.last_check_ok === true) {
    dot.className = 'w-2 h-2 rounded-full bg-emerald-400';
    text.textContent = 'válida';
  } else if (status.last_check_ok === false) {
    dot.className = 'w-2 h-2 rounded-full bg-red-500';
    text.textContent = 'inválida';
  } else {
    dot.className = 'w-2 h-2 rounded-full bg-slate-400';
    text.textContent = 'não testada';
  }
}

async function loadApiKeyStatus() {
  // Endpoint admin-only: usuario comum ve estado neutro, sem chamada de API
  // (evita o 403 vazar como "não configurada" e o botão de config fica oculto).
  if (!state.currentUser || state.currentUser.role !== 'admin') {
    renderApiKeyManagedByAdmin();
    return null;
  }
  const btn = document.getElementById('apikey-config-btn');
  if (btn) btn.classList.remove('hidden');
  try {
    const res = await fetch('/api/admin/apikeys/status', { headers: { 'Authorization': `Bearer ${state.token}` } });
    const status = await res.json();
    renderApiKeyState(status);
    const cur = document.getElementById('apikey-current-masked');
    const info = document.getElementById('apikey-current-info');
    if (cur) cur.textContent = status.configured ? status.masked_key : 'nenhuma';
    if (info) info.textContent = status.configured ? describeKeyInfo(status.last_check_info) : 'Nenhuma chave cadastrada ainda.';
    return status;
  } catch (e) {
    renderApiKeyState(null);
    return null;
  }
}

function openApiKeyModal() {
  if (!state.currentUser || state.currentUser.role !== 'admin') return; // trava defensiva: rota e acao sao admin-only
  const modal = document.getElementById('apikey-modal');
  if (!modal) return;
  ['apikey-input', 'apikey-name', 'apikey-admin-password'].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
  document.getElementById('apikey-test-result').textContent = '';
  document.getElementById('apikey-save-error').classList.add('hidden');
  apiKeyUi.testedValue = null;
  apiKeyUi.testedOk = false;
  onApiKeyInput();
  modal.classList.remove('hidden');
  loadApiKeyStatus();
  if (window.lucide) lucide.createIcons();
  setTimeout(() => document.getElementById('apikey-input').focus(), 50);
}

function closeApiKeyModal() {
  document.getElementById('apikey-modal').classList.add('hidden');
  document.getElementById('apikey-input').value = '';
  document.getElementById('apikey-input').type = 'password';
  document.getElementById('apikey-admin-password').value = '';
  apiKeyUi.testedValue = null;
  apiKeyUi.testedOk = false;
}

function toggleApiKeyVisibility() {
  const input = document.getElementById('apikey-input');
  const eye = document.getElementById('apikey-eye');
  const show = input.type === 'password';
  input.type = show ? 'text' : 'password';
  if (eye) { eye.setAttribute('data-lucide', show ? 'eye-off' : 'eye'); if (window.lucide) lucide.createIcons(); }
}

function onApiKeyInput() {
  const value = document.getElementById('apikey-input').value.trim();
  const password = document.getElementById('apikey-admin-password').value;
  const looksValid = /^sk-or-v1-/.test(value);
  document.getElementById('apikey-test-btn').disabled = !looksValid;
  if (value !== apiKeyUi.testedValue) {
    apiKeyUi.testedOk = false;
    if (apiKeyUi.testedValue !== null) document.getElementById('apikey-test-result').textContent = 'Chave alterada — teste de novo.';
  }
  document.getElementById('apikey-save-btn').disabled = !(apiKeyUi.testedOk && password.length > 0);
}

async function testNewApiKey() {
  const value = document.getElementById('apikey-input').value.trim();
  const out = document.getElementById('apikey-test-result');
  out.className = 'text-xs text-brand-muted dark:text-brand-muted';
  out.textContent = 'Testando…';
  try {
    const res = await fetch('/api/admin/apikeys/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${state.token}` },
      body: JSON.stringify({ key_value: value })
    });
    const data = await res.json();
    apiKeyUi.testedValue = value;
    apiKeyUi.testedOk = Boolean(data.valid);
    out.className = `text-xs font-semibold ${data.valid ? 'text-emerald-600 dark:text-emerald-300' : 'text-red-600 dark:text-red-300'}`;
    out.textContent = data.valid ? `✓ Válida · ${describeKeyInfo(data.info) || 'ok'}` : `✗ ${data.error || 'inválida'}`;
  } catch (e) {
    apiKeyUi.testedOk = false;
    out.className = 'text-xs font-semibold text-red-600 dark:text-red-300';
    out.textContent = '✗ Falha ao testar: ' + e.message;
  }
  onApiKeyInput();
}

async function testCurrentApiKey() {
  const info = document.getElementById('apikey-current-info');
  info.textContent = 'Testando…';
  try {
    const res = await fetch('/api/admin/apikeys/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${state.token}` },
      body: JSON.stringify({})
    });
    const data = await res.json();
    info.textContent = data.valid ? `✓ Válida · ${describeKeyInfo(data.info) || 'ok'}` : `✗ ${data.error || 'inválida'}`;
  } catch (e) {
    info.textContent = '✗ Falha ao testar: ' + e.message;
  }
  loadApiKeyStatus();
}

async function saveApiKey() {
  const err = document.getElementById('apikey-save-error');
  err.classList.add('hidden');
  const btn = document.getElementById('apikey-save-btn');
  btn.disabled = true;
  try {
    const res = await fetch('/api/admin/apikeys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${state.token}` },
      body: JSON.stringify({
        name: document.getElementById('apikey-name').value.trim() || undefined,
        key_value: document.getElementById('apikey-input').value.trim(),
        admin_password: document.getElementById('apikey-admin-password').value
      })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    closeApiKeyModal();
    loadApiKeyStatus();
    if (document.getElementById('admin-keys-tbody')) loadAdminApiKeys();
  } catch (e) {
    err.textContent = e.message;
    err.classList.remove('hidden');
    document.getElementById('apikey-admin-password').value = '';
    onApiKeyInput();
  }
}

async function activateApiKey(id) {
  try {
    await fetch(`/api/admin/apikeys/${id}/activate`, {
      method: 'PUT',
      headers: { 'Authorization': `Bearer ${state.token}` }
    });
    loadAdminApiKeys();
  } catch (e) {
    alert('Erro ao ativar chave: ' + e.message);
  }
}

async function deleteApiKey(id) {
  if (!confirm('Excluir esta chave de API?')) return;
  try {
    await fetch(`/api/admin/apikeys/${id}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${state.token}` }
    });
    loadAdminApiKeys();
  } catch (e) {
    alert('Erro ao excluir chave: ' + e.message);
  }
}

// Configurações e Mapeamento de Modelos IA no Admin
async function loadAdminSettingsForm() {
  try {
    const res = await fetch('/api/admin/settings', {
      headers: { 'Authorization': `Bearer ${state.token}` }
    });
    const s = await res.json();
    document.getElementById('admin-setting-base-model').value = s.base_model || 'openai/whisper-1';
    document.getElementById('admin-setting-pro-model').value = s.pro_model || 'openai/whisper-large-v3-turbo';
    document.getElementById('admin-setting-max-model').value = s.max_model || 'openai/whisper-large-v3';

    document.getElementById('admin-setting-base-enabled').checked = s.base_enabled !== 'false';
    document.getElementById('admin-setting-pro-enabled').checked = s.pro_enabled !== 'false';
    document.getElementById('admin-setting-max-enabled').checked = s.max_enabled !== 'false';
  } catch (e) {
    console.error('Erro ao carregar configurações admin:', e);
  }
}

async function saveAdminSettings(e) {
  e.preventDefault();
  const settings = {
    base_model: document.getElementById('admin-setting-base-model').value,
    pro_model: document.getElementById('admin-setting-pro-model').value,
    max_model: document.getElementById('admin-setting-max-model').value,
    base_enabled: document.getElementById('admin-setting-base-enabled').checked ? 'true' : 'false',
    pro_enabled: document.getElementById('admin-setting-pro-enabled').checked ? 'true' : 'false',
    max_enabled: document.getElementById('admin-setting-max-enabled').checked ? 'true' : 'false'
  };

  try {
    const res = await fetch('/api/admin/settings', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${state.token}`
      },
      body: JSON.stringify({ settings })
    });
    if (res.ok) {
      alert('Configurações de modelos e modos salvas com sucesso!');
      fetchSystemSettings();
    }
  } catch (e) {
    alert('Erro ao salvar configurações: ' + e.message);
  }
}

async function loadAdminLogs() {
  try {
    const res = await fetch('/api/admin/logs', {
      headers: { 'Authorization': `Bearer ${state.token}` }
    });
    const logs = await res.json();
    const tbody = document.getElementById('admin-logs-tbody');
    tbody.innerHTML = logs.map(l => `
      <tr class="hover:bg-brand-canvas dark:hover:bg-brand-canvas">
        <td class="p-4 text-brand-muted dark:text-brand-muted font-mono text-[11px]">${new Date(l.timestamp).toLocaleString('pt-BR')}</td>
        <td class="p-4 font-semibold text-brand-copy dark:text-brand-copy">${escapeHtml(l.user_email || 'Sistema')}</td>
        <td class="p-4"><span class="px-2 py-0.5 text-[10px] font-bold rounded bg-blue-50 dark:bg-blue-950 text-blue-700 dark:text-blue-300 border border-blue-200 dark:border-blue-800">${l.action}</span></td>
        <td class="p-4 text-brand-copy dark:text-brand-copy font-mono text-[11px] truncate max-w-xs">${escapeHtml(l.details || '')}</td>
        <td class="p-4 text-brand-muted dark:text-brand-muted font-mono text-[11px]">${l.ip_address}</td>
      </tr>
    `).join('');
  } catch (e) {
    console.error('Erro ao carregar logs:', e);
  }
}
// ---------------------------------------------------
// AÇÕES EM MASSA (BULK ACTIONS)
// ---------------------------------------------------
function toggleSelectAll(masterCheckbox) {
  const checkboxes = document.querySelectorAll('.row-checkbox');
  checkboxes.forEach(cb => {
    cb.checked = masterCheckbox.checked;
  });
  updateBulkActionsBar();
}

function handleRowCheckboxChange() {
  const masterCheckbox = document.getElementById('select-all-checkbox');
  const checkboxes = document.querySelectorAll('.row-checkbox');
  const allChecked = Array.from(checkboxes).every(cb => cb.checked);
  if (masterCheckbox) {
    masterCheckbox.checked = allChecked;
  }
  updateBulkActionsBar();
}

function updateBulkActionsBar() {
  const checkboxes = document.querySelectorAll('.row-checkbox:checked');
  const bar = document.getElementById('bulk-actions-bar');
  const countEl = document.getElementById('selected-count');
  
  if (checkboxes.length > 0) {
    if (countEl) countEl.innerText = checkboxes.length;
    if (bar) bar.classList.remove('hidden');
  } else {
    if (bar) bar.classList.add('hidden');
    const masterCheckbox = document.getElementById('select-all-checkbox');
    if (masterCheckbox) masterCheckbox.checked = false;
  }
}

async function deleteSelectedTranscriptions() {
  const checkedBoxes = document.querySelectorAll('.row-checkbox:checked');
  const ids = Array.from(checkedBoxes).map(cb => cb.value);
  if (ids.length === 0) return;

  if (!confirm(`Tem certeza que deseja excluir as ${ids.length} gravações selecionadas?`)) return;

  const btn = document.querySelector('#bulk-actions-bar button[onclick="deleteSelectedTranscriptions()"]');
  const oldText = btn.innerHTML;
  btn.disabled = true;
  btn.innerText = 'Excluindo...';

  try {
    const promises = ids.map(id => 
      fetch(`/api/transcriptions/${id}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${state.token}` }
      })
    );
    await Promise.all(promises);
    
    await fetchProjects();
    await fetchTranscriptions();
    alert('Gravações excluídas com sucesso!');
  } catch (e) {
    alert('Erro ao excluir gravações selecionadas: ' + e.message);
  } finally {
    btn.disabled = false;
    btn.innerHTML = oldText;
  }
}

function openBulkMoveModal() {
  const select = document.getElementById('bulk-move-project-select');
  if (select) {
    select.innerHTML = `
      <option value="">(Sem projeto)</option>
      ${state.projects.map(p => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join('')}
    `;
  }
  document.getElementById('bulk-move-modal').classList.remove('hidden');
}

function closeBulkMoveModal() {
  document.getElementById('bulk-move-modal').classList.add('hidden');
}

async function submitBulkMove() {
  const checkedBoxes = document.querySelectorAll('.row-checkbox:checked');
  const ids = Array.from(checkedBoxes).map(cb => cb.value);
  if (ids.length === 0) return;

  const select = document.getElementById('bulk-move-project-select');
  const projectId = select ? select.value : null;

  try {
    const promises = ids.map(id =>
      fetch(`/api/transcriptions/${id}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${state.token}`
        },
        body: JSON.stringify({ project_id: projectId || null })
      })
    );
    await Promise.all(promises);

    closeBulkMoveModal();
    await fetchProjects();
    await fetchTranscriptions();
    alert('Gravações movidas com sucesso!');
  } catch (e) {
    alert('Erro ao mover gravações selecionadas: ' + e.message);
  }
}

// ---------------------------------------------------
// HELPERS
// ---------------------------------------------------
function formatDuration(sec) {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  if (m > 60) {
    const h = Math.floor(m / 60);
    const remM = m % 60;
    return `${h}h ${remM}m`;
  }
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

function formatSRTTimeShort(sec) {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return `${mm}:${ss}`;
}

function escapeHtml(str) {
  return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// T-05: preferencia explicita ou acompanhamento do sistema.
const systemTheme = window.matchMedia('(prefers-color-scheme: dark)');
let currentTheme = 'system';
try { currentTheme = localStorage.getItem('transcreveai_theme') || 'system'; } catch (_) {}
if (!['light', 'dark', 'system'].includes(currentTheme)) currentTheme = 'system';
function applyTheme() {
  document.documentElement.classList.toggle('dark', currentTheme === 'dark' || (currentTheme === 'system' && systemTheme.matches));
  ['light', 'dark', 'system'].forEach(theme => document.getElementById('theme-btn-' + theme)?.setAttribute('aria-pressed', String(currentTheme === theme)));
}
function setTheme(theme) {
  if (!['light', 'dark', 'system'].includes(theme)) return;
  currentTheme = theme;
  try { localStorage.setItem('transcreveai_theme', theme); } catch (_) {}
  applyTheme();
}
systemTheme.addEventListener('change', () => { if (currentTheme === 'system') applyTheme(); });
document.addEventListener('DOMContentLoaded', applyTheme);
