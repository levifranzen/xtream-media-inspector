const els = {
  baseUrl: document.querySelector('#baseUrl'),
  username: document.querySelector('#username'),
  password: document.querySelector('#password'),
  appToken: document.querySelector('#appToken'),
  query: document.querySelector('#query'),
  searchBtn: document.querySelector('#searchBtn'),
  searchStatus: document.querySelector('#searchStatus'),
  results: document.querySelector('#results'),
  selected: document.querySelector('#selected'),
  infoBtn: document.querySelector('#infoBtn'),
  inspectBtn: document.querySelector('#inspectBtn'),
  manualUrl: document.querySelector('#manualUrl'),
  manualInspectBtn: document.querySelector('#manualInspectBtn'),
  inspectStatus: document.querySelector('#inspectStatus'),
  summary: document.querySelector('#summary'),
  rawJson: document.querySelector('#rawJson')
};

let selectedItem = null;
let lastVodInfo = null;

restoreSession();

els.searchBtn.addEventListener('click', searchMovies);
els.query.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') searchMovies();
});
els.infoBtn.addEventListener('click', loadVodInfo);
els.inspectBtn.addEventListener('click', inspectSelected);
els.manualInspectBtn.addEventListener('click', inspectManualUrl);

for (const input of [els.baseUrl, els.username, els.appToken]) {
  input.addEventListener('change', saveSession);
}

function saveSession() {
  sessionStorage.setItem('xtream-inspector', JSON.stringify({
    baseUrl: els.baseUrl.value,
    username: els.username.value,
    appToken: els.appToken.value
  }));
}

function restoreSession() {
  try {
    const saved = JSON.parse(sessionStorage.getItem('xtream-inspector') || '{}');
    els.baseUrl.value = saved.baseUrl || '';
    els.username.value = saved.username || '';
    els.appToken.value = saved.appToken || '';
  } catch {}
}

function getCredentials() {
  return {
    baseUrl: els.baseUrl.value.trim(),
    username: els.username.value.trim(),
    password: els.password.value
  };
}

async function api(path, payload) {
  const headers = { 'content-type': 'application/json' };
  if (els.appToken.value) headers['x-app-token'] = els.appToken.value;

  const response = await fetch(path, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload)
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

function setStatus(el, message, kind = '') {
  el.textContent = message || '';
  el.className = `status ${kind}`.trim();
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function itemMeta(item) {
  return [
    item.year ? `Ano ${item.year}` : '',
    item.containerExtension ? `.${item.containerExtension}` : '',
    item.categoryId ? `Categoria ${item.categoryId}` : '',
    item.streamId ? `ID ${item.streamId}` : ''
  ].filter(Boolean).join(' · ');
}

async function searchMovies() {
  const credentials = getCredentials();
  const query = els.query.value.trim();
  saveSession();

  if (!credentials.baseUrl || !credentials.username || !credentials.password) {
    setStatus(els.searchStatus, 'Informe URL Xtream, usuário e senha.', 'error');
    return;
  }

  selectedItem = null;
  lastVodInfo = null;
  renderSelected();
  els.results.innerHTML = '';
  setStatus(els.searchStatus, 'Buscando no provider...');

  try {
    const data = await api('/api/search', { ...credentials, query, limit: 80 });
    setStatus(els.searchStatus, `${data.count} resultado(s) encontrado(s).`, 'ok');
    renderResults(data.results || []);
  } catch (error) {
    setStatus(els.searchStatus, error.message, 'error');
  }
}

function renderResults(results) {
  if (!results.length) {
    els.results.innerHTML = '<div class="selected empty">Nenhum resultado.</div>';
    return;
  }

  els.results.innerHTML = results.map((item, index) => `
    <article class="result-item">
      <div>
        <div class="result-title">${escapeHtml(item.name)}</div>
        <div class="result-meta">${escapeHtml(itemMeta(item))}</div>
      </div>
      <button data-index="${index}">Selecionar</button>
    </article>
  `).join('');

  els.results.querySelectorAll('button[data-index]').forEach((button) => {
    button.addEventListener('click', () => {
      selectedItem = results[Number(button.dataset.index)];
      lastVodInfo = null;
      renderSelected();
      window.scrollTo({ top: els.selected.getBoundingClientRect().top + window.scrollY - 24, behavior: 'smooth' });
    });
  });
}

function renderSelected() {
  const enabled = Boolean(selectedItem);
  els.infoBtn.disabled = !enabled;
  els.inspectBtn.disabled = !enabled;

  if (!selectedItem) {
    els.selected.className = 'selected empty';
    els.selected.textContent = 'Nenhum item selecionado.';
    return;
  }

  els.selected.className = 'selected';
  els.selected.innerHTML = `
    <dl class="kv">
      <dt>Nome anunciado</dt><dd>${escapeHtml(selectedItem.name)}</dd>
      <dt>Stream ID</dt><dd>${escapeHtml(selectedItem.streamId)}</dd>
      <dt>Extensão</dt><dd>${escapeHtml(selectedItem.containerExtension || 'não informado')}</dd>
      <dt>Ano</dt><dd>${escapeHtml(selectedItem.year || 'não informado')}</dd>
      <dt>Categoria</dt><dd>${escapeHtml(selectedItem.categoryId || 'não informado')}</dd>
    </dl>
  `;
}

async function loadVodInfo() {
  if (!selectedItem) return;
  setStatus(els.inspectStatus, 'Consultando get_vod_info...');
  els.rawJson.textContent = '{}';

  try {
    lastVodInfo = await api('/api/vod-info', {
      ...getCredentials(),
      streamId: selectedItem.streamId
    });
    setStatus(els.inspectStatus, 'VOD info carregado.', 'ok');
    els.rawJson.textContent = JSON.stringify(lastVodInfo, null, 2);
  } catch (error) {
    setStatus(els.inspectStatus, error.message, 'error');
  }
}

function extensionForSelected() {
  return selectedItem?.containerExtension
    || lastVodInfo?.movie_data?.container_extension
    || lastVodInfo?.info?.container_extension
    || 'mp4';
}

async function inspectSelected() {
  if (!selectedItem) return;
  setStatus(els.inspectStatus, 'Inspecionando mídia com ffprobe...');
  els.summary.className = 'summary empty';
  els.summary.textContent = 'Processando...';

  try {
    const data = await api('/api/inspect', {
      ...getCredentials(),
      streamId: selectedItem.streamId,
      extension: extensionForSelected(),
      advertisedName: selectedItem.name
    });
    renderInspection(data);
  } catch (error) {
    setStatus(els.inspectStatus, error.message, 'error');
    els.summary.className = 'summary empty';
    els.summary.textContent = 'Falha na inspeção.';
  }
}

async function inspectManualUrl() {
  const mediaUrl = els.manualUrl.value.trim();
  if (!mediaUrl) {
    setStatus(els.inspectStatus, 'Informe uma URL manual.', 'error');
    return;
  }

  setStatus(els.inspectStatus, 'Inspecionando URL manual com ffprobe...');
  els.summary.className = 'summary empty';
  els.summary.textContent = 'Processando...';

  try {
    const data = await api('/api/inspect', {
      mediaUrl,
      advertisedName: 'URL manual'
    });
    renderInspection(data);
  } catch (error) {
    setStatus(els.inspectStatus, error.message, 'error');
    els.summary.className = 'summary empty';
    els.summary.textContent = 'Falha na inspeção.';
  }
}

function renderInspection(data) {
  const real = data.real || {};
  const video = real.video || {};
  const http = data.http || {};
  const audio = real.audio || [];

  setStatus(els.inspectStatus, 'Inspeção concluída.', 'ok');
  els.summary.className = 'summary';
  els.rawJson.textContent = JSON.stringify(data, null, 2);

  const badges = [
    video.resolution,
    video.codec ? `Vídeo ${video.codec}${video.profile ? ` / ${video.profile}` : ''}` : '',
    video.fps ? `${video.fps} fps` : '',
    real.bitrateHuman ? `Bitrate ${real.bitrateHuman}` : '',
    video.hdr?.isHdr ? 'HDR detectado' : 'HDR não detectado',
    audio.length ? `${audio.length} áudio(s)` : '',
    real.subtitles?.length ? `${real.subtitles.length} legenda(s)` : ''
  ].filter(Boolean);

  els.summary.innerHTML = `
    <div class="verdict">
      ${(real.verdict || []).map(line => `<div class="verdict-line">${escapeHtml(line)}</div>`).join('')}
    </div>

    <div class="badge-row">
      ${badges.map(b => `<span class="badge">${escapeHtml(b)}</span>`).join('')}
    </div>

    <dl class="kv">
      <dt>Nome anunciado</dt><dd>${escapeHtml(data.advertisedName || '')}</dd>
      <dt>URL inspecionada</dt><dd>${escapeHtml(data.inspectedUrl || '')}</dd>
      <dt>Host final</dt><dd>${escapeHtml(http.finalHost || http.error || 'não identificado')}</dd>
      <dt>HTTP</dt><dd>${escapeHtml(http.status ? `${http.status} · ${http.contentType || ''}` : http.error || '')}</dd>
      <dt>Resolução real</dt><dd>${escapeHtml(video.width && video.height ? `${video.width}x${video.height} · ${video.resolution}` : 'não identificado')}</dd>
      <dt>Codec de vídeo</dt><dd>${escapeHtml(video.codecLongName || video.codec || 'não identificado')}</dd>
      <dt>Bitrate</dt><dd>${escapeHtml(real.bitrateHuman || video.bitrateHuman || 'não identificado')}</dd>
      <dt>FPS</dt><dd>${escapeHtml(video.fps || 'não identificado')}</dd>
      <dt>HDR</dt><dd>${escapeHtml(video.hdr?.isHdr ? `sim (${video.hdr.signal})` : 'não detectado')}</dd>
      <dt>Container</dt><dd>${escapeHtml(real.containerLongName || real.container || 'não identificado')}</dd>
      <dt>Duração</dt><dd>${escapeHtml(real.duration || 'não identificado')}</dd>
      <dt>Tamanho</dt><dd>${escapeHtml(real.size || 'não informado pelo servidor')}</dd>
      <dt>Áudio</dt><dd>${escapeHtml(formatAudio(audio))}</dd>
      <dt>Legendas</dt><dd>${escapeHtml(formatSubtitles(real.subtitles || []))}</dd>
    </dl>
  `;
}

function formatAudio(audio) {
  if (!audio.length) return 'não identificado';
  return audio.map(a => [
    a.language || 'und',
    a.codec,
    a.channelLayout || (a.channels ? `${a.channels} canais` : ''),
    a.bitrateHuman
  ].filter(Boolean).join(' · ')).join(' | ');
}

function formatSubtitles(subtitles) {
  if (!subtitles.length) return 'nenhuma detectada';
  return subtitles.map(s => [s.language || 'und', s.codec].filter(Boolean).join(' · ')).join(' | ');
}
