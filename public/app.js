const els = {
  baseUrl: document.querySelector('#baseUrl'),
  username: document.querySelector('#username'),
  password: document.querySelector('#password'),
  appToken: document.querySelector('#appToken'),
  contentType: document.querySelector('#contentType'),
  query: document.querySelector('#query'),
  searchBtn: document.querySelector('#searchBtn'),
  searchStatus: document.querySelector('#searchStatus'),
  results: document.querySelector('#results'),
  selected: document.querySelector('#selected'),
  episodes: document.querySelector('#episodes'),
  infoBtn: document.querySelector('#infoBtn'),
  inspectBtn: document.querySelector('#inspectBtn'),
  manualUrl: document.querySelector('#manualUrl'),
  manualInspectBtn: document.querySelector('#manualInspectBtn'),
  inspectStatus: document.querySelector('#inspectStatus'),
  summary: document.querySelector('#summary'),
  rawJson: document.querySelector('#rawJson')
};

const TYPE_LABELS = {
  movie: 'Filme/VOD',
  series: 'Série',
  live: 'Live TV'
};

let selectedItem = null;
let selectedEpisode = null;
let lastItemInfo = null;
let lastResults = [];

restoreSession();
updatePlaceholders();

els.searchBtn.addEventListener('click', searchContent);
els.query.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') searchContent();
});
els.contentType.addEventListener('change', () => {
  saveSession();
  clearSelection();
  updatePlaceholders();
});
els.infoBtn.addEventListener('click', loadItemInfo);
els.inspectBtn.addEventListener('click', inspectSelected);
els.manualInspectBtn.addEventListener('click', inspectManualUrl);

for (const input of [els.baseUrl, els.username, els.appToken]) {
  input.addEventListener('change', saveSession);
}

function saveSession() {
  sessionStorage.setItem('xtream-inspector', JSON.stringify({
    baseUrl: els.baseUrl.value,
    username: els.username.value,
    appToken: els.appToken.value,
    contentType: els.contentType.value
  }));
}

function restoreSession() {
  try {
    const saved = JSON.parse(sessionStorage.getItem('xtream-inspector') || '{}');
    els.baseUrl.value = saved.baseUrl || '';
    els.username.value = saved.username || '';
    els.appToken.value = saved.appToken || '';
    els.contentType.value = saved.contentType || 'movie';
  } catch {}
}

function updatePlaceholders() {
  const type = currentType();
  if (type === 'movie') els.query.placeholder = 'Ex: Avatar, Matrix, Duna...';
  if (type === 'series') els.query.placeholder = 'Ex: The Last of Us, Game of Thrones...';
  if (type === 'live') els.query.placeholder = 'Ex: HBO, Telecine, Globo, ESPN...';
}

function currentType() {
  return els.contentType.value || 'movie';
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
  if (!response.ok) {
    const error = new Error(data.error || `HTTP ${response.status}`);
    error.details = data.details;
    error.stderr = data.stderr;
    throw error;
  }
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

function itemId(item) {
  if (item.type === 'series') return item.seriesId;
  return item.streamId;
}

function itemMeta(item) {
  const parts = [
    TYPE_LABELS[item.type] || item.type,
    item.year ? `Ano ${item.year}` : '',
    item.containerExtension ? `.${item.containerExtension}` : '',
    item.categoryId ? `Categoria ${item.categoryId}` : '',
    item.epgChannelId ? `EPG ${item.epgChannelId}` : '',
    itemId(item) ? `ID ${itemId(item)}` : ''
  ];
  return parts.filter(Boolean).join(' · ');
}

function clearSelection() {
  selectedItem = null;
  selectedEpisode = null;
  lastItemInfo = null;
  lastResults = [];
  els.results.innerHTML = '';
  renderSelected();
}

async function searchContent() {
  const credentials = getCredentials();
  const query = els.query.value.trim();
  const type = currentType();
  saveSession();

  if (!credentials.baseUrl || !credentials.username || !credentials.password) {
    setStatus(els.searchStatus, 'Informe URL Xtream, usuário e senha.', 'error');
    return;
  }

  selectedItem = null;
  selectedEpisode = null;
  lastItemInfo = null;
  renderSelected();
  els.results.innerHTML = '';
  setStatus(els.searchStatus, `Buscando ${TYPE_LABELS[type]} no provider...`);

  try {
    const data = await api('/api/search', { ...credentials, type, query, limit: 120 });
    lastResults = data.results || [];
    setStatus(els.searchStatus, `${data.count} resultado(s) encontrado(s) em ${data.label || TYPE_LABELS[type]}.`, 'ok');
    renderResults(lastResults);
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
      selectedEpisode = null;
      lastItemInfo = null;
      renderSelected();
      window.scrollTo({ top: els.selected.getBoundingClientRect().top + window.scrollY - 24, behavior: 'smooth' });
    });
  });
}

function renderSelected() {
  const enabled = Boolean(selectedItem);
  const type = selectedItem?.type || currentType();

  els.infoBtn.disabled = !enabled || type === 'live';
  els.inspectBtn.disabled = !enabled || (type === 'series' && !selectedEpisode);
  els.infoBtn.textContent = type === 'series' ? 'Listar episódios' : type === 'movie' ? 'Consultar VOD info' : 'Live não tem detalhes';
  els.episodes.innerHTML = '';

  if (!selectedItem) {
    els.selected.className = 'selected empty';
    els.selected.textContent = 'Nenhum item selecionado.';
    return;
  }

  const rows = [
    ['Tipo', TYPE_LABELS[type] || type],
    ['Nome anunciado', selectedItem.name],
    [type === 'series' ? 'Series ID' : 'Stream ID', itemId(selectedItem)],
    ['Extensão', selectedItem.containerExtension || 'não informado'],
    ['Ano', selectedItem.year || 'não informado'],
    ['Categoria', selectedItem.categoryId || 'não informado']
  ];

  if (selectedItem.epgChannelId) rows.push(['EPG Channel ID', selectedItem.epgChannelId]);

  if (selectedEpisode) {
    rows.push(['Episódio selecionado', selectedEpisode.name]);
    rows.push(['Episode ID', selectedEpisode.episodeId]);
    rows.push(['Extensão do episódio', selectedEpisode.containerExtension || 'não informado']);
  }

  els.selected.className = 'selected';
  els.selected.innerHTML = `<dl class="kv">${rows.map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd>`).join('')}</dl>`;

  if (type === 'series') renderEpisodeHintOrList();
}

function renderEpisodeHintOrList() {
  if (!selectedItem || selectedItem.type !== 'series') return;

  if (!lastItemInfo?.episodes?.length) {
    els.episodes.innerHTML = '<div class="selected empty">Clique em “Listar episódios” e selecione um episódio para inspecionar. Série usa <strong>episode id</strong>, não o series_id.</div>';
    return;
  }

  renderEpisodes(lastItemInfo.episodes);
}

async function loadItemInfo() {
  if (!selectedItem) return;
  const type = selectedItem.type;

  if (type === 'live') {
    setStatus(els.inspectStatus, 'Live TV não precisa de detalhes. Pode inspecionar direto o stream do canal.', 'ok');
    return;
  }

  setStatus(els.inspectStatus, type === 'series' ? 'Consultando get_series_info e listando episódios...' : 'Consultando get_vod_info...');
  els.rawJson.textContent = '{}';

  try {
    lastItemInfo = await api('/api/item-info', {
      ...getCredentials(),
      type,
      streamId: selectedItem.streamId,
      seriesId: selectedItem.seriesId
    });

    if (type === 'series') {
      setStatus(els.inspectStatus, `${lastItemInfo.count || 0} episódio(s) carregado(s). Selecione um episódio.`, 'ok');
      renderEpisodes(lastItemInfo.episodes || []);
    } else {
      setStatus(els.inspectStatus, 'VOD info carregado.', 'ok');
    }

    els.rawJson.textContent = JSON.stringify(lastItemInfo, null, 2);
  } catch (error) {
    setStatus(els.inspectStatus, error.message, 'error');
  }
}

function renderEpisodes(episodes) {
  if (!selectedItem || selectedItem.type !== 'series') return;

  if (!episodes.length) {
    els.episodes.innerHTML = '<div class="selected empty">Nenhum episódio retornado pelo provider.</div>';
    return;
  }

  els.episodes.innerHTML = `
    <h3>Episódios</h3>
    <div class="episode-list">
      ${episodes.map((ep, index) => `
        <button class="episode-button ${selectedEpisode?.episodeId === ep.episodeId ? 'active' : ''}" data-episode-index="${index}">
          <span>${escapeHtml(ep.name)}</span>
          <small>${escapeHtml([ep.containerExtension ? `.${ep.containerExtension}` : '', ep.episodeId ? `ID ${ep.episodeId}` : ''].filter(Boolean).join(' · '))}</small>
        </button>
      `).join('')}
    </div>
  `;

  els.episodes.querySelectorAll('button[data-episode-index]').forEach((button) => {
    button.addEventListener('click', () => {
      selectedEpisode = episodes[Number(button.dataset.episodeIndex)];
      renderSelected();
      setStatus(els.inspectStatus, `Episódio selecionado: ${selectedEpisode.name}`, 'ok');
    });
  });
}

function extensionForSelected() {
  if (!selectedItem) return '';
  if (selectedItem.type === 'series') return selectedEpisode?.containerExtension || '';
  if (selectedItem.type === 'movie') {
    return selectedItem.containerExtension
      || lastItemInfo?.raw?.movie_data?.container_extension
      || lastItemInfo?.raw?.info?.container_extension
      || 'mp4';
  }
  if (selectedItem.type === 'live') return selectedItem.containerExtension || '';
  return '';
}

function advertisedNameForSelected() {
  if (!selectedItem) return '';
  if (selectedItem.type === 'series' && selectedEpisode) return `${selectedItem.name} - ${selectedEpisode.name}`;
  return selectedItem.name;
}

async function inspectSelected() {
  if (!selectedItem) return;
  if (selectedItem.type === 'series' && !selectedEpisode) {
    setStatus(els.inspectStatus, 'Para série, primeiro carregue e selecione um episódio.', 'error');
    return;
  }

  setStatus(els.inspectStatus, 'Inspecionando mídia com ffprobe...');
  els.summary.className = 'summary empty';
  els.summary.textContent = 'Processando...';

  try {
    const data = await api('/api/inspect', {
      ...getCredentials(),
      type: selectedItem.type,
      streamId: selectedItem.streamId,
      seriesId: selectedItem.seriesId,
      episodeId: selectedEpisode?.episodeId,
      extension: extensionForSelected(),
      advertisedName: advertisedNameForSelected()
    });
    renderInspection(data);
  } catch (error) {
    setStatus(els.inspectStatus, error.message, 'error');
    els.summary.className = 'summary empty';
    els.summary.textContent = 'Falha na inspeção. Veja o JSON bruto para o detalhe das tentativas.';
    els.rawJson.textContent = JSON.stringify({ error: error.message, details: error.details, stderr: error.stderr }, null, 2);
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
    els.summary.textContent = 'Falha na inspeção. Veja o JSON bruto para o detalhe das tentativas.';
    els.rawJson.textContent = JSON.stringify({ error: error.message, details: error.details, stderr: error.stderr }, null, 2);
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
    TYPE_LABELS[data.type] || data.type,
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
      <dt>Candidato usado</dt><dd>${escapeHtml(data.inspectedCandidate || '')}</dd>
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
