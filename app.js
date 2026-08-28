// Estado Global da Aplicação Frontend
const state = {
  currentUser: { id: 'admin-local', name: 'Pedro León', email: 'pedro.leon23@gmail.com', role: 'admin' },
  token: localStorage.getItem('turboscribe_token') || '',
  currentView: 'dashboard',
  projects: [],
  transcriptions: [],
  currentProjectId: null,
  activeTranscription: null,
  selectedFiles: [],
  selectedMode: 'baleia', // SELEÇÃO PADRÃO SISTEMA = BALEIA (SOLICITAÇÃO CEO)
  selectedModelId: 'openai/whisper-large-v3',
  openRouterModels: [],
  totalAudioSeconds: 0,
  systemSettings: {},
  // Gravador de Voz
  mediaRecorder: null,
  audioChunks: [],
  recordingInterval: null,
  recordingSeconds: 0,
  recordedBlob: null
};

// Inicialização
document.addEventListener('DOMContentLoaded', () => {
  if (window.lucide) lucide.createIcons();
  fetchSystemSettings();
  fetchOpenRouterModels();
  fetchProjects();
  fetchTranscriptions();
  checkAuthUser();
  setupDragAndDrop();
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
  const chitaModelEl = document.getElementById('chita-model-name');
  const golfinhoModelEl = document.getElementById('golfinho-model-name');
  const baleiaModelEl = document.getElementById('baleia-model-name');

  if (chitaModelEl) chitaModelEl.innerText = state.systemSettings.chita_model || 'openai/whisper-1';
  if (golfinhoModelEl) golfinhoModelEl.innerText = state.systemSettings.golfinho_model || 'openai/whisper-large-v3-turbo';
  if (baleiaModelEl) baleiaModelEl.innerText = state.systemSettings.baleia_model || 'openai/whisper-large-v3';

  // Ocultar modos se desabilitados pelo Admin
  const modeChitaCard = document.getElementById('mode-chita');
  const modeGolfinhoCard = document.getElementById('mode-golfinho');
  const modeBaleiaCard = document.getElementById('mode-baleia');

  if (modeChitaCard && state.systemSettings.chita_enabled === 'false') modeChitaCard.style.display = 'none';
  if (modeGolfinhoCard && state.systemSettings.golfinho_enabled === 'false') modeGolfinhoCard.style.display = 'none';
  if (modeBaleiaCard && state.systemSettings.baleia_enabled === 'false') modeBaleiaCard.style.display = 'none';

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

// Busca em Tempo Real
function handleSearch() {
  const query = (document.getElementById('search-input')?.value || '').toLowerCase().trim();
  const rows = document.querySelectorAll('#transcriptions-tbody tr');

  rows.forEach(row => {
    const text = row.innerText.toLowerCase();
    if (!query || text.includes(query)) {
      row.style.display = '';
    } else {
      row.style.display = 'none';
    }
  });
}

// ---------------------------------------------------
// GERENCIAMENTO DE PROJETOS & TRANSCRIÇÕES
// ---------------------------------------------------

async function fetchProjects() {
  try {
    const res = await fetch('/api/projects', {
      headers: { 'Authorization': `Bearer ${state.token}` }
    });
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
        <span class="text-[10px] bg-slate-800 text-slate-400 px-1.5 py-0.5 rounded font-bold">${p.file_count || 0}</span>
        <button onclick="deleteProject('${p.id}', '${escapeHtml(p.name)}')" class="hidden group-hover/project:block text-slate-500 hover:text-red-400 p-0.5" title="Excluir Projeto">
          <i data-lucide="trash-2" class="w-3 h-3"></i>
        </button>
      </div>
    </div>
  `).join('');

  if (window.lucide) lucide.createIcons();
}

async function openNewProjectModal() {
  const name = prompt('Nome do novo projeto:');
  if (!name) return;

  try {
    const res = await fetch('/api/projects', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${state.token}`
      },
      body: JSON.stringify({ name })
    });
    if (res.ok) {
      fetchProjects();
    }
  } catch (e) {
    alert('Erro ao criar projeto: ' + e.message);
  }
}

async function deleteProject(id, name) {
  if (!confirm(`Tem certeza que deseja excluir o projeto "${name}"? Os arquivos associados não serão excluídos.`)) return;

  try {
    const res = await fetch(`/api/projects/${id}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${state.token}` }
    });
    if (res.ok) {
      if (state.currentProjectId === id) state.currentProjectId = null;
      fetchProjects();
      fetchTranscriptions();
    }
  } catch (e) {
    alert('Erro ao excluir projeto: ' + e.message);
  }
}

function filterByProject(projectId) {
  state.currentProjectId = projectId;
  renderProjectsSidebar();

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
      
      const modeName = state.activeTranscription.mode === 'chita' ? 'Chita' : state.activeTranscription.mode === 'golfinho' ? 'Golfinho' : 'Baleia';
      const modelUsed = state.systemSettings[`${state.activeTranscription.mode}_model`] || (state.activeTranscription.mode === 'chita' ? 'openai/whisper-1' : state.activeTranscription.mode === 'golfinho' ? 'openai/whisper-large-v3-turbo' : 'openai/whisper-large-v3');
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
        <td colspan="7" class="text-center p-12 text-slate-400">
          <i data-lucide="file-audio" class="w-12 h-12 mx-auto mb-3 opacity-40"></i>
          <p class="font-bold text-sm text-slate-600">Nenhum arquivo transcrito ainda</p>
          <p class="text-xs text-slate-400 mt-1">Clique em "+ TRANSCREVER ARQUIVOS" no topo para enviar o seu primeiro áudio.</p>
        </td>
      </tr>
    `;
    if (window.lucide) lucide.createIcons();
    return;
  }

  tbody.innerHTML = state.transcriptions.map(item => {
    // Badges de MODO com alta visibilidade, contornos marcantes e alto contraste para UX excelente
    let modeBadge = '';
    if (item.mode === 'chita' || item.mode === 'openai/whisper-1') {
      modeBadge = `<span class="inline-flex items-center space-x-1.5 bg-amber-900 text-amber-100 border-2 border-amber-500 shadow-md font-black text-[11px] px-3 py-1 rounded-xl tracking-wide" title="Modelo: openai/whisper-1">
        <span class="text-sm">🐆</span><span>Chita (Fast)</span>
      </span>`;
    } else if (item.mode === 'golfinho' || item.mode === 'openai/whisper-large-v3-turbo') {
      modeBadge = `<span class="inline-flex items-center space-x-1.5 bg-teal-900 text-teal-100 border-2 border-teal-500 shadow-md font-black text-[11px] px-3 py-1 rounded-xl tracking-wide" title="Modelo: openai/whisper-large-v3-turbo">
        <span class="text-sm">🐬</span><span>Golfinho (Turbo)</span>
      </span>`;
    } else {
      modeBadge = `<span class="inline-flex items-center space-x-1.5 bg-indigo-900 text-indigo-100 border-2 border-indigo-500 shadow-md font-black text-[11px] px-3 py-1 rounded-xl tracking-wide" title="Modelo: openai/whisper-large-v3">
        <span class="text-sm">🐋</span><span>Baleia (v3 Padrão)</span>
      </span>`;
    }

    const durationFormatted = formatDuration(item.duration_seconds || 0);
    const dateFormatted = new Date(item.created_at).toLocaleDateString('pt-BR', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });

    return `
      <tr class="hover:bg-slate-50 transition border-b border-slate-100 group">
        <td class="p-4"><input type="checkbox" value="${item.id}" onchange="handleRowCheckboxChange()" class="row-checkbox rounded text-blue-600 focus:ring-blue-500"></td>
        <td class="p-4 font-bold text-slate-800">
          <div class="flex items-center space-x-2">
            <button onclick="openTranscriptionDetail('${item.id}')" class="hover:text-blue-600 text-left truncate max-w-xs">
              ${item.project_name ? `<span class="text-[10px] text-slate-400 block font-normal">📁 ${escapeHtml(item.project_name)}</span>` : ''}
              <span class="font-bold">${escapeHtml(item.file_name)}</span>
            </button>
          </div>
        </td>
        <td class="p-4 text-slate-500 text-xs">${dateFormatted}</td>
        <td class="p-4 text-slate-700 font-medium text-xs">${durationFormatted}</td>
        <td class="p-4 text-xs font-semibold">${modeBadge}</td>
        <td class="p-4">
          <span class="inline-flex items-center space-x-1 text-emerald-600 font-bold text-xs bg-emerald-50 px-2 py-0.5 rounded-full border border-emerald-200">
            <i data-lucide="check-circle-2" class="w-3.5 h-3.5"></i>
            <span>Concluído</span>
          </span>
        </td>
        <td class="p-4 text-right relative">
          <div class="inline-block text-left group/menu">
            <button class="p-1.5 hover:bg-slate-200 rounded-lg text-slate-500">
              <i data-lucide="more-horizontal" class="w-4 h-4"></i>
            </button>

            <!-- Dropdown Context Menu -->
            <div class="hidden group-hover/menu:block absolute right-0 mt-1 w-48 bg-white text-slate-800 text-xs font-semibold rounded-xl shadow-xl border border-slate-200 py-1.5 z-30">
              <button onclick="openTranscriptionDetail('${item.id}')" class="w-full text-left px-3.5 py-2 hover:bg-slate-50 flex items-center space-x-2">
                <i data-lucide="external-link" class="w-3.5 h-3.5 text-blue-600"></i>
                <span>Abrir transcrição</span>
              </button>
              <button onclick="openTranscriptionDetail('${item.id}')" class="w-full text-left px-3.5 py-2 hover:bg-slate-50 flex items-center space-x-2">
                <i data-lucide="download" class="w-3.5 h-3.5 text-emerald-600"></i>
                <span>Exportar transcrição</span>
              </button>
              <button onclick="deleteTranscription('${item.id}')" class="w-full text-left px-3.5 py-2 hover:bg-slate-50 text-red-600 flex items-center space-x-2 border-t border-slate-100">
                <i data-lucide="trash-2" class="w-3.5 h-3.5"></i>
                <span>Excluir arquivo</span>
              </button>
            </div>
          </div>
        </td>
      </tr>
    `;
  }).join('');

  if (window.lucide) lucide.createIcons();
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

    const modeName = data.mode === 'chita' ? 'Chita' : data.mode === 'golfinho' ? 'Golfinho' : 'Baleia';
    const modelUsed = state.systemSettings[`${data.mode}_model`] || (data.mode === 'chita' ? 'openai/whisper-1' : data.mode === 'golfinho' ? 'openai/whisper-large-v3-turbo' : 'openai/whisper-large-v3');
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

function renderCurrentTranscript() {
  const container = document.getElementById('transcript-content');
  if (!container || !state.activeTranscription) return;

  const showTimestamps = document.getElementById('toggle-timestamps')?.checked ?? true;
  const segments = state.activeTranscription.segments || [];

  if (segments.length === 0 || !showTimestamps) {
    container.innerHTML = `<p class="leading-relaxed text-slate-800">${escapeHtml(state.activeTranscription.raw_text || '')}</p>`;
    return;
  }

  container.innerHTML = segments.map(seg => `
    <div class="mb-4 flex items-start space-x-3 group hover:bg-blue-50/50 p-2 rounded-xl transition">
      <button onclick="seekAudio(${seg.start_time})" class="text-xs font-bold text-blue-600 hover:underline bg-blue-100 px-2 py-0.5 rounded shrink-0">
        [${formatSRTTimeShort(seg.start_time)}]
      </button>
      <div class="flex-1">
        ${seg.speaker ? `<span class="text-xs font-bold text-slate-500 block mb-0.5">${escapeHtml(seg.speaker)}</span>` : ''}
        <p class="text-slate-800 text-sm leading-relaxed">${escapeHtml(seg.text)}</p>
      </div>
    </div>
  `).join('');
}

function seekAudio(seconds) {
  const audio = document.getElementById('audio-player');
  if (audio) {
    audio.currentTime = seconds;
    audio.play();
  }
}

async function saveTranscriptChanges() {
  if (!state.activeTranscription) return;
  const container = document.getElementById('transcript-content');
  const newText = container.innerText;

  try {
    const res = await fetch(`/api/transcriptions/${state.activeTranscription.id}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${state.token}`
      },
      body: JSON.stringify({ raw_text: newText })
    });
    if (res.ok) {
      state.activeTranscription.raw_text = newText;
      alert('Descrição e transcrição atualizadas com sucesso no Banco de Dados!');
    }
  } catch (e) {
    alert('Erro ao salvar edições no banco de dados: ' + e.message);
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
}

function selectMode(mode) {
  state.selectedMode = mode;

  if (mode === 'chita') state.selectedModelId = 'openai/whisper-1';
  else if (mode === 'golfinho') state.selectedModelId = 'openai/whisper-large-v3-turbo';
  else if (mode === 'baleia') state.selectedModelId = 'openai/whisper-large-v3';

  const select = document.getElementById('openrouter-model-select');
  if (select) select.value = state.selectedModelId;

  ['chita', 'golfinho', 'baleia'].forEach(m => {
    const el = document.getElementById(`mode-${m}`);
    if (el) {
      if (m === mode) {
        el.className = 'border-2 border-indigo-600 bg-indigo-50/95 p-3.5 rounded-2xl text-center cursor-pointer shadow-lg transform scale-[1.03] transition duration-200';
      } else {
        el.className = 'border-2 border-slate-200 bg-slate-50 p-3.5 rounded-2xl text-center cursor-pointer hover:border-slate-300 transition duration-200';
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
  btn.innerText = 'PROCESSANDO TRANSCRIÇÃO...';

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

  try {
    const res = await fetch('/api/transcribe', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${state.token}` },
      body: formData
    });
    const data = await res.json();
    if (data.success) {
      closeTranscribeModal();
      await fetchTranscriptions();
      if (data.data && data.data[0]) {
        openTranscriptionDetail(data.data[0].id);
      }
    } else {
      alert('Erro na transcrição: ' + (data.error || 'Desconhecido'));
    }
  } catch (e) {
    alert('Erro ao enviar áudio: ' + e.message);
  } finally {
    btn.disabled = false;
    btn.innerText = 'TRANSCREVER';
  }
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
      <div class="bg-white p-3 rounded-xl border border-slate-200 shadow-sm mr-6">
        <p class="font-bold text-emerald-700">ChatGPT:</p>
        <div class="text-slate-800 mt-1 leading-relaxed">${escapeHtml(data.answer)}</div>
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
        tabBtn.className = 'px-4 py-2.5 text-xs font-bold text-blue-600 border-b-2 border-blue-600 transition';
      } else {
        tabContent.classList.add('hidden');
        tabBtn.className = 'px-4 py-2.5 text-xs font-bold text-slate-500 hover:text-slate-800 transition';
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
      <tr class="hover:bg-slate-50">
        <td class="p-4 font-bold text-slate-800">${escapeHtml(u.name)}</td>
        <td class="p-4 text-slate-600">${escapeHtml(u.email)}</td>
        <td class="p-4"><span class="px-2 py-0.5 text-[10px] font-bold rounded ${u.role === 'admin' ? 'bg-purple-100 text-purple-800' : 'bg-slate-100 text-slate-700'}">${u.role}</span></td>
        <td class="p-4 text-slate-700 font-semibold">${u.daily_limit} transcrições</td>
        <td class="p-4"><span class="px-2 py-0.5 text-[10px] font-bold rounded ${u.status === 'active' ? 'bg-emerald-100 text-emerald-800' : 'bg-red-100 text-red-800'}">${u.status}</span></td>
        <td class="p-4 text-right">
          <button onclick="toggleUserStatus('${u.id}', '${u.status === 'active' ? 'suspended' : 'active'}')" class="text-blue-600 hover:underline font-semibold text-xs">
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
      <tr class="hover:bg-slate-50">
        <td class="p-4 font-bold text-purple-700 uppercase text-[11px]">${k.provider}</td>
        <td class="p-4 text-slate-800 font-semibold">${escapeHtml(k.name || 'Sem nome')}</td>
        <td class="p-4 font-mono text-slate-600">${k.masked_key}</td>
        <td class="p-4"><span class="px-2 py-0.5 text-[10px] font-bold rounded ${k.is_active ? 'bg-emerald-100 text-emerald-800' : 'bg-slate-100 text-slate-600'}">${k.is_active ? 'Ativa' : 'Inativa'}</span></td>
        <td class="p-4 text-right">
          ${!k.is_active ? `<button onclick="activateApiKey('${k.id}')" class="text-blue-600 hover:underline font-semibold text-xs mr-3">Tornar Ativa</button>` : ''}
          <button onclick="deleteApiKey('${k.id}')" class="text-red-600 hover:underline font-semibold text-xs">Excluir</button>
        </td>
      </tr>
    `).join('');
  } catch (e) {
    console.error('Erro ao carregar chaves:', e);
  }
}

async function openAddKeyModal() {
  const key_value = prompt('Cole a nova chave OpenRouter (sk-or-v1-...):');
  if (!key_value) return;
  const name = prompt('Nome de identificação da chave:', 'Chave Backup OpenRouter');

  try {
    await fetch('/api/admin/apikeys', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${state.token}`
      },
      body: JSON.stringify({ provider: 'openrouter', name, key_value })
    });
    loadAdminApiKeys();
  } catch (e) {
    alert('Erro ao salvar chave: ' + e.message);
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
    document.getElementById('admin-setting-chita-model').value = s.chita_model || 'openai/whisper-1';
    document.getElementById('admin-setting-golfinho-model').value = s.golfinho_model || 'openai/whisper-large-v3-turbo';
    document.getElementById('admin-setting-baleia-model').value = s.baleia_model || 'openai/whisper-large-v3';

    document.getElementById('admin-setting-chita-enabled').checked = s.chita_enabled !== 'false';
    document.getElementById('admin-setting-golfinho-enabled').checked = s.golfinho_enabled !== 'false';
    document.getElementById('admin-setting-baleia-enabled').checked = s.baleia_enabled !== 'false';
  } catch (e) {
    console.error('Erro ao carregar configurações admin:', e);
  }
}

async function saveAdminSettings(e) {
  e.preventDefault();
  const settings = {
    chita_model: document.getElementById('admin-setting-chita-model').value,
    golfinho_model: document.getElementById('admin-setting-golfinho-model').value,
    baleia_model: document.getElementById('admin-setting-baleia-model').value,
    chita_enabled: document.getElementById('admin-setting-chita-enabled').checked ? 'true' : 'false',
    golfinho_enabled: document.getElementById('admin-setting-golfinho-enabled').checked ? 'true' : 'false',
    baleia_enabled: document.getElementById('admin-setting-baleia-enabled').checked ? 'true' : 'false'
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
      <tr class="hover:bg-slate-50">
        <td class="p-4 text-slate-500 font-mono text-[11px]">${new Date(l.timestamp).toLocaleString('pt-BR')}</td>
        <td class="p-4 font-semibold text-slate-700">${escapeHtml(l.user_email || 'Sistema')}</td>
        <td class="p-4"><span class="px-2 py-0.5 text-[10px] font-bold rounded bg-blue-50 text-blue-700 border border-blue-200">${l.action}</span></td>
        <td class="p-4 text-slate-600 font-mono text-[11px] truncate max-w-xs">${escapeHtml(l.details || '')}</td>
        <td class="p-4 text-slate-500 font-mono text-[11px]">${l.ip_address}</td>
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
