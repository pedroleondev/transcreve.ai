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
  transcriptionsSignature: null, // anti-travamento: re-render só se a lista mudou
  // Preferências de Leitura (T-04)
  readingMode: localStorage.getItem('transcreveai_reading_mode') || 'transcript', // 'transcript' | 'reading' | 'summary'
  fontSize: localStorage.getItem('transcreveai_font_size') || 'md', // 'sm' | 'md' | 'lg'
  columnWidth: localStorage.getItem('transcreveai_column_width') || 'normal', // 'narrow' | 'normal' | 'wide'
  // "Dados técnicos" (modelo de IA, tokens) — desligado por padrão: tela limpa
  // para o usuário comum; quem quiser nerd mode, liga o chip no cabeçalho.
  nerdMode: localStorage.getItem('falou_nerd_mode') === '1'
};

// SEGURANÇA (hotfix 28/09): NUNCA fazer auto-login com credenciais
// hardcoded — sem token válido, o app mostra o modal de login. O fallback
// anterior entrava sozinho como usuário demo em qualquer navegador novo.
async function ensureAuthToken() {
  if (state.token) return true;
  const stored = localStorage.getItem('turboscribe_token');
  if (stored) {
    try {
      const res = await fetch('/api/auth/me', { headers: { 'Authorization': `Bearer ${stored}` } });
      if (res.ok) {
        const data = await res.json();
        if (data.user) {
          state.token = stored;
          state.currentUser = data.user;
          return true;
        }
      }
    } catch (_) { /* rede falhou: tentativa silenciosa abaixo reabre login */ }
    localStorage.removeItem('turboscribe_token');
  }
  openLoginModal();
  return false;
}

// Inicialização
document.addEventListener('DOMContentLoaded', async () => {
  if (window.lucide) lucide.createIcons();
  syncNerdToggle();
  // Anti-autofill da busca (incidente 04/10): o Chrome insiste em escrever o
  // e-mail da sessão no campo de busca — mesmo com autocomplete=off — e a
  // lista inteira ficava invisível (parecia "arquivos sumiram"). O campo é
  // readonly até o foco; aqui, por precaução, limpamos qualquer valor que
  // aparecer sem foco nos primeiros segundos após o carregamento.
  const clearAutofilledSearch = () => {
    const input = document.getElementById('search-input');
    if (input && input.value && document.activeElement !== input) {
      input.value = '';
      handleSearch();
    }
  };
  clearAutofilledSearch();
  setTimeout(clearAutofilledSearch, 1000);
  setTimeout(clearAutofilledSearch, 3000);
  // O campo começa readonly (Chrome não autofill campo readonly) e perde o
  // readonly no foco — em dois mecanismos (inline onfocus + listener) para
  // cobrir navegadores mobile que tratam foco por toque de forma diferente.
  const searchInput = document.getElementById('search-input');
  if (searchInput) {
    const unlock = function () { this.removeAttribute('readonly'); };
    searchInput.addEventListener('focus', unlock);
    searchInput.addEventListener('pointerdown', unlock);
    searchInput.addEventListener('touchstart', unlock, { passive: true });
  }
  // T-28: deep-link de confirmação de e-mail (/app?confirm_token=...) — a
  // landing manda o link para cá; a confirmação é pública e precede o login.
  const confirmToken = new URLSearchParams(location.search).get('confirm_token');
  if (confirmToken) {
    history.replaceState(null, '', '/app');
    try {
      const res = await fetch('/api/auth/confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: confirmToken })
      });
      const data = await res.json().catch(() => ({}));
      openLoginModal();
      const notice = document.getElementById('login-notice');
      if (notice) {
        notice.textContent = data.message || (res.ok ? 'E-mail confirmado! Faça login.' : 'Não foi possível confirmar.');
        notice.className = res.ok
          ? 'text-xs font-semibold p-2.5 rounded-xl border bg-emerald-50 dark:bg-emerald-950/60 text-emerald-700 dark:text-emerald-300 border-emerald-200 dark:border-emerald-800'
          : 'text-xs font-semibold p-2.5 rounded-xl border bg-red-50 dark:bg-red-950/60 text-red-700 dark:text-red-300 border-red-200 dark:border-red-800';
      }
    } catch (_) {
      openLoginModal();
    }
    return;
  }
  const authed = await ensureAuthToken();
  if (!authed) return; // sem sessão: só o modal de login; os dados carregam após o login
  fetchSystemSettings();
  fetchOpenRouterModels();
  fetchProjects();
  fetchTranscriptions();
  setupDragAndDrop();
  populateLanguageSelect(); // T-20: select de idiomas do modal de upload
  await checkAuthUser(); // papel real ANTES de consultar o estado da chave
  loadApiKeyStatus();
});

// T-20: select de idioma com busca. A lista vem de WHISPER_LANGUAGES
// (/languages.js = services/languages.js, a mesma que o backend valida).
function populateLanguageSelect(filter) {
  const select = document.getElementById('transcribe-language');
  if (!select || typeof WHISPER_LANGUAGES === 'undefined') return;
  const current = select.value || 'auto';
  const auto = document.createElement('option');
  auto.value = 'auto';
  auto.textContent = '🌍 Detectar automaticamente (recomendado)';
  select.innerHTML = '';
  select.appendChild(auto);
  for (const l of WHISPER_LANGUAGES.listForSelect(filter)) {
    const opt = document.createElement('option');
    opt.value = l.code;
    opt.textContent = `${l.native} — ${l.name} (${l.code})`;
    select.appendChild(opt);
  }
  select.value = [...select.options].some(o => o.value === current) ? current : 'auto';
}

function filterLanguageOptions() {
  const filter = document.getElementById('language-filter');
  populateLanguageSelect(filter ? filter.value : '');
}

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

      // T-07: consumo do dia no dashboard ("X de Y transcrições hoje").
      const badge = document.getElementById('quota-badge');
      const badgeText = document.getElementById('quota-badge-text');
      if (badge && badgeText) {
        if (data.user.quota_unlimited) {
          badgeText.innerText = 'Uso ilimitado';
        } else {
          badgeText.innerText = `${data.user.used_today ?? 0} de ${data.user.daily_limit} hoje`;
        }
        badge.classList.remove('hidden');
        badge.classList.add('flex');
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

// Alternar Views da SPA (dashboard, details, admin, account)
function showView(viewName) {
  state.currentView = viewName;
  document.getElementById('view-dashboard').classList.add('hidden');
  document.getElementById('view-details').classList.add('hidden');
  document.getElementById('view-admin').classList.add('hidden');
  document.getElementById('view-account').classList.add('hidden');
  closeSidebar(); // T-17: drawer fecha ao navegar (mobile)

  if (viewName === 'dashboard') {
    document.getElementById('view-dashboard').classList.remove('hidden');
    fetchTranscriptions();
  } else if (viewName === 'details') {
    document.getElementById('view-details').classList.remove('hidden');
  } else if (viewName === 'admin') {
    document.getElementById('view-admin').classList.remove('hidden');
    loadAdminMetrics();
  } else if (viewName === 'account') {
    document.getElementById('view-account').classList.remove('hidden');
    loadAccountData();
  }
}

// ---------------------------------------------------
// T-09: MINHA CONTA (perfil, senha, assinatura, logs de uso)
// ---------------------------------------------------
async function loadAccountData() {
  // Perfil e sessão (já vem em /api/auth/me)
  try {
    const res = await fetch('/api/auth/me', { headers: { 'Authorization': `Bearer ${state.token}` } });
    if (res.ok) {
      const data = await res.json();
      if (data.user) {
        state.currentUser = { ...state.currentUser, ...data.user };
        const nameEl = document.getElementById('account-name');
        const emailEl = document.getElementById('account-email');
        const roleEl = document.getElementById('account-role');
        const sinceEl = document.getElementById('account-since');
        if (nameEl) nameEl.value = data.user.name || '';
        if (emailEl) emailEl.value = data.user.email || '';
        if (roleEl) roleEl.value = data.user.role === 'admin' ? 'Administrador' : 'Usuário';
        if (sinceEl && data.user.created_at) sinceEl.textContent = new Date(data.user.created_at).toLocaleDateString('pt-BR');
        const cpfEl = document.getElementById('account-cpf');
        if (cpfEl) cpfEl.value = data.user.cpf_cnpj || '';
      }
    }
  } catch (_) { /* silencioso: seções abaixo carregam independentemente */ }

  // Assinatura (plano + quota)
  await renderAccountSubscription();

  loadAccountUsage();
}

// T-27 (Asaas): renderiza plano, quota e assinatura Asaas na aba Conta.
async function renderAccountSubscription() {
  try {
    const res = await fetch('/api/account/subscription', { headers: { 'Authorization': `Bearer ${state.token}` } });
    if (!res.ok) return;
    const sub = await res.json();
    const badge = document.getElementById('account-plan-badge');
    const quota = document.getElementById('account-quota');
    const subDetail = document.getElementById('account-subscription-detail');
    const planLabels = { gratuito: 'Gratuito', bronze: 'Bronze', prata: 'Prata', ouro: 'Ouro' };
    if (badge) {
      const label = planLabels[sub.plan] || sub.plan;
      badge.textContent = `${label}${sub.status === 'suspended' ? ' (suspenso)' : ''}`;
    }
    if (quota) {
      quota.innerHTML = sub.quota.unlimited
        ? '📊 Consumo hoje: <b>ilimitado</b> (administrador)'
        : `📊 Consumo hoje: <b>${sub.quota.used_today} de ${sub.quota.limit}</b> transcrições nas últimas 24 h`;
    }
    if (subDetail) {
      if (sub.subscription) {
        const s = sub.subscription;
        const cycleLabel = s.cycle === 'annual' ? 'anual' : 'mensal';
        const statusLabels = { pending: 'aguardando pagamento', active: 'ativa', overdue: 'em atraso' };
        subDetail.innerHTML = `
          <p class="text-xs text-brand-copy dark:text-brand-copy">Assinatura <b>${planLabels[s.plan] || s.plan}</b> (${cycleLabel}) — ${statusLabels[s.status] || s.status}
            ${s.renews_at ? ` · renovação em <b>${new Date(s.renews_at).toLocaleDateString('pt-BR')}</b>` : ''}</p>
          <button onclick="cancelSubscription()" class="mt-2 text-[11px] font-bold text-red-600 dark:text-red-400 hover:underline">Cancelar assinatura</button>`;
      } else {
        subDetail.innerHTML = sub.plan === 'gratuito'
          ? `<button onclick="openUpgradeModal()" class="text-[11px] font-bold text-blue-600 dark:text-blue-400 hover:underline">Ver planos pagos</button>`
          : '';
      }
    }
  } catch (_) { /* silencioso */ }
}

async function loadAccountUsage() {
  const tbody = document.getElementById('account-usage-tbody');
  if (!tbody) return;
  try {
    const res = await fetch('/api/account/usage?limit=20', { headers: { 'Authorization': `Bearer ${state.token}` } });
    if (!res.ok) { tbody.innerHTML = '<tr><td colspan="6" class="p-4 text-center text-brand-muted dark:text-brand-muted">Erro ao carregar.</td></tr>'; return; }
    const data = await res.json();

    const totalsEl = document.getElementById('account-usage-totals');
    if (totalsEl) {
      const t = data.totals || {};
      const cards = [
        ['Transcrições', t.total_transcriptions || 0],
        ['Áudio total', formatDuration(t.total_seconds || 0)],
        ['Tokens IA (entrada)', (t.ai_tokens_in || 0).toLocaleString('pt-BR')],
        ['Tokens IA (saída)', (t.ai_tokens_out || 0).toLocaleString('pt-BR')]
      ];
      totalsEl.innerHTML = cards.map(([label, value]) => `
        <div class="bg-brand-canvas dark:bg-brand-canvas border border-brand-line dark:border-brand-line rounded-xl p-3 text-center">
          <p class="text-base font-black text-brand-ink dark:text-brand-ink">${value}</p>
          <p class="text-[10px] text-brand-muted dark:text-brand-muted uppercase font-bold mt-0.5">${label}</p>
        </div>`).join('');
    }

    if (!data.recent || !data.recent.length) {
      tbody.innerHTML = '<tr><td colspan="6" class="p-4 text-center text-brand-muted dark:text-brand-muted">Nenhuma transcrição ainda.</td></tr>';
      return;
    }
    const statusLabel = { completed: 'Concluída', pending: 'Na fila', processing: 'Processando', failed: 'Falhou' };
    const statusClass = { completed: 'text-emerald-600 dark:text-emerald-300', pending: 'text-amber-600 dark:text-amber-300', processing: 'text-blue-600 dark:text-blue-300', failed: 'text-red-600 dark:text-red-300' };
    tbody.innerHTML = data.recent.map(t => `
      <tr class="hover:bg-brand-canvas dark:hover:bg-brand-canvas">
        <td class="p-3 whitespace-nowrap text-brand-copy dark:text-brand-copy">${new Date(t.created_at).toLocaleString('pt-BR')}</td>
        <td class="p-3 text-brand-ink dark:text-brand-ink font-semibold max-w-[180px] truncate" title="${t.file_name}">${t.file_name}</td>
        <td class="p-3 text-brand-copy dark:text-brand-copy">${formatDuration(t.duration_seconds || 0)}</td>
        <td class="p-3 text-brand-copy dark:text-brand-copy uppercase">${t.mode || '—'}</td>
        <td class="p-3 font-bold ${statusClass[t.status] || 'text-brand-copy dark:text-brand-copy'}">${statusLabel[t.status] || t.status}</td>
        <td class="p-3 text-brand-copy dark:text-brand-copy">${t.ai_tokens ? t.ai_tokens.toLocaleString('pt-BR') : '—'}</td>
      </tr>`).join('');
  } catch (_) {
    tbody.innerHTML = '<tr><td colspan="6" class="p-4 text-center text-brand-muted dark:text-brand-muted">Erro ao carregar.</td></tr>';
  }
}

async function saveAccountProfile(e) {
  e.preventDefault();
  const msg = document.getElementById('account-profile-msg');
  const name = document.getElementById('account-name').value.trim();
  if (!name) return;
  const cpfInput = document.getElementById('account-cpf');
  const cpf = cpfInput ? cpfInput.value.trim() : '';
  try {
    const res = await fetch('/api/account', {
      method: 'PUT',
      headers: { 'Authorization': `Bearer ${state.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, cpf_cnpj: cpf })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Erro ao salvar.');
    state.currentUser.name = data.name || name;
    if (cpfInput && data.cpf_cnpj) cpfInput.value = data.cpf_cnpj;
    const nameSpan = document.getElementById('user-dropdown-name');
    if (nameSpan) nameSpan.textContent = state.currentUser.name;
    if (msg) { msg.textContent = 'Perfil salvo.'; msg.className = 'text-xs font-semibold text-emerald-600 dark:text-emerald-300'; msg.classList.remove('hidden'); }
  } catch (err) {
    if (msg) { msg.textContent = err.message; msg.className = 'text-xs font-semibold text-red-600 dark:text-red-300'; msg.classList.remove('hidden'); }
  }
}

async function changeAccountPassword(e) {
  e.preventDefault();
  const errEl = document.getElementById('account-password-error');
  const okEl = document.getElementById('account-password-ok');
  errEl.classList.add('hidden'); okEl.classList.add('hidden');
  const current = document.getElementById('account-current-password').value;
  const next = document.getElementById('account-new-password').value;
  const next2 = document.getElementById('account-new-password-2').value;
  if (next !== next2) {
    errEl.textContent = 'As novas senhas não coincidem.';
    errEl.classList.remove('hidden');
    return;
  }
  try {
    const res = await fetch('/api/auth/password', {
      method: 'PUT',
      headers: { 'Authorization': `Bearer ${state.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ current_password: current, new_password: next })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Erro ao trocar a senha.');
    document.getElementById('account-current-password').value = '';
    document.getElementById('account-new-password').value = '';
    document.getElementById('account-new-password-2').value = '';
    okEl.classList.remove('hidden');
  } catch (err) {
    errEl.textContent = err.message;
    errEl.classList.remove('hidden');
  }
}

// Upgrade de plano (T-27/Asaas): preços lidos de system_settings
// (plan_bronze_monthly etc.). Sem ASAAS_API_KEY no servidor, os botões viram
// "Em breve" (nada de dado fictício).
let upgradeCycle = 'monthly';
const UPGRADE_PLANS = ['bronze', 'prata', 'ouro'];
const UPGRADE_DEFAULTS = {
  bronze: { monthly: '19.90', annual: '199.00', quota: 15 },
  prata: { monthly: '49.90', annual: '499.00', quota: 60 },
  ouro: { monthly: '99.90', annual: '999.00', quota: 999999 }
};
let upgradeBillingEnabled = false;

async function openUpgradeModal() {
  document.getElementById('upgrade-modal').classList.remove('hidden');
  applyUpgradeCycleUI();
  try {
    const res = await fetch('/api/settings');
    const settings = res.ok ? await res.json() : {};
    upgradeBillingEnabled = settings.billing_enabled === true;
    for (const planKey of UPGRADE_PLANS) {
      const d = UPGRADE_DEFAULTS[planKey];
      const price = settings[`plan_${planKey}_${upgradeCycle}`] || (upgradeCycle === 'monthly' ? d.monthly : d.annual);
      const priceEl = document.getElementById(`upgrade-price-${planKey}`);
      const noteEl = document.getElementById(`upgrade-price-${planKey}-note`);
      const btn = document.getElementById(`btn-subscribe-${planKey}`);
      const quotaEl = document.getElementById(`quota-${planKey}`);
      const quota = Number(settings[`plan_${planKey}_quota`] || d.quota);
      if (quotaEl) quotaEl.textContent = quota >= 999999 ? 'ilimitadas' : quota;
      if (priceEl) priceEl.innerHTML = `R$ ${price} <span class="text-xs font-normal text-brand-muted dark:text-brand-muted">/${upgradeCycle === 'monthly' ? 'mês' : 'ano'}</span>`;
      if (noteEl) noteEl.textContent = upgradeCycle === 'annual' ? 'cobrança anual' : 'cobrança mensal';
      if (btn) {
        if (upgradeBillingEnabled) {
          btn.disabled = false;
          btn.textContent = `Assinar ${planKey.charAt(0).toUpperCase() + planKey.slice(1)}`;
          btn.classList.remove('opacity-50', 'cursor-not-allowed');
        } else {
          btn.disabled = true;
          btn.textContent = 'Em breve';
          btn.classList.add('opacity-50', 'cursor-not-allowed');
        }
      }
    }
    const note = document.getElementById('upgrade-billing-note');
    if (note) note.textContent = upgradeBillingEnabled
      ? 'O plano é liberado automaticamente após o pagamento da fatura (PIX, boleto ou cartão).'
      : 'A cobrança online ainda não está configurada neste servidor. Administradores podem ajustar preços em Configurações.';
  } catch (_) { /* mantém o estado atual */ }
}
function closeUpgradeModal() { document.getElementById('upgrade-modal').classList.add('hidden'); }
function setUpgradeCycle(cycle) {
  upgradeCycle = cycle;
  applyUpgradeCycleUI();
  openUpgradeModal();
}
function applyUpgradeCycleUI() {
  const active = 'bg-blue-600 text-white';
  const idle = 'text-brand-copy dark:text-brand-copy hover:text-brand-ink dark:hover:text-brand-ink';
  const m = document.getElementById('upgrade-cycle-monthly');
  const a = document.getElementById('upgrade-cycle-annual');
  if (m) m.className = `px-4 py-1.5 rounded-full transition ${upgradeCycle === 'monthly' ? active : idle}`;
  if (a) a.className = `px-4 py-1.5 rounded-full transition ${upgradeCycle === 'annual' ? active : idle}`;
}

// T-27 (Asaas): cria a assinatura e abre a fatura (PIX/boleto/cartão) em nova aba.
async function subscribePlan(plan) {
  const btn = document.getElementById(`btn-subscribe-${plan}`);
  if (btn) { btn.disabled = true; btn.textContent = 'Gerando fatura…'; }
  try {
    const res = await fetch('/api/account/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${state.token}` },
      body: JSON.stringify({ plan, cycle: upgradeCycle })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Erro ao criar assinatura.');
    if (data.invoice_url) {
      window.open(data.invoice_url, '_blank', 'noopener');
      uiToast('Fatura gerada! Complete o pagamento na nova aba — seu plano será liberado automaticamente.');
    } else {
      uiToast('Assinatura criada! A fatura estará disponível em instantes.');
    }
    closeUpgradeModal();
    if (typeof renderAccountSubscription === 'function') renderAccountSubscription();
  } catch (e) {
    uiToast(e.message);
  } finally {
    if (btn && upgradeBillingEnabled) { btn.disabled = false; }
    if (btn) openUpgradeModal(); // repõe o rótulo do botão
  }
}

// T-27 (Asaas): cancela a assinatura ativa e volta ao plano gratuito.
async function cancelSubscription() {
  if (!confirm('Cancelar a assinatura? Você voltará ao plano gratuito no fim do processamento. Seu histórico e transcrições são mantidos.')) return;
  try {
    const res = await fetch('/api/account/subscribe/cancel', {
      method: 'POST',
      headers: { Authorization: `Bearer ${state.token}` }
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Erro ao cancelar.');
    uiToast('Assinatura cancelada.');
    if (typeof renderAccountSubscription === 'function') renderAccountSubscription();
  } catch (e) {
    uiToast(e.message);
  }
}

// Logout: limpa o token e volta ao modal de login (aceite T-09).
function logoutUser() {
  localStorage.removeItem('turboscribe_token');
  state.token = '';
  state.currentUser = null;
  ['view-dashboard', 'view-details', 'view-admin', 'view-account'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.classList.add('hidden');
  });
  openLoginModal();
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
  const input = document.getElementById('search-input');
  const query = (input?.value || '').toLowerCase().trim();
  const rows = document.querySelectorAll('#transcriptions-tbody tr');
  const cards = document.querySelectorAll('#transcriptions-cards .transcription-card');

  let visible = 0;
  rows.forEach(row => {
    const text = row.innerText.toLowerCase();
    const show = !query || text.includes(query);
    row.style.display = show ? '' : 'none';
    if (show) visible++;
  });
  cards.forEach(card => {
    const text = card.innerText.toLowerCase();
    const show = !query || text.includes(query);
    card.style.display = show ? '' : 'none';
    if (show) visible++;
  });

  // Feedback explícito quando a busca esconde tudo — antes a tabela ficava
  // em branco sem explicação (usuário achava que os arquivos tinham sumido).
  const noResults = document.getElementById('search-no-results');
  if (noResults) {
    const empty = query && visible === 0;
    noResults.classList.toggle('hidden', !empty);
    if (empty) {
      const txt = document.getElementById('search-no-results-text');
      if (txt) txt.innerText = `Nenhum arquivo contém "${query}"`;
      if (window.lucide) lucide.createIcons();
    }
  }
}

// Mobile: rola a tela de detalhes até o painel de ações (fica depois do texto)
function jumpToDetailActions() {
  const panel = document.getElementById('detail-actions-panel');
  if (panel) panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ---------------------------------------------------
// GERENCIAMENTO DE PROJETOS & TRANSCRIÇÕES
// ---------------------------------------------------

async function fetchProjects() {
  try {
    // T-02: admin continua vendo tudo (comportamento atual); usuário comum só o seu.
    const url = '/api/projects' + (state.currentUser?.role === 'admin' ? '?all=true' : '');
    let res = await fetch(url, {
      headers: { 'Authorization': `Bearer ${state.token}` }
    });
    if (res.status === 401 || res.status === 403) {
      state.token = '';
      localStorage.removeItem('turboscribe_token');
      const relogged = await ensureAuthToken();
      if (relogged) {
        res = await fetch(url, {
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
    <div class="group/project flex items-center justify-between px-3 py-2 rounded-lg text-xs font-semibold ${state.currentProjectId === p.id ? 'bg-brand-raised dark:bg-brand-raised text-brand-accent dark:text-brand-accent' : 'text-brand-muted dark:text-brand-muted hover:bg-brand-raised dark:hover:bg-brand-raised hover:text-brand-ink dark:hover:text-brand-ink'} transition cursor-pointer">
      <button onclick="filterByProject('${p.id}')" class="flex items-center space-x-2.5 truncate flex-1 text-left">
        <i data-lucide="folder" class="w-4 h-4 text-brand-muted dark:text-brand-muted shrink-0"></i>
        <span class="truncate">${escapeHtml(p.name)}</span>
      </button>
      <div class="flex items-center space-x-1">
        <button onclick="openEditProjectModal('${p.id}', '${escapeHtml(p.name)}'); event.stopPropagation();" class="opacity-0 group-hover/project:opacity-100 text-brand-muted dark:text-brand-muted hover:text-brand-accent dark:hover:text-brand-accent p-1 transition" title="Editar Projeto">
          <i data-lucide="pencil" class="w-3.5 h-3.5"></i>
        </button>
        <button onclick="deleteProject('${p.id}', '${escapeHtml(p.name)}'); event.stopPropagation();" class="opacity-0 group-hover/project:opacity-100 text-brand-muted dark:text-brand-muted hover:text-red-400 p-1 transition" title="Excluir Projeto">
          <i data-lucide="trash-2" class="w-3.5 h-3.5"></i>
        </button>
      </div>
    </div>
  `).join('');

  if (window.lucide) lucide.createIcons();
}

// ---------------------------------------------------
// HELPERS DE UI — T-29 F2 (Obsidian Wave)
// uiToast: notificações (ex-alert) · uiPrompt: diálogo de entrada (ex-prompt)
// ---------------------------------------------------
// "Dados técnicos" (nerd mode): o modelo de IA fica escondido por padrão —
// usuário comum não precisa ver "openai/whisper-large-v3". Quem ligar o chip
// passa a ver modelo/tokens no meta e no Resumo IA. Preferência persiste.
function buildDetailMeta(t) {
  const MODE_NAMES = { base: 'Base', pro: 'Pro', max: 'Max' };
  const MODE_DEFAULT_MODELS = { base: 'openai/whisper-1', pro: 'openai/whisper-large-v3-turbo', max: 'openai/whisper-large-v3' };
  const modeName = MODE_NAMES[t.mode] || 'Max';
  const projectDisplay = t.project_name ? ` • Projeto: ${t.project_name}` : '';
  let meta = `${new Date(t.created_at).toLocaleString('pt-BR')} • ${formatDuration(t.duration_seconds)} • Modo ${modeName}${projectDisplay}`;
  if (state.nerdMode) {
    const modelUsed = state.systemSettings[`${t.mode}_model`] || MODE_DEFAULT_MODELS[t.mode] || 'openai/whisper-large-v3';
    meta += ` • ${modelUsed}`;
  }
  return meta;
}

function syncNerdToggle() {
  const btn = document.getElementById('btn-nerd-toggle');
  if (btn) btn.classList.toggle('nerd-on', state.nerdMode);
}

function toggleNerdMode() {
  state.nerdMode = !state.nerdMode;
  localStorage.setItem('falou_nerd_mode', state.nerdMode ? '1' : '0');
  syncNerdToggle();
  // Re-renderiza o meta da tela de detalhes (se houver) com/sem o modelo
  if (state.activeTranscription) {
    const metaEl = document.getElementById('detail-meta');
    if (metaEl) metaEl.innerText = buildDetailMeta(state.activeTranscription);
    renderCurrentTranscript(); // Resumo IA esconde/mostra model+tokens
  }
}
// T-29 F3: menu do usuário abre por clique/toque (group-hover não existe em
// touch); fecha ao clicar fora ou em um item do menu.
function toggleUserMenu(e) {
  if (e) e.stopPropagation();
  const panel = document.getElementById('user-menu-panel');
  if (panel) panel.classList.toggle('hidden');
}
document.addEventListener('click', (e) => {
  const panel = document.getElementById('user-menu-panel');
  if (panel && !panel.classList.contains('hidden') &&
      !e.target.closest('#user-menu-panel') && !e.target.closest('#user-menu-btn')) {
    panel.classList.add('hidden');
  }
});

function uiToast(message, type) {
  if (typeof document === 'undefined' || !document.body) return;
  let host = document.getElementById('ui-toast-host');
  if (!host) {
    host = document.createElement('div');
    host.id = 'ui-toast-host';
    host.style.cssText = 'position:fixed;bottom:calc(1rem + env(safe-area-inset-bottom,0px));left:50%;transform:translateX(-50%);z-index:100;display:flex;flex-direction:column;gap:.5rem;max-width:min(92vw,420px);pointer-events:none';
    document.body.appendChild(host);
  }
  const colors = { info: 'rgb(var(--accent))', success: '#10B981', error: '#F43F5E', warn: '#F59E0B' };
  const el = document.createElement('div');
  el.style.cssText = `background:rgb(var(--surface));color:rgb(var(--ink));border:1px solid rgb(var(--line));border-left:3px solid ${colors[type] || colors.info};padding:.625rem .875rem;border-radius:.75rem;font-size:.8125rem;font-weight:600;box-shadow:0 8px 24px rgba(0,0,0,.35);opacity:0;transition:opacity .2s ease,transform .2s ease;transform:translateY(6px);white-space:pre-line`;
  el.textContent = message;
  host.appendChild(el);
  requestAnimationFrame(() => { el.style.opacity = '1'; el.style.transform = 'translateY(0)'; });
  setTimeout(() => {
    el.style.opacity = '0'; el.style.transform = 'translateY(6px)';
    setTimeout(() => el.remove(), 250);
  }, 4200);
}

function uiPrompt(message, defaultValue, onOk) {
  if (typeof document === 'undefined' || !document.body) return;
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;z-index:110;background:rgba(6,8,15,.6);backdrop-filter:blur(4px);display:flex;align-items:center;justify-content:center;padding:1rem';
  const panel = document.createElement('div');
  panel.style.cssText = 'background:rgb(var(--surface));color:rgb(var(--ink));border:1px solid rgb(var(--line));border-radius:1rem;padding:1.25rem;width:100%;max-width:360px;box-shadow:0 -12px 32px rgba(0,0,0,.45)';
  const label = document.createElement('p');
  label.style.cssText = 'font-size:.875rem;font-weight:700;margin-bottom:.625rem';
  label.textContent = message;
  const input = document.createElement('input');
  input.type = 'text';
  input.value = defaultValue || '';
  input.style.cssText = 'width:100%;background:rgb(var(--raised));border:1px solid rgb(var(--line));color:rgb(var(--ink));border-radius:.5rem;padding:.625rem .75rem;font-size:.9375rem;margin-bottom:.875rem;outline:none';
  const row = document.createElement('div');
  row.style.cssText = 'display:flex;gap:.625rem;justify-content:flex-end';
  const cancelBtn = document.createElement('button');
  cancelBtn.textContent = 'Cancelar';
  cancelBtn.className = 'btn-press';
  cancelBtn.style.cssText = 'padding:.5rem 1rem;border-radius:.5rem;font-size:.8125rem;font-weight:700;color:rgb(var(--muted));background:transparent;border:1px solid rgb(var(--line))';
  const okBtn = document.createElement('button');
  okBtn.textContent = 'Confirmar';
  okBtn.className = 'btn-primary btn-press';
  okBtn.style.cssText = 'padding:.5rem 1rem;border-radius:.5rem;font-size:.8125rem;border:none';
  const close = () => { document.removeEventListener('keydown', onKey, true); overlay.remove(); };
  const confirm = () => { const v = input.value; close(); if (onOk) onOk(v); };
  const onKey = (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); close(); }
    else if (e.key === 'Enter') { e.preventDefault(); confirm(); }
  };
  document.addEventListener('keydown', onKey, true);
  cancelBtn.onclick = close;
  okBtn.onclick = confirm;
  overlay.onclick = (e) => { if (e.target === overlay) close(); };
  row.append(cancelBtn, okBtn);
  panel.append(label, input, row);
  overlay.appendChild(panel);
  document.body.appendChild(overlay);
  input.focus();
  if (defaultValue) input.select();
}

async function openNewProjectModal() {
  uiPrompt('Nome do novo projeto:', '', async (name) => {
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
        uiToast('Erro ao criar projeto: ' + (err.error || 'Erro desconhecido'), 'error');
      }
    } catch (e) {
      uiToast('Erro ao criar projeto: ' + e.message, 'error');
    }
  });
}

async function openEditProjectModal(id, currentName) {
  uiPrompt('Editar nome do projeto:', currentName, async (newName) => {
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
        uiToast('Erro ao atualizar projeto: ' + (err.error || 'Erro desconhecido'), 'error');
      }
    } catch (e) {
      uiToast('Erro ao atualizar projeto: ' + e.message, 'error');
    }
  });
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
      uiToast('Erro ao excluir projeto: ' + (err.error || 'Erro desconhecido'));
    }
  } catch (e) {
    uiToast('Erro ao excluir projeto: ' + e.message);
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

      document.getElementById('detail-meta').innerText = buildDetailMeta(state.activeTranscription);

      await fetchProjects();
      await fetchTranscriptions();
    } else {
      uiToast('Erro ao atualizar projeto da transcrição.');
    }
  } catch (e) {
    uiToast('Erro ao salvar projeto: ' + e.message);
  }
}

async function fetchTranscriptions() {
  try {
    let url = '/api/transcriptions';
    const params = [];
    if (state.currentProjectId) params.push(`project_id=${state.currentProjectId}`);
    if (state.currentUser?.role === 'admin') params.push('all=true');
    if (params.length) url += '?' + params.join('&');
    const res = await fetch(url, {
      headers: { 'Authorization': `Bearer ${state.token}` }
    });
    const data = await res.json();
    const list = Array.isArray(data) ? data : [];

    // Anti-travamento (T-29 hotfix): o polling re-renderizava a tabela inteira
    // a cada 3s + lucide.createIcons() no documento — com muitos arquivos isso
    // congelava a thread principal no meio de um arrasto de scroll e a lista
    // parecia "sumir". Se nada mudou (status/stage/progress/nomes), não renderiza.
    const signature = list.map(t =>
      `${t.id}:${t.status}:${t.stage || ''}:${t.progress || 0}:${t.file_name}:${t.project_id || ''}`
    ).join('|');
    if (signature === state.transcriptionsSignature) {
      state.transcriptions = list;
      return;
    }
    state.transcriptionsSignature = signature;
    state.transcriptions = list;
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
  // T-29 F2: átomos Obsidian Wave (tier-* e chip-status, ver tokens.css)
  function buildModeBadge(item) {
    if (item.mode === 'base' || item.mode === 'openai/whisper-1') {
      return `<span class="badge-tier tier-fast" title="Modelo: openai/whisper-1">
        <i data-lucide="zap" class="w-3.5 h-3.5"></i><span>Base</span>
      </span>`;
    } else if (item.mode === 'pro' || item.mode === 'openai/whisper-large-v3-turbo') {
      return `<span class="badge-tier tier-pro" title="Modelo: openai/whisper-large-v3-turbo">
        <i data-lucide="gauge" class="w-3.5 h-3.5"></i><span>Pro</span>
      </span>`;
    }
    return `<span class="badge-tier tier-max" title="Modelo: openai/whisper-large-v3">
      <i data-lucide="award" class="w-3.5 h-3.5"></i><span>Max</span>
    </span>`;
  }

  function buildStatusBadge(item) {
    const progress = item.progress || 0;
    if (item.status === 'completed') {
      return `
        <span class="chip-status chip-done">
          <i data-lucide="check-circle-2" class="w-3.5 h-3.5"></i>
          <span>Concluído</span>
        </span>`;
    } else if (item.status === 'completed_with_errors') {
      return `
        <div class="flex flex-col items-start space-y-1">
          <span title="${escapeHtml(item.error_message || '')}" class="chip-status chip-warn cursor-help">
            <i data-lucide="alert-triangle" class="w-3.5 h-3.5"></i>
            <span>Com falhas</span>
          </span>
          <button onclick="retryTranscription('${item.id}')" class="chip-action">Reprocessar blocos</button>
        </div>`;
    } else if (item.status === 'processing') {
      const stageLabel = {
        preprocessing: 'Normalizando', splitting: 'Fatiando', transcribing: 'Transcrevendo',
        assembling: 'Montando', analyzing: 'Resumindo'
      }[item.stage] || 'Processando';
      return `
        <div class="flex flex-col items-start space-y-1 min-w-[80px]">
          <span class="chip-status chip-processing">
            <span class="dot"></span>
            <span>${stageLabel}</span>
          </span>
          <div class="w-full bg-brand-line dark:bg-brand-line rounded-full h-1.5 overflow-hidden">
            <div class="bg-wave-amber h-1.5 rounded-full transition-all duration-700" style="width: ${progress}%"></div>
          </div>
          <span class="text-[10px] text-brand-muted dark:text-brand-muted font-mono font-bold">${progress}%</span>
        </div>`;
    } else if (item.status === 'pending') {
      const posLabel = item.queue_position ? `<span class="text-[10px] font-bold" style="color: inherit"> ${item.queue_position}º na fila</span>` : '';
      return `
        <div class="flex flex-col items-start space-y-1">
          <span class="chip-status chip-queued">
            <span class="dot"></span>
            <span>Na Fila</span>${posLabel}
          </span>
          <div class="w-full bg-brand-line dark:bg-brand-line rounded-full h-1.5 overflow-hidden">
            <div class="bg-wave-amber h-1.5 rounded-full animate-pulse" style="width: 8%"></div>
          </div>
        </div>`;
    } else if (item.status === 'failed') {
      return `
        <div class="flex flex-col items-start space-y-1">
          <span title="${escapeHtml(item.error_message || 'Erro desconhecido')}" class="chip-status chip-failed cursor-help">
            <i data-lucide="alert-circle" class="w-3.5 h-3.5"></i>
            <span>Falhou</span>
          </span>
          <button onclick="retryTranscription('${item.id}')" class="chip-action">Tentar de novo</button>
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
    uiToast('Erro ao reprocessar: ' + e.message); // T-14 troca uiToast() por modal proprio
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
    loadLatestEnhancement(data.id);

    const filenameText = document.getElementById('detail-filename-text');
    if (filenameText) filenameText.innerText = data.file_name;

    document.getElementById('detail-meta').innerText = buildDetailMeta(data);
    syncNerdToggle();

    // Configurar áudio player — T-13: player passa a usar a rota autenticada
    // dedicada (Range/seek suportado), não mais a URL direta de /uploads.
    const audioPlayer = document.getElementById('audio-player');
    if (audioPlayer) {
      audioPlayer.src = `/api/transcriptions/${data.id}/audio?token=` + encodeURIComponent(state.token);
    }
    // T-29 F3: waveform + player persistente ganham os dados desta transcrição
    setupPlayer(data);

    // T-13: rótulo do botão de download com o tamanho do arquivo ("Áudio original · 4,4 MB").
    const audioLabel = document.getElementById('download-audio-label');
    if (audioLabel) {
      const mb = (data.file_size || 0) / (1024 * 1024);
      audioLabel.innerText = mb >= 1
        ? `Áudio original · ${mb.toLocaleString('pt-BR', { maximumFractionDigits: 1 })} MB`
        : 'Áudio original';
    }

    // Atualizar seletor de projeto na barra lateral de detalhes
    const detailSelect = document.getElementById('detail-project-select');
    if (detailSelect) {
      detailSelect.value = data.project_id || "";
    }

    renderCurrentTranscript();
    showView('details');
    // Mobile: abrir um arquivo tem que mostrar o topo — nome, player e o
    // início da transcrição. Antes a view abria na posição de scroll anterior
    // e, com o painel de ações antes do miolo, o usuário via só "PROJETO /
    // EXPORTAR" e achava que a tela tinha ficado em branco.
    const view = document.getElementById('view-details');
    if (view) view.scrollTo({ top: 0, behavior: 'auto' });
  } catch (e) {
    uiToast('Erro ao carregar detalhes: ' + e.message);
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
    uiToast('Erro ao salvar novo nome: ' + e.message);
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

// T-34: pesquisa vira ícone no mobile; o campo abre como painel flutuante
// grudado no topo (toolbar-sticky) para as setas acompanharem a navegação.
function toggleSearchBox(e) {
  if (e) e.stopPropagation();
  const box = document.getElementById('search-box');
  const toolbar = document.getElementById('reading-toolbar');
  if (!box) return;
  const opening = !box.classList.contains('search-open');
  box.classList.toggle('search-open');
  if (toolbar) toolbar.classList.toggle('toolbar-sticky', opening);
  if (opening) {
    const input = document.getElementById('transcript-search');
    if (input) setTimeout(() => input.focus(), 50);
  }
}

// Fecha os painéis flutuantes ao clicar fora ou apertar Esc
document.addEventListener('click', (e) => {
  const sb = document.getElementById('search-box');
  if (sb && sb.classList.contains('search-open') &&
      !e.target.closest('#search-box') && !e.target.closest('#search-toggle')) {
    const input = document.getElementById('transcript-search');
    if (!input || !input.value) {
      sb.classList.remove('search-open');
      document.getElementById('reading-toolbar')?.classList.remove('toolbar-sticky');
    }
  }
});
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  const sb = document.getElementById('search-box');
  if (sb) {
    sb.classList.remove('search-open');
    document.getElementById('reading-toolbar')?.classList.remove('toolbar-sticky');
    const input = document.getElementById('transcript-search');
    if (input && !input.value) onTranscriptSearch('');
  }
});

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

  // Toda re-renderização invalida os destaques de pesquisa.
  clearSearchHits();
  // Toda re-renderização invalida o índice karaoke (palavras-tempo do modo Leitura)
  resetKaraoke();

  applyReadingPreferences();

  // T-29 F3: aba de modo ativa com elevação (átomo .mode-tab-active)
  ['transcript', 'reading', 'summary'].forEach(m => {
    const btn = document.getElementById('btn-mode-' + m);
    if (btn) btn.classList.toggle('mode-tab-active', state.readingMode === m);
  });

  const saveButton = document.getElementById('save-transcript-button');
  if (saveButton) {
    saveButton.disabled = state.readingMode !== 'transcript';
    saveButton.classList.toggle('hidden', state.readingMode !== 'transcript');
  }

  const segments = state.activeTranscription.segments || [];
  // HOTFIX 2026-09-28 (ampliado): o toggle controla tempos E locutores.
  // Desmarcado → texto contínuo, só com quebras de linha (default: marcado).
  const showMeta = document.getElementById('toggle-timestamps')?.checked ?? true;

  // MODO RESUMO IA — apresenta o aprimoramento em largura de leitura confortável
  if (state.readingMode === 'summary') {
    container.contentEditable = "false";
    const enh = state.latestEnhancement;
    if (enh && enh.result_md) {
      // Nerd mode: model+tokens+juiz só aparecem com "Dados técnicos" ligado
      const meta = state.nerdMode
        ? `${enh.model} • ${(enh.tokens_in || 0) + (enh.tokens_out || 0)} tokens${judgeMetaSuffix(enh)}`
        : '';
      container.innerHTML = `
        <div class="mb-5 pb-3 border-b border-brand-line/60 dark:border-brand-line/60 flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
          <span class="text-xs font-bold uppercase tracking-wide text-violet-700 dark:text-violet-300">Texto aprimorado</span>
          ${meta ? `<span class="text-[11px] text-brand-muted dark:text-brand-muted">${escapeHtml(meta)}</span>` : ''}
        </div>
        ${renderMarkdown(enh.result_md)}
      `;
    } else if (state.activeTranscription.ai_summary) {
      container.innerHTML = renderMarkdown(state.activeTranscription.ai_summary);
    } else {
      container.innerHTML = `
        <div class="text-center py-10">
          <i data-lucide="wand-2" class="w-8 h-8 mx-auto mb-3 text-violet-400 dark:text-violet-500"></i>
          <p class="text-brand-muted dark:text-brand-muted text-sm leading-relaxed">Nenhum aprimoramento ainda.<br>Use <strong class="text-violet-700 dark:text-violet-300">Aprimorar com IA</strong> no painel lateral — o resultado corrigido e estruturado aparece aqui.</p>
        </div>
      `;
    }
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
      const color = getSpeakerColor(firstSeg.speaker);

      return `
        <div class="cc-para mb-6 p-4 rounded-xl bg-brand-canvas/80 dark:bg-brand-canvas/80 border border-brand-line/60 dark:border-brand-line/60 hover:border-brand-line dark:hover:border-brand-line transition">
          ${showMeta ? `
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
          ` : ''}
          <p class="leading-relaxed text-brand-ink dark:text-brand-ink">${buildKaraokeHtml(group)}</p>
        </div>
      `;
    }).join('');
    // Karaoke: indexa as palavras com seus tempos para o highlight em play
    buildKaraokeIndex(container);
    return;
  }

  // MODO TRANSCRIÇÃO (Padrão: Segmento por Segmento com edições habilitadas)
  container.contentEditable = "false";

  if (segments.length === 0) {
    container.innerHTML = `<p data-transcript-text contenteditable="plaintext-only" class="leading-relaxed text-brand-ink dark:text-brand-ink whitespace-pre-wrap">${escapeHtml(state.activeTranscription.raw_text || '')}</p>`;
    return;
  }

  // Toggle desmarcado: texto contínuo — parágrafos unidos por locutor, sem
  // tempos nem chips. Quebra de linha a cada troca de locutor.
  if (!showMeta) {
    const groups = [];
    for (const seg of segments) {
      const last = groups[groups.length - 1];
      if (seg.speaker && last && last.speaker === seg.speaker) last.texts.push(seg.text);
      else groups.push({ speaker: seg.speaker || null, texts: [seg.text] });
    }
    container.innerHTML = groups.map(g =>
      `<p class="mb-4 leading-relaxed text-brand-ink dark:text-brand-ink">${escapeHtml(g.texts.join(' ').trim())}</p>`
    ).join('');
    return;
  }

  // T-29 F3: blocos de fala (cards) — chip de tempo ciano + chip de locutor
  // dinâmico; o bloco inteiro acende enquanto o áudio passa por ele.
  container.innerHTML = segments.map(seg => {
    const color = getSpeakerColor(seg.speaker);
    return `
      <div class="speech-block" data-seg-start="${seg.start_time}" data-seg-end="${seg.end_time}">
        <div class="flex items-center gap-2 mb-1.5 flex-wrap">
          <button onclick="seekAudio(${seg.start_time})" class="time-chip" title="Ir para ${formatSRTTimeShort(seg.start_time)}">
            [${formatSRTTimeShort(seg.start_time)}]
          </button>
          ${seg.speaker ? `<span class="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold ${color.bg} ${color.text} ${color.border} border">${escapeHtml(seg.speaker)}</span>` : ''}
        </div>
        <p data-segment-id="${escapeHtml(seg.id)}" contenteditable="plaintext-only" role="textbox" aria-label="Texto do segmento" class="text-brand-ink dark:text-brand-ink leading-relaxed whitespace-pre-wrap">${escapeHtml(seg.text)}</p>
      </div>
    `;
  }).join('');
  if (window.lucide) lucide.createIcons();
}

function copyTranscriptAsMarkdown() {
  if (!state.activeTranscription) return;
  const t = state.activeTranscription;
  const segments = t.segments || [];

  let md = `# ${t.file_name || 'Transcrição'}\n`;
  md += `**Data:** ${new Date(t.created_at).toLocaleString('pt-BR')} | **Duração:** ${Math.round(t.duration_seconds || 0)}s\n\n`;

  if (state.readingMode === 'summary' && state.latestEnhancement?.result_md) {
    md += `## Texto Aprimorado (${state.latestEnhancement.model})\n\n${state.latestEnhancement.result_md}\n`;
  } else if (state.readingMode === 'summary' && t.ai_summary) {
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
    const btn = document.getElementById('btn-copy-md');
    if (!btn) return;
    const original = btn.dataset.originalLabel || btn.innerText;
    btn.dataset.originalLabel = original;
    btn.innerText = 'Copiado!';
    setTimeout(() => { btn.innerText = original; }, 2000);
  }).catch(err => {
    console.error('Erro ao copiar Markdown:', err);
  });
}

// ---------------------------------------------------
// HOTFIX 2026-09-28: PESQUISA NO TEXTO (barra da toolbar central)
// Destaca ocorrências com <mark>, conta e navega entre elas. Re-render
// limpa os destaques (renderCurrentTranscript chama clearSearchHits).
// ---------------------------------------------------
let searchHits = [];
let searchCursor = -1;

function clearSearchHits() {
  const container = document.getElementById('transcript-content');
  if (container) {
    container.querySelectorAll('mark.search-hit').forEach(mark => {
      const parent = mark.parentNode;
      while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
      parent.removeChild(mark);
      parent.normalize();
    });
  }
  searchHits = [];
  searchCursor = -1;
  const count = document.getElementById('search-count');
  if (count) count.innerText = '';
}

function onTranscriptSearch(rawQuery) {
  const container = document.getElementById('transcript-content');
  const count = document.getElementById('search-count');
  if (!container) return;
  clearSearchHits();
  const query = (rawQuery || '').trim();
  if (query.length < 2) { if (count) count.innerText = ''; return; }

  const lower = query.toLowerCase();
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.nodeValue || node.nodeValue.trim() === '') return NodeFilter.FILTER_REJECT;
      const parent = node.parentElement;
      if (!parent || parent.closest('mark.search-hit') || parent.closest('script,style')) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    }
  });
  const textNodes = [];
  while (walker.nextNode()) textNodes.push(walker.currentNode);

  for (const node of textNodes) {
    const value = node.nodeValue;
    const lowerValue = value.toLowerCase();
    let idx = lowerValue.indexOf(lower);
    if (idx === -1) continue;
    const frag = document.createDocumentFragment();
    let last = 0;
    while (idx !== -1) {
      frag.appendChild(document.createTextNode(value.slice(last, idx)));
      const mark = document.createElement('mark');
      mark.className = 'search-hit bg-amber-200 text-amber-900 rounded px-0.5 dark:bg-amber-500/40 dark:text-amber-100';
      mark.textContent = value.slice(idx, idx + query.length);
      frag.appendChild(mark);
      searchHits.push(mark);
      last = idx + query.length;
      idx = lowerValue.indexOf(lower, last);
    }
    frag.appendChild(document.createTextNode(value.slice(last)));
    node.parentNode.replaceChild(frag, node);
  }

  if (count) count.innerText = searchHits.length > 0 ? `${searchHits.length}` : '0';
  if (searchHits.length > 0) stepSearchHit(1, true);
}

function stepSearchHit(dir, silent = false) {
  if (searchHits.length === 0) return;
  searchCursor = (searchCursor + dir + searchHits.length) % searchHits.length;
  searchHits.forEach((h, i) => {
    h.classList.toggle('ring-2', i === searchCursor);
    h.classList.toggle('ring-blue-500', i === searchCursor);
    h.classList.toggle('rounded-sm', i === searchCursor);
  });
  // T-34 mobile: com a busca expandida, a tela acompanha cada ocorrência —
  // alinha o hit logo abaixo da toolbar sticky (que fica grudada no topo) e
  // devolve o foco ao campo para o teclado não sumir ao tocar nas setas.
  const hit = searchHits[searchCursor];
  const mobileSearchOpen = document.getElementById('search-box')?.classList.contains('search-open');
  if (mobileSearchOpen) {
    const toolbar = document.getElementById('reading-toolbar');
    const offset = toolbar ? toolbar.offsetHeight + 12 : 72;
    hit.style.scrollMarginTop = `${offset}px`;
    hit.scrollIntoView({ behavior: silent ? 'auto' : 'smooth', block: 'start' });
    const input = document.getElementById('transcript-search');
    if (input) input.focus({ preventScroll: true });
  } else {
    hit.scrollIntoView({ behavior: silent ? 'auto' : 'smooth', block: 'center' });
  }
  const count = document.getElementById('search-count');
  if (count) count.innerText = `${searchCursor + 1}/${searchHits.length}`;
}

// Ao editar um segmento, remove os destaques daquele bloco (evita <mark> quebrado)
document.addEventListener('input', (e) => {
  const seg = e.target.closest?.('[data-segment-id]');
  if (seg) seg.querySelectorAll('mark.search-hit').forEach(mark => {
    const parent = mark.parentNode;
    while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
    parent.removeChild(mark);
    parent.normalize();
  });
});

// ---------------------------------------------------
// PLAYER PERSISTENTE — T-29 F3 (Obsidian Wave)
// Waveform em canvas (sem dados de amplitude reais: a densidade de caracteres
// por segundo de cada segmento vira a altura da barra — forma estável, sem
// custo de processamento). Progresso via rAF; clique no canvas busca o trecho.
// ---------------------------------------------------
let waveformPeaks = [];
let waveformRaf = null;
let playerWired = false;

function computeWaveformPeaks(segments) {
  if (segments && segments.length) {
    return segments.map(s => {
      const dur = Math.max(0.5, (s.end_time || 0) - (s.start_time || 0));
      const density = (s.text || '').length / dur;
      return Math.max(0.15, Math.min(1, density / 12));
    });
  }
  // Sem segmentos: pseudo-forma estável (mesmo seed, mesma forma)
  const n = 48; const peaks = []; let seed = 7;
  for (let i = 0; i < n; i++) { seed = (seed * 9301 + 49297) % 233280; peaks.push(0.2 + (seed / 233280) * 0.8); }
  return peaks;
}

function drawWaveform(progressRatio) {
  const canvas = document.getElementById('waveform-canvas');
  if (!canvas || !waveformPeaks.length) return;
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (!w || !h) return;
  if (canvas.width !== Math.round(w * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const barW = 3, gap = 2, step = barW + gap;
  const n = Math.max(1, Math.floor(w / step));
  const played = Math.round((progressRatio || 0) * n);
  const mid = h / 2;
  const isDark = document.documentElement.classList.contains('dark');
  const playedColor = isDark ? '#00F2FE' : '#00A6B0';
  const restColor = isDark ? 'rgba(255,255,255,0.14)' : 'rgba(16,21,31,0.15)';
  ctx.fillStyle = restColor;
  for (let i = 0; i < n; i++) {
    const peak = waveformPeaks[Math.floor(i * waveformPeaks.length / n)] || 0.3;
    const bh = Math.max(3, peak * (h - 6));
    ctx.fillStyle = i < played ? playedColor : restColor;
    const x = i * step;
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(x, mid - bh / 2, barW, bh, 1.5);
    else ctx.rect(x, mid - bh / 2, barW, bh);
    ctx.fill();
  }
}

function updatePlayerTime() {
  const audio = document.getElementById('audio-player');
  const el = document.getElementById('player-time');
  if (!audio || !el) return;
  const fmt = (s) => {
    if (!isFinite(s) || s < 0) s = 0;
    return `${Math.floor(s / 60)}:${Math.floor(s % 60).toString().padStart(2, '0')}`;
  };
  el.textContent = `${fmt(audio.currentTime)} / ${fmt(audio.duration)}`;
}

function updatePlayIcon() {
  const audio = document.getElementById('audio-player');
  const icon = document.getElementById('icon-play-pause');
  if (!audio || !icon) return;
  icon.setAttribute('data-lucide', audio.paused ? 'play' : 'pause');
  if (window.lucide) lucide.createIcons();
}

function highlightActiveSegment(t) {
  const blocks = document.querySelectorAll('#transcript-content .speech-block');
  if (!blocks.length) return;
  let active = null;
  for (const b of blocks) {
    const start = parseFloat(b.dataset.segStart || '0');
    if (start <= t) active = b; else break;
  }
  blocks.forEach(b => b.classList.toggle('seg-active', b === active && t > 0));
}

// ---------------------------------------------------
// KARAOKE / CLOSED CAPTIONS — modo Leitura
// Cada palavra vira um span com tempo interpolado dentro do segmento
// (start→end distribuído igualmente entre as palavras — sem custo de API;
// o Whisper não devolve tempo por palavra). Em play, a palavra corrente ganha
// fundo no acento (.cc-on) e o parágrafo ativo acende e rola para o centro.
// ---------------------------------------------------
let ccWords = [];        // [{ s: number, el: HTMLElement }] em ordem cronológica
let ccLastWordEl = null; // span atualmente aceso
let ccActivePara = null; // parágrafo .cc-para atualmente ativo

function resetKaraoke() {
  ccWords = [];
  ccLastWordEl = null;
  ccActivePara = null;
}

function buildKaraokeHtml(group) {
  return group.map(seg => {
    // Tempos reais por palavra (Whisper timestamp_granularities[]=word) quando
    // existem; sem eles, interpolação ponderada pelo tamanho da palavra
    // (palavras longas falam mais devagar) dentro do segmento.
    let timed = null;
    try {
      const raw = typeof seg.words_json === 'string' ? JSON.parse(seg.words_json || 'null') : seg.words;
      if (Array.isArray(raw) && raw.length) timed = raw;
    } catch (_) { /* fallback abaixo */ }
    if (timed) {
      return timed.map(w => {
        const ws = parseFloat(w.s) || 0;
        const we = parseFloat(w.e) || ws;
        const clean = String(w.w || '').trim();
        if (!clean) return '';
        return `<span class="cc-word" data-ws="${ws.toFixed(3)}" data-we="${we.toFixed(3)}">${escapeHtml(clean)}</span>`;
      }).filter(Boolean).join(' ');
    }

    const words = (seg.text || '').trim().split(/\s+/).filter(Boolean);
    if (!words.length) return '';
    const start = parseFloat(seg.start_time) || 0;
    const end = parseFloat(seg.end_time) || 0;
    const dur = Math.max(0.2, end - start);
    // Peso = caracteres + 2 (mínimo para monossílabos não virarem estalos)
    const weights = words.map(w => w.length + 2);
    const totalW = weights.reduce((a, b) => a + b, 0);
    let acc = 0;
    return words.map((w, i) => {
      const ws = start + dur * (acc / totalW);
      acc += weights[i];
      const we = start + dur * (acc / totalW);
      return `<span class="cc-word" data-ws="${ws.toFixed(3)}" data-we="${we.toFixed(3)}">${escapeHtml(w)}</span>`;
    }).join(' ');
  }).join(' ');
}

function buildKaraokeIndex(container) {
  ccWords = [];
  ccLastWordEl = null;
  ccActivePara = null;
  const spans = container.querySelectorAll('.cc-word');
  spans.forEach(el => ccWords.push({ s: parseFloat(el.dataset.ws) || 0, el }));
}

function updateKaraoke(t, allowScroll) {
  if (!ccWords.length) return;
  // Busca binária: última palavra com início <= t
  let lo = 0, hi = ccWords.length - 1, idx = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (ccWords[mid].s <= t) { idx = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  const el = idx >= 0 ? ccWords[idx].el : null;
  if (el === ccLastWordEl) return;
  if (ccLastWordEl) ccLastWordEl.classList.remove('cc-on');
  ccLastWordEl = el;
  if (!el) return;
  el.classList.add('cc-on');
  const para = el.closest('.cc-para');
  if (para && para !== ccActivePara) {
    if (ccActivePara) ccActivePara.classList.remove('cc-block-active');
    ccActivePara = para;
    para.classList.add('cc-block-active');
    // Acompanha com os olhos: rola suave só enquanto toca (seek não rola)
    if (allowScroll) para.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
}

function startWaveformLoop() {
  cancelAnimationFrame(waveformRaf);
  const tick = () => {
    const audio = document.getElementById('audio-player');
    if (audio && audio.duration) {
      drawWaveform(audio.currentTime / audio.duration);
      updatePlayerTime();
      highlightActiveSegment(audio.currentTime);
      updateKaraoke(audio.currentTime, true); // karaoke segue o play (com auto-scroll)
    }
    if (audio && !audio.paused && !audio.ended) waveformRaf = requestAnimationFrame(tick);
  };
  waveformRaf = requestAnimationFrame(tick);
}

function setupPlayer(data) {
  const audio = document.getElementById('audio-player');
  if (!audio) return;
  waveformPeaks = computeWaveformPeaks(data.segments);
  drawWaveform(0);
  updatePlayerTime();
  updatePlayIcon();
  const rate = document.getElementById('playback-rate');
  if (rate) audio.playbackRate = parseFloat(rate.value) || 1;
  if (playerWired) return;
  playerWired = true;
  audio.addEventListener('loadedmetadata', () => { updatePlayerTime(); drawWaveform(0); });
  audio.addEventListener('play', () => { updatePlayIcon(); startWaveformLoop(); });
  audio.addEventListener('pause', () => { updatePlayIcon(); cancelAnimationFrame(waveformRaf); updateKaraoke(audio.currentTime, false); });
  audio.addEventListener('ended', () => { updatePlayIcon(); cancelAnimationFrame(waveformRaf); drawWaveform(1); highlightActiveSegment(0); updateKaraoke(0, false); });
  const canvas = document.getElementById('waveform-canvas');
  if (canvas) canvas.addEventListener('click', (e) => {
    if (!audio.duration) return;
    const rect = canvas.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    audio.currentTime = ratio * audio.duration;
    drawWaveform(ratio);
    updatePlayerTime();
    highlightActiveSegment(audio.currentTime);
    updateKaraoke(audio.currentTime, false); // seek: move o grifo sem rolar a tela
  });
  window.addEventListener('resize', () => {
    const a = document.getElementById('audio-player');
    drawWaveform(a && a.duration ? a.currentTime / a.duration : 0);
  });
}

function togglePlay() {
  const audio = document.getElementById('audio-player');
  if (!audio) return;
  if (audio.paused) audio.play().catch(() => {});
  else audio.pause();
}

function skipAudio(seconds) {
  const audio = document.getElementById('audio-player');
  if (!audio || !isFinite(audio.duration)) return;
  audio.currentTime = Math.min(audio.duration, Math.max(0, audio.currentTime + seconds));
  drawWaveform(audio.currentTime / audio.duration);
  updatePlayerTime();
  highlightActiveSegment(audio.currentTime);
  updateKaraoke(audio.currentTime, false);
}

function setPlaybackRate(v) {
  const audio = document.getElementById('audio-player');
  if (audio) audio.playbackRate = parseFloat(v) || 1;
}

function seekAudio(seconds) {
  const audio = document.getElementById('audio-player');
  if (audio) {
    audio.currentTime = seconds;
    drawWaveform(isFinite(audio.duration) && audio.duration ? seconds / audio.duration : 0);
    highlightActiveSegment(seconds);
    updateKaraoke(seconds, true); // clique no tempo: grifa E rola até o parágrafo
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
    uiToast('Transcricao salva com sucesso.');
  } catch (error) {
    uiToast('Erro ao salvar edicoes: ' + error.message);
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
    uiToast('Erro ao excluir: ' + e.message);
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
  const urlInput = document.getElementById('transcribe-url');
  const linkValue = urlInput ? urlInput.value.trim() : '';

  // T-11: link preenchido tem prioridade — vai para /api/transcribe/url (JSON).
  if (linkValue) {
    await submitUrlTranscription(linkValue);
    return;
  }

  if (state.selectedFiles.length === 0) {
    uiToast('Por favor, selecione ao menos um arquivo de áudio ou vídeo.');
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
      uiToast('Erro ao enviar para a fila: ' + (data.error || 'Desconhecido'));
      btn.disabled = false;
      btn.innerText = 'TRANSCREVER';
    }
  } catch (e) {
    uiToast('Erro ao enviar áudio: ' + e.message);
    btn.disabled = false;
    btn.innerText = 'TRANSCREVER';
  }
}

// T-11: envia um link (YouTube/Vimeo/URL direta) para /api/transcribe/url.
// Falha de download volta como linha 'failed' com error_message específico —
// mostramos o erro e atualizamos a lista em vez de abrir o painel de progresso.
async function submitUrlTranscription(linkValue) {
  const btn = document.getElementById('btn-submit-transcribe');
  btn.disabled = true;
  btn.innerText = 'BAIXANDO E ENVIANDO...';

  const select = document.getElementById('openrouter-model-select');
  const payload = {
    url: linkValue,
    language: document.getElementById('transcribe-language').value,
    mode: state.selectedMode,
    model_id: select ? select.value : state.selectedModelId
  };
  const projectSelect = document.getElementById('transcribe-project-select');
  if (projectSelect && projectSelect.value) payload.project_id = projectSelect.value;
  if (document.getElementById('diarization-check').checked) payload.speaker_diarization = true;
  const aiFocusInput = document.getElementById('ai-focus-input');
  if (aiFocusInput && aiFocusInput.value.trim()) payload.ai_focus = aiFocusInput.value.trim();

  try {
    const res = await fetch('/api/transcribe/url', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${state.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    const item = data.data && data.data[0];

    if (res.status === 429) {
      uiToast(data.error || 'Limite diário atingido.');
      closeTranscribeModal();
      return;
    }
    if (item && item.status === 'failed') {
      uiToast('Não foi possível transcrever o link: ' + (item.error_message || 'erro desconhecido'));
      closeTranscribeModal();
      await fetchTranscriptions();
      return;
    }
    if (data.success && item) {
      showTranscriptionProgressPanel(item.id, item.file_name || linkValue);
      await fetchTranscriptions();
    } else {
      uiToast('Erro ao enviar o link: ' + (data.error || 'Desconhecido'));
      btn.disabled = false;
      btn.innerText = 'TRANSCREVER';
    }
  } catch (e) {
    uiToast('Erro ao enviar o link: ' + e.message);
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
      if (s.status === 'pending') {
        return s.queue_position
          ? `⏳ ${s.queue_position}º na fila, aguardando o worker...`
          : '⏳ Na fila, aguardando o worker...';
      }
      return 'Processando...';
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
    uiToast('Erro ao acessar microfone: ' + err.message);
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
    uiToast('Erro ao transcrever gravação: ' + e.message);
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
      uiToast(`Autenticado com sucesso como: ${data.user.name} (${data.user.role})`);
    } else {
      uiToast('Erro no login: ' + (data.error || 'Credenciais inválidas'));
    }
  } catch (err) {
    uiToast('Erro no servidor de autenticação: ' + err.message);
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
        prompt: prompt,
        transcription_id: state.activeTranscription.id
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
    uiToast('Erro no ChatGPT: ' + err.message);
  }
}

function openTranslateModal() {
  uiPrompt('Traduzir para qual idioma? (ex: English, Español, Français, Deutsch)', 'English', async (targetLang) => {
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
          target_language: targetLang,
          transcription_id: state.activeTranscription.id
        })
      });
      const data = await res.json();
      uiToast(`Tradução para ${targetLang}:\n\n` + data.translatedText, 'info');
    } catch (e) {
      uiToast('Erro ao traduzir: ' + e.message, 'error');
    }
  });
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
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    document.getElementById('metric-users').innerText = data.users_total ?? '—';
    document.getElementById('metric-hours').innerText = (data.hours_transcribed ?? '—') + 'h';
    document.getElementById('metric-storage').innerText = (data.storage_used_mb ?? '—') + ' MB';
    document.getElementById('metric-apikeys').innerText = data.active_api_keys ?? '—';
  } catch (e) {
    console.error('Erro ao carregar métricas:', e);
  }
}

async function loadAdminUsers() {
  try {
    const res = await fetch('/api/admin/users', {
      headers: { 'Authorization': `Bearer ${state.token}` }
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
    const users = await res.json();
    const tbody = document.getElementById('admin-users-tbody');
    tbody.innerHTML = users.map(u => {
      const isSelf = u.id === state.currentUser.id;
      const actionBtn = (onclick, label, color) =>
        `<button onclick="${onclick}" ${isSelf ? 'disabled title="Esta é a sua conta"' : ''} class="${isSelf ? 'opacity-30 cursor-not-allowed' : 'hover:underline'} inline-flex items-center min-h-[44px] text-${color}-600 dark:text-${color}-300 font-semibold text-xs">${label}</button>`;
      const actions = isSelf
        ? '<span class="text-brand-muted dark:text-brand-muted text-[10px]">Sua conta</span>'
        : [
            actionBtn(`changeUserRole('${u.id}', '${u.role === 'admin' ? 'user' : 'admin'}')`, u.role === 'admin' ? 'Tornar usuário' : 'Tornar admin', u.role === 'admin' ? 'slate' : 'purple'),
            actionBtn(`resetUserPassword('${u.id}', '${u.email.replace(/'/g, '')}')`, 'Resetar senha', 'amber'),
            actionBtn(`toggleUserStatus('${u.id}', '${u.status === 'active' ? 'suspended' : 'active'}')`, u.status === 'active' ? 'Suspender' : 'Ativar', 'blue')
          ].join('<span class="text-brand-line dark:text-brand-line mx-1">|</span>');
      return `
      <tr class="hover:bg-brand-canvas dark:hover:bg-brand-canvas">
        <td class="p-4 font-bold text-brand-ink dark:text-brand-ink">${escapeHtml(u.name)}</td>
        <td class="p-4 text-brand-copy dark:text-brand-copy">${escapeHtml(u.email)}</td>
        <td class="p-4"><span class="px-2 py-0.5 text-[10px] font-bold rounded ${u.role === 'admin' ? 'bg-purple-100 dark:bg-purple-950 text-purple-800 dark:text-purple-300' : 'bg-brand-raised dark:bg-brand-raised text-brand-copy dark:text-brand-copy'}">${u.role}</span></td>
        <td class="p-4 text-brand-copy dark:text-brand-copy font-semibold">
          <span class="inline-flex items-center gap-1.5" title="Limite de transcrições por 24 h (999999 = ilimitado)">
            <input type="number" min="0" step="1" value="${u.daily_limit}" ${isSelf ? 'disabled' : ''}
              onchange="updateUserDailyLimit('${u.id}', this.value)"
              class="w-20 bg-brand-surface dark:bg-brand-surface border border-brand-line dark:border-brand-line text-brand-ink dark:text-brand-ink rounded-lg px-2 py-1 text-xs font-mono ${isSelf ? 'opacity-40 cursor-not-allowed' : ''}">
            <span class="text-[10px] text-brand-muted dark:text-brand-muted">/24h</span>
          </span>
        </td>
        <td class="p-4"><span class="px-2 py-0.5 text-[10px] font-bold rounded ${u.status === 'active' ? 'bg-emerald-100 dark:bg-emerald-950 text-emerald-800 dark:text-emerald-300' : 'bg-red-100 dark:bg-red-950 text-red-800 dark:text-red-300'}">${u.status}</span></td>
        <td class="p-4 text-right whitespace-nowrap">${actions}</td>
      </tr>`;
    }).join('');
  } catch (e) {
    console.error('Erro ao carregar usuários:', e);
  }
}

async function adminUserAction(url, method, body) {
  const res = await fetch(url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${state.token}`
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

async function toggleUserStatus(userId, newStatus) {
  try {
    await adminUserAction(`/api/admin/users/${userId}`, 'PUT', { status: newStatus });
    loadAdminUsers();
  } catch (e) {
    uiToast('Erro ao atualizar usuário: ' + e.message);
  }
}

async function changeUserRole(userId, newRole) {
  try {
    await adminUserAction(`/api/admin/users/${userId}`, 'PUT', { role: newRole });
    loadAdminUsers();
  } catch (e) {
    uiToast('Erro ao alterar função: ' + e.message);
  }
}

// T-07: cota diária editável inline na tabela de usuários
async function updateUserDailyLimit(userId, value) {
  const limit = parseInt(value, 10);
  if (!Number.isInteger(limit) || limit < 0) {
    uiToast('Limite diário inválido.');
    loadAdminUsers();
    return;
  }
  try {
    await adminUserAction(`/api/admin/users/${userId}`, 'PUT', { daily_limit: limit });
    loadAdminUsers();
  } catch (e) {
    uiToast('Erro ao atualizar limite: ' + e.message);
    loadAdminUsers();
  }
}

function resetUserPassword(userId, email) {
  uiPrompt(`Nova senha para ${email} (mín. 6 caracteres):`, '', async (password) => {
    if (!password) return;
    try {
      await adminUserAction(`/api/admin/users/${userId}`, 'PUT', { password });
      uiToast('Senha redefinida com sucesso.', 'success');
    } catch (e) {
      uiToast('Erro ao redefinir senha: ' + e.message, 'error');
    }
  });
}

function openCreateUserModal() {
  document.getElementById('create-user-name').value = '';
  document.getElementById('create-user-email').value = '';
  document.getElementById('create-user-password').value = '';
  document.getElementById('create-user-role').value = 'user';
  document.getElementById('create-user-daily-limit').value = 3;
  onCreateUserRoleChange();
  setCreateUserError('');
  document.getElementById('create-user-modal').classList.remove('hidden');
}

function closeCreateUserModal() {
  document.getElementById('create-user-modal').classList.add('hidden');
}

function setCreateUserError(msg) {
  const el = document.getElementById('create-user-error');
  el.textContent = msg;
  el.classList.toggle('hidden', !msg);
}

function onCreateUserRoleChange() {
  const role = document.getElementById('create-user-role').value;
  const limitInput = document.getElementById('create-user-daily-limit');
  limitInput.value = role === 'admin' ? 99999 : 3;
  limitInput.disabled = role === 'admin';
}

async function submitCreateUser(event) {
  event.preventDefault();
  setCreateUserError('');
  const role = document.getElementById('create-user-role').value;
  try {
    await adminUserAction('/api/admin/users', 'POST', {
      name: document.getElementById('create-user-name').value.trim(),
      email: document.getElementById('create-user-email').value.trim(),
      password: document.getElementById('create-user-password').value,
      role,
      daily_limit: parseInt(document.getElementById('create-user-daily-limit').value, 10) || (role === 'admin' ? 99999 : 3)
    });
    closeCreateUserModal();
    loadAdminUsers();
  } catch (e) {
    setCreateUserError(e.message);
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
  dot.className = 'w-2 h-2 rounded-full bg-brand-muted dark:bg-brand-muted';
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
    dot.className = 'w-2 h-2 rounded-full bg-brand-muted dark:bg-brand-muted';
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
    uiToast('Erro ao ativar chave: ' + e.message);
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
    uiToast('Erro ao excluir chave: ' + e.message);
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

    // T-18: análise/aprimoramento IA
    document.getElementById('admin-setting-analysis-model').value = s.analysis_model || 'openai/gpt-4o-mini';
    document.getElementById('admin-setting-analysis-prompt').value = s.analysis_prompt || '';
    // T-25: JEV — juiz de validação (default: ativado)
    document.getElementById('admin-setting-judge-model').value = s.judge_model || 'openai/gpt-4o-mini';
    document.getElementById('admin-setting-judge-enabled').checked = s.judge_enabled !== '0';
    // T-07: limites de uso
    document.getElementById('admin-setting-max-file-size-mb').value = s.max_file_size_mb || '5120';
    document.getElementById('admin-setting-max-duration-hours').value = s.max_duration_hours || '10';
    loadGlossary();
  } catch (e) {
    console.error('Erro ao carregar configurações admin:', e);
  }
}

// ---------------------------------------------------
// T-18: APRIMORAMENTO DE TRANSCRIÇÃO POR IA
// ---------------------------------------------------
async function enhanceTranscription() {
  if (!state.activeTranscription) return;
  const btn = document.getElementById('btn-enhance');
  const label = btn.querySelector('span span');
  const original = label.innerText;
  btn.disabled = true;
  label.innerText = 'Aprimorando... (pode levar 1 min)';
  try {
    const res = await fetch(`/api/transcriptions/${state.activeTranscription.id}/enhance`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${state.token}` }
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Erro desconhecido');
    // Resultado vai para o miolo: aba "Resumo IA" em largura de leitura.
    state.latestEnhancement = data.analysis;
    setReadingMode('summary');
  } catch (e) {
    console.error('Falha ao aprimorar:', e.message);
    label.innerText = '❌ Falha — tente novamente';
    setTimeout(() => { label.innerText = original; }, 4000);
  } finally {
    btn.disabled = false;
    if (label.innerText.startsWith('Aprimorando') || label.innerText === original) {
      label.innerText = original;
    }
  }
}

// T-25: sufixo de métricas com o veredicto do juiz (resposta do enhance
// tem `judge` em objeto; linhas do histórico têm judge_approved/judge_model).
function judgeMetaSuffix(a) {
  const judgeObj = a.judge || null;
  const approved = judgeObj
    ? judgeObj.approved
    : (a.judge_approved === null || a.judge_approved === undefined ? null : !!a.judge_approved);
  if (approved === null) return '';
  const model = (judgeObj && judgeObj.model) || a.judge_model || '';
  const label = approved ? '✓ Aprovado pelo juiz' : '⚠ Juiz recomenda revisão';
  const parts = [label + (model ? ` (${model})` : '')];
  if ((a.attempts || 1) > 1) parts.push(`${a.attempts} tentativas`);
  const issues = (judgeObj && judgeObj.issues) || [];
  if (!approved && issues.length) parts.push(issues[0]);
  return ' • ' + parts.join(' • ');
}

async function loadLatestEnhancement(transcriptionId) {
  // Não troca de aba sozinho: apenas carrega o último resultado para a aba
  // "Resumo IA" já estar pronta quando o usuário abrir (ou para o render
  // atual, se ele já estiver nela).
  try {
    const res = await fetch(`/api/transcriptions/${transcriptionId}/analyses`, {
      headers: { 'Authorization': `Bearer ${state.token}` }
    });
    if (!res.ok) return;
    const rows = await res.json();
    if (!rows || rows.length === 0) return;
    state.latestEnhancement = rows[0];
    if (state.readingMode === 'summary') renderCurrentTranscript();
  } catch (e) { /* silencioso: resultado anterior é opcional */ }
}

// ---------------------------------------------------
// T-18: DICIONÁRIO DE CORREÇÕES (GLOSSÁRIO) — CRUD ADMIN
// ---------------------------------------------------
async function loadGlossary() {
  const list = document.getElementById('glossary-list');
  if (!list) return;
  try {
    const res = await fetch('/api/glossary', { headers: { 'Authorization': `Bearer ${state.token}` } });
    const rows = await res.json();
    if (!rows.length) {
      list.innerHTML = '<p class="text-[10px] text-brand-muted dark:text-brand-muted italic">Dicionário vazio. Adicione termos acima.</p>';
      return;
    }
    list.innerHTML = rows.map(g => `
      <div class="flex items-center justify-between bg-brand-surface dark:bg-brand-surface border border-brand-line dark:border-brand-line rounded-lg px-2.5 py-1.5">
        <span class="text-xs"><span class="text-red-500 dark:text-red-300 line-through">${escapeHtml(g.wrong)}</span> <span class="text-brand-muted">→</span> <span class="font-bold text-emerald-700 dark:text-emerald-300">${escapeHtml(g.correct)}</span></span>
        <button onclick="removeGlossaryTerm('${g.id}')" class="text-brand-muted hover:text-red-500 transition" title="Remover"><i data-lucide="trash-2" class="w-3.5 h-3.5"></i></button>
      </div>
    `).join('');
    if (window.lucide) lucide.createIcons();
  } catch (e) {
    console.error('Erro ao carregar dicionário:', e);
  }
}

async function addGlossaryTerm() {
  const wrongEl = document.getElementById('glossary-wrong');
  const correctEl = document.getElementById('glossary-correct');
  if (!wrongEl.value.trim() || !correctEl.value.trim()) {
    uiToast('Preencha a forma errada e a forma correta.');
    return;
  }
  try {
    const res = await fetch('/api/admin/glossary', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${state.token}` },
      body: JSON.stringify({ wrong: wrongEl.value, correct: correctEl.value })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Erro ao adicionar');
    wrongEl.value = '';
    correctEl.value = '';
    loadGlossary();
  } catch (e) {
    uiToast('Erro: ' + e.message);
  }
}

async function removeGlossaryTerm(id) {
  try {
    await fetch(`/api/admin/glossary/${id}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${state.token}` }
    });
    loadGlossary();
  } catch (e) {
    uiToast('Erro ao remover: ' + e.message);
  }
}

function resetAnalysisPrompt() {
  document.getElementById('admin-setting-analysis-prompt').value = '';
}

async function saveAdminSettings(e) {
  e.preventDefault();
  const settings = {
    base_model: document.getElementById('admin-setting-base-model').value,
    pro_model: document.getElementById('admin-setting-pro-model').value,
    max_model: document.getElementById('admin-setting-max-model').value,
    base_enabled: document.getElementById('admin-setting-base-enabled').checked ? 'true' : 'false',
    pro_enabled: document.getElementById('admin-setting-pro-enabled').checked ? 'true' : 'false',
    max_enabled: document.getElementById('admin-setting-max-enabled').checked ? 'true' : 'false',
    analysis_model: document.getElementById('admin-setting-analysis-model').value,
    analysis_prompt: document.getElementById('admin-setting-analysis-prompt').value,
    judge_model: document.getElementById('admin-setting-judge-model').value,
    judge_enabled: document.getElementById('admin-setting-judge-enabled').checked ? '1' : '0',
    // T-07: limites de uso
    max_file_size_mb: document.getElementById('admin-setting-max-file-size-mb').value,
    max_duration_hours: document.getElementById('admin-setting-max-duration-hours').value
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
      uiToast('Configurações de modelos e modos salvas com sucesso!');
      fetchSystemSettings();
    }
  } catch (e) {
    uiToast('Erro ao salvar configurações: ' + e.message);
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
    uiToast('Gravações excluídas com sucesso!');
  } catch (e) {
    uiToast('Erro ao excluir gravações selecionadas: ' + e.message);
  } finally {
    btn.disabled = false;
    btn.innerHTML = oldText;
  }
}

// ---------------------------------------------------
// T-13 — ÁUDIO ORIGINAL & EXPORT EM MASSA (ZIP)
// ---------------------------------------------------
function downloadOriginalAudio() {
  if (!state.activeTranscription) return;
  // A rota exige Authorization, então baixamos via fetch + blob (window.open perderia o token).
  downloadAuthenticatedBlob(
    `/api/transcriptions/${state.activeTranscription.id}/audio`,
    state.activeTranscription.file_name || 'audio'
  );
}

// Download autenticado genérico: fetch com Bearer → objectURL → clique temporário.
async function downloadAuthenticatedBlob(url, fallbackName) {
  try {
    const res = await fetch(url, { headers: { 'Authorization': `Bearer ${state.token}` } });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || 'Falha ao baixar (HTTP ' + res.status + ').');
    }
    const blob = await res.blob();
    const disposition = res.headers.get('Content-Disposition') || '';
    const starMatch = /filename\*=UTF-8''([^;]+)/i.exec(disposition);
    const plainMatch = /filename="?([^";]+)"?/i.exec(disposition);
    const name = starMatch ? decodeURIComponent(starMatch[1]) : (plainMatch ? plainMatch[1] : fallbackName);
    const objectUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = objectUrl;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(objectUrl), 5000);
  } catch (e) {
    uiToast('Erro ao baixar: ' + e.message);
  }
}

function toggleBulkExportMenu(event) {
  if (event) event.stopPropagation();
  const menu = document.getElementById('bulk-export-menu');
  if (menu) menu.classList.toggle('hidden');
}

// Fecha o menu ao clicar em qualquer lugar fora dele.
document.addEventListener('click', (e) => {
  const menu = document.getElementById('bulk-export-menu');
  if (menu && !menu.classList.contains('hidden') && !e.target.closest('#bulk-export-menu') && !e.target.closest('[onclick="toggleBulkExportMenu(event)"]')) {
    menu.classList.add('hidden');
  }
});

async function exportSelectedTranscriptions(format) {
  toggleBulkExportMenu();
  const checkedBoxes = document.querySelectorAll('.row-checkbox:checked');
  const ids = Array.from(checkedBoxes).map(cb => cb.value);
  if (ids.length === 0) return;

  const res = await fetch('/api/export/bulk', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${state.token}`
    },
    body: JSON.stringify({ ids, format })
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    uiToast('Erro ao exportar: ' + (data.error || 'HTTP ' + res.status));
    return;
  }
  const blob = await res.blob();
  const disposition = res.headers.get('Content-Disposition') || '';
  const starMatch = /filename\*=UTF-8''([^;]+)/i.exec(disposition);
  const plainMatch = /filename="?([^";]+)"?/i.exec(disposition);
  const name = starMatch ? decodeURIComponent(starMatch[1]) : (plainMatch ? plainMatch[1] : `transcreveai-${format}.zip`);
  const objectUrl = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = objectUrl;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(objectUrl), 5000);
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
    uiToast('Gravações movidas com sucesso!');
  } catch (e) {
    uiToast('Erro ao mover gravações selecionadas: ' + e.message);
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
  ['light', 'dark', 'system'].forEach(theme => document.querySelectorAll('[data-theme-option="' + theme + '"]').forEach(btn => btn.setAttribute('aria-pressed', String(currentTheme === theme))));
}
function setTheme(theme) {
  if (!['light', 'dark', 'system'].includes(theme)) return;
  currentTheme = theme;
  try { localStorage.setItem('transcreveai_theme', theme); } catch (_) {}
  applyTheme();
}
systemTheme.addEventListener('change', () => { if (currentTheme === 'system') applyTheme(); });
document.addEventListener('DOMContentLoaded', applyTheme);
