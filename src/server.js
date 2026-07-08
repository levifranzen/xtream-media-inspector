import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import dns from 'node:dns/promises';
import net from 'node:net';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const ROOT = normalize(join(__dirname, '..'));
const PUBLIC_DIR = join(ROOT, 'public');
const PORT = Number(process.env.PORT || 10000);
const APP_TOKEN = process.env.APP_TOKEN || '';

const JSON_LIMIT_BYTES = 128 * 1024;
const FETCH_TIMEOUT_MS = Number(process.env.FETCH_TIMEOUT_MS || 20000);
const FFPROBE_TIMEOUT_MS = Number(process.env.FFPROBE_TIMEOUT_MS || 35000);
const FFPROBE_ANALYZE_US = String(Number(process.env.FFPROBE_ANALYZE_US || 10000000));
const FFPROBE_PROBESIZE_BYTES = String(Number(process.env.FFPROBE_PROBESIZE_BYTES || 10000000));
const FFPROBE_RW_TIMEOUT_US = String(Number(process.env.FFPROBE_RW_TIMEOUT_US || 15000000));
const MEDIA_USER_AGENT = process.env.MEDIA_USER_AGENT || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36 XtreamMediaInspector/1.2';
const MEDIA_REFERER = process.env.MEDIA_REFERER || '';
const MEDIA_ORIGIN = process.env.MEDIA_ORIGIN || '';
const MOVIE_FALLBACK_EXTENSIONS = csv(process.env.MOVIE_FALLBACK_EXTENSIONS || 'mkv,mp4,avi,ts,m3u8');
const SERIES_FALLBACK_EXTENSIONS = csv(process.env.SERIES_FALLBACK_EXTENSIONS || 'mkv,mp4,avi,ts,m3u8');
const LIVE_FALLBACK_EXTENSIONS = csv(process.env.LIVE_FALLBACK_EXTENSIONS || 'm3u8,ts');

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

const TYPE_LABELS = {
  movie: 'Filme/VOD',
  series: 'Série',
  live: 'Live TV'
};

function csv(value) {
  return String(value || '')
    .split(',')
    .map(x => x.trim().replace(/^\./, ''))
    .filter(Boolean);
}

function sendJson(res, statusCode, data) {
  const body = JSON.stringify(data, null, 2);
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store'
  });
  res.end(body);
}

function sendText(res, statusCode, text) {
  res.writeHead(statusCode, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
  res.end(text);
}

function normalizeBaseUrl(input) {
  if (!input || typeof input !== 'string') throw new Error('baseUrl é obrigatório.');
  let value = input.trim();
  if (!/^https?:\/\//i.test(value)) value = `http://${value}`;
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('baseUrl precisa ser HTTP ou HTTPS.');
  url.pathname = url.pathname.replace(/\/+$/, '');
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/$/, '');
}

function makeXtreamApiUrl(baseUrl, username, password, params = {}) {
  const url = new URL(`${normalizeBaseUrl(baseUrl)}/player_api.php`);
  url.searchParams.set('username', username || '');
  url.searchParams.set('password', password || '');
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
  }
  return url;
}

function normalizeContentType(type) {
  const t = String(type || 'movie').toLowerCase().trim();
  if (['movie', 'vod', 'movies', 'filme', 'filmes'].includes(t)) return 'movie';
  if (['series', 'serie', 'série', 'seriado'].includes(t)) return 'series';
  if (['live', 'livetv', 'live_tv', 'tv', 'canais', 'channel', 'channels'].includes(t)) return 'live';
  throw new Error(`Tipo de conteúdo inválido: ${type}`);
}

function getExtensionFromItem(item) {
  return String(item?.container_extension || item?.containerExtension || item?.extension || item?.ext || '').replace(/^\./, '').trim();
}

function getExtensionFromVodInfo(info) {
  return getExtensionFromItem(info?.movie_data)
    || getExtensionFromItem(info?.info)
    || getExtensionFromItem(info?.movie)
    || getExtensionFromItem(info);
}

function getExtensionFromEpisode(episode) {
  return getExtensionFromItem(episode)
    || getExtensionFromItem(episode?.info)
    || getExtensionFromItem(episode?.episode_data);
}

function makeMediaUrl(baseUrl, username, password, kind, id, extension = '') {
  if (!id) throw new Error('ID da mídia é obrigatório.');
  const cleanKind = normalizeContentType(kind);
  const pathKind = cleanKind === 'movie' ? 'movie' : cleanKind === 'series' ? 'series' : 'live';
  const cleanExt = String(extension || '').replace(/^\./, '').trim();
  const suffix = cleanExt ? `.${encodeURIComponent(cleanExt)}` : '';
  return `${normalizeBaseUrl(baseUrl)}/${pathKind}/${encodeURIComponent(username)}/${encodeURIComponent(password)}/${encodeURIComponent(String(id).trim())}${suffix}`;
}

function makeGenericStreamUrl(baseUrl, username, password, id, extension = '') {
  const cleanExt = String(extension || '').replace(/^\./, '').trim();
  const suffix = cleanExt ? `.${encodeURIComponent(cleanExt)}` : '';
  return `${normalizeBaseUrl(baseUrl)}/${encodeURIComponent(username)}/${encodeURIComponent(password)}/${encodeURIComponent(String(id).trim())}${suffix}`;
}

function uniqueValues(values) {
  const seen = new Set();
  const out = [];
  for (const value of values) {
    const clean = String(value ?? '').replace(/^\./, '').trim();
    const key = clean.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(clean);
  }
  return out;
}

function uniqueCandidates(candidates) {
  const seen = new Set();
  const out = [];
  for (const candidate of candidates) {
    const key = candidate.url;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(candidate);
  }
  return out;
}

function redactUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    url.username = '';
    url.password = '';
    url.pathname = url.pathname
      .replace(/\/movie\/[^/]+\/[^/]+\//i, '/movie/***/***/')
      .replace(/\/series\/[^/]+\/[^/]+\//i, '/series/***/***/')
      .replace(/\/live\/[^/]+\/[^/]+\//i, '/live/***/***/')
      .replace(/^\/([^/]+)\/([^/]+)\//i, '/***/***/');
    return url.toString();
  } catch {
    return '[url inválida]';
  }
}

function requireApiToken(req) {
  if (!APP_TOKEN) return true;
  return req.headers['x-app-token'] === APP_TOKEN;
}

function isPrivateIp(ip) {
  if (!ip) return true;

  if (net.isIPv4(ip)) {
    const parts = ip.split('.').map(Number);
    const [a, b] = parts;
    return (
      a === 10 ||
      a === 127 ||
      a === 0 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168)
    );
  }

  if (net.isIPv6(ip)) {
    const lower = ip.toLowerCase();
    return lower === '::1' || lower.startsWith('fc') || lower.startsWith('fd') || lower.startsWith('fe80:');
  }

  return true;
}

async function assertPublicHttpTarget(rawUrl) {
  const url = new URL(rawUrl);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Somente URLs HTTP/HTTPS são permitidas.');

  // SSRF guard. If you need to inspect private IPs in a private deployment, set ALLOW_PRIVATE_TARGETS=true.
  if (process.env.ALLOW_PRIVATE_TARGETS === 'true') return;

  const host = url.hostname;
  if (host === 'localhost' || host.endsWith('.localhost')) throw new Error('Host local não permitido.');
  if (net.isIP(host) && isPrivateIp(host)) throw new Error('IP privado/local não permitido.');

  const answers = await dns.lookup(host, { all: true, verbatim: true });
  if (!answers.length) throw new Error('Não foi possível resolver o host.');
  for (const answer of answers) {
    if (isPrivateIp(answer.address)) throw new Error('Host resolve para IP privado/local, bloqueado por segurança.');
  }
}

async function fetchJson(url) {
  await assertPublicHttpTarget(url.toString());

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'accept': 'application/json,text/plain,*/*',
        'user-agent': MEDIA_USER_AGENT
      }
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`Provider respondeu HTTP ${response.status}: ${text.slice(0, 200)}`);
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`Resposta não é JSON válido: ${text.slice(0, 200)}`);
    }
  } finally {
    clearTimeout(timer);
  }
}

async function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', chunk => {
      size += chunk.length;
      if (size > JSON_LIMIT_BYTES) {
        reject(new Error('Payload muito grande.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('JSON inválido no body.'));
      }
    });
    req.on('error', reject);
  });
}

function normalizeText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function getYear(item) {
  const direct = item?.year || item?.releaseDate || item?.release_date || item?.releasedate;
  const match = String(direct || item?.name || item?.title || '').match(/\b(19\d{2}|20\d{2})\b/);
  return match ? match[1] : '';
}

function trimMovieItem(item) {
  return {
    type: 'movie',
    streamId: item.stream_id ?? item.streamId ?? item.id,
    name: item.name || item.title || '',
    year: getYear(item),
    categoryId: item.category_id ?? item.categoryId ?? '',
    containerExtension: getExtensionFromItem(item),
    rating: item.rating || '',
    added: item.added || '',
    icon: item.stream_icon || item.cover || ''
  };
}

function trimSeriesItem(item) {
  return {
    type: 'series',
    seriesId: item.series_id ?? item.seriesId ?? item.id,
    name: item.name || item.title || '',
    year: getYear(item),
    categoryId: item.category_id ?? item.categoryId ?? '',
    rating: item.rating || '',
    added: item.last_modified || item.added || '',
    icon: item.cover || item.series_icon || item.stream_icon || ''
  };
}

function trimLiveItem(item) {
  return {
    type: 'live',
    streamId: item.stream_id ?? item.streamId ?? item.id,
    name: item.name || item.title || '',
    categoryId: item.category_id ?? item.categoryId ?? '',
    epgChannelId: item.epg_channel_id || '',
    tvArchive: item.tv_archive || item.tvArchive || '',
    icon: item.stream_icon || item.cover || '',
    containerExtension: getExtensionFromItem(item)
  };
}

function trimItemByType(item, type) {
  if (type === 'series') return trimSeriesItem(item);
  if (type === 'live') return trimLiveItem(item);
  return trimMovieItem(item);
}

function filterResults(items, query, limit = 50, type = 'movie') {
  const normalizedQuery = normalizeText(query);
  const words = normalizedQuery.split(' ').filter(Boolean);
  const cleanType = normalizeContentType(type);

  const scored = items.map((item) => {
    const clean = trimItemByType(item, cleanType);
    const searchable = normalizeText(`${clean.name} ${clean.year} ${clean.categoryId} ${clean.epgChannelId || ''}`);
    let score = 0;
    if (!normalizedQuery) score = 1;
    else if (searchable === normalizedQuery) score = 100;
    else if (searchable.includes(normalizedQuery)) score = 80;
    else if (words.every(word => searchable.includes(word))) score = 60;
    else if (words.some(word => searchable.includes(word))) score = 20;
    return { item: clean, score };
  });

  return scored
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score || String(a.item.name).localeCompare(String(b.item.name)))
    .slice(0, Math.max(1, Math.min(Number(limit) || 50, 300)))
    .map(x => x.item);
}

async function getXtreamList({ baseUrl, username, password, type }) {
  const cleanType = normalizeContentType(type);
  const action = cleanType === 'series'
    ? 'get_series'
    : cleanType === 'live'
      ? 'get_live_streams'
      : 'get_vod_streams';
  const url = makeXtreamApiUrl(baseUrl, username, password, { action });
  const json = await fetchJson(url);
  if (!Array.isArray(json)) throw new Error(`O provider não retornou uma lista de ${TYPE_LABELS[cleanType]}.`);
  return json;
}

async function getVodInfo({ baseUrl, username, password, streamId }) {
  const url = makeXtreamApiUrl(baseUrl, username, password, { action: 'get_vod_info', vod_id: streamId });
  return await fetchJson(url);
}

async function getSeriesInfo({ baseUrl, username, password, seriesId }) {
  const url = makeXtreamApiUrl(baseUrl, username, password, { action: 'get_series_info', series_id: seriesId });
  return await fetchJson(url);
}

function flattenSeriesEpisodes(seriesInfo) {
  const episodes = seriesInfo?.episodes || {};
  const out = [];

  if (Array.isArray(episodes)) {
    for (const ep of episodes) out.push(normalizeEpisode(ep, ep?.season || ep?.season_number));
  } else if (episodes && typeof episodes === 'object') {
    for (const [seasonKey, list] of Object.entries(episodes)) {
      const season = Number(seasonKey) || seasonKey;
      if (Array.isArray(list)) {
        for (const ep of list) out.push(normalizeEpisode(ep, season));
      }
    }
  }

  return out
    .filter(ep => ep.episodeId)
    .sort((a, b) => Number(a.season || 0) - Number(b.season || 0) || Number(a.episodeNum || 0) - Number(b.episodeNum || 0) || String(a.name).localeCompare(String(b.name)));
}

function normalizeEpisode(ep, seasonFallback = '') {
  const season = ep?.season ?? ep?.season_number ?? ep?.season_num ?? seasonFallback ?? '';
  const episodeNum = ep?.episode_num ?? ep?.episode_number ?? ep?.episode ?? '';
  const title = ep?.title || ep?.name || ep?.info?.name || '';
  const s = String(season || '').padStart(2, '0');
  const e = String(episodeNum || '').padStart(2, '0');
  const prefix = season || episodeNum ? `S${s}E${e}` : '';
  const name = [prefix, title].filter(Boolean).join(' · ');

  return {
    type: 'series',
    episodeId: ep?.id ?? ep?.stream_id ?? ep?.streamId ?? ep?.episode_id,
    name: name || String(ep?.id || ''),
    title,
    season,
    episodeNum,
    containerExtension: getExtensionFromEpisode(ep),
    info: {
      duration: ep?.info?.duration || ep?.info?.duration_secs || '',
      plot: ep?.info?.plot || '',
      releasedate: ep?.info?.releasedate || ep?.info?.releaseDate || '',
      movieImage: ep?.info?.movie_image || ep?.info?.cover_big || ''
    }
  };
}

async function getFinalHttpInfo(rawUrl) {
  await assertPublicHttpTarget(rawUrl);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  const headers = {
    'user-agent': MEDIA_USER_AGENT,
    'accept': '*/*'
  };

  async function attempt(method, extraHeaders = {}) {
    return await fetch(rawUrl, {
      method,
      redirect: 'follow',
      signal: controller.signal,
      headers: { ...headers, ...extraHeaders }
    });
  }

  try {
    let response;
    try {
      response = await attempt('HEAD');
    } catch {
      response = await attempt('GET', { range: 'bytes=0-0' });
      try { await response.body?.cancel?.(); } catch {}
    }

    const finalUrl = response.url || rawUrl;
    const final = new URL(finalUrl);
    return {
      ok: response.ok,
      status: response.status,
      contentType: response.headers.get('content-type') || '',
      contentLength: response.headers.get('content-length') || '',
      acceptsRanges: response.headers.get('accept-ranges') || '',
      finalHost: final.host,
      finalUrlRedacted: redactUrl(finalUrl)
    };
  } finally {
    clearTimeout(timer);
  }
}

function ffprobeHeaderString(rawUrl) {
  const lines = [
    'Accept: */*',
    'Connection: close'
  ];

  if (MEDIA_REFERER) {
    lines.push(`Referer: ${MEDIA_REFERER}`);
  } else {
    try {
      const u = new URL(rawUrl);
      lines.push(`Referer: ${u.origin}/`);
    } catch {}
  }

  if (MEDIA_ORIGIN) lines.push(`Origin: ${MEDIA_ORIGIN}`);
  return `${lines.join('\r\n')}\r\n`;
}

function runFfprobe(rawUrl) {
  return new Promise(async (resolve, reject) => {
    try {
      await assertPublicHttpTarget(rawUrl);
    } catch (error) {
      reject(error);
      return;
    }

    const args = [
      '-v', 'error',
      '-hide_banner',
      '-user_agent', MEDIA_USER_AGENT,
      '-headers', ffprobeHeaderString(rawUrl),
      '-rw_timeout', FFPROBE_RW_TIMEOUT_US,
      '-analyzeduration', FFPROBE_ANALYZE_US,
      '-probesize', FFPROBE_PROBESIZE_BYTES,
      '-allowed_extensions', 'ALL',
      '-print_format', 'json',
      '-show_format',
      '-show_streams',
      rawUrl
    ];

    const child = spawn('ffprobe', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let finished = false;

    const timer = setTimeout(() => {
      if (!finished) {
        finished = true;
        child.kill('SIGKILL');
        const error = new Error('ffprobe excedeu o timeout. Em LiveTV isso pode indicar stream lento, offline ou que exige outro formato de saída.');
        error.stderr = stderr.slice(0, 2000);
        reject(error);
      }
    }, FFPROBE_TIMEOUT_MS);

    child.stdout.on('data', chunk => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', chunk => { stderr += chunk.toString('utf8'); });
    child.on('error', error => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', code => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);

      if (code !== 0) {
        const cleanStderr = stderr.trim().slice(0, 3000);
        const error = new Error(cleanStderr ? `ffprobe falhou com código ${code}: ${cleanStderr}` : `ffprobe falhou com código ${code}.`);
        error.stderr = cleanStderr;
        reject(error);
        return;
      }

      try {
        resolve(JSON.parse(stdout || '{}'));
      } catch {
        reject(new Error(`ffprobe retornou JSON inválido. ${stdout.slice(0, 300)}`));
      }
    });
  });
}

function parseFrameRate(value) {
  if (!value || value === '0/0') return null;
  const [a, b] = String(value).split('/').map(Number);
  if (!a || !b) return null;
  return Math.round((a / b) * 1000) / 1000;
}

function parseNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function humanBitrate(bitsPerSecond) {
  const value = parseNumber(bitsPerSecond);
  if (!value) return '';
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)} Mbps`;
  if (value >= 1_000) return `${Math.round(value / 1_000)} kbps`;
  return `${value} bps`;
}

function humanBytes(bytes) {
  const value = parseNumber(bytes);
  if (!value) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let n = value;
  let idx = 0;
  while (n >= 1024 && idx < units.length - 1) {
    n /= 1024;
    idx++;
  }
  return `${n.toFixed(idx === 0 ? 0 : 2)} ${units[idx]}`;
}

function humanDuration(seconds) {
  const value = parseNumber(seconds);
  if (!value) return '';
  const total = Math.round(value);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return [h, m, s].map(v => String(v).padStart(2, '0')).join(':');
}

function resolutionLabel(width, height) {
  if (!width || !height) return '';
  if (width >= 3840 || height >= 2160) return '2160p / 4K UHD';
  if (width >= 2560 || height >= 1440) return '1440p / QHD';
  if (width >= 1920 || height >= 1080) return '1080p / Full HD';
  if (width >= 1280 || height >= 720) return '720p / HD';
  if (height >= 576) return '576p / SD';
  if (height >= 480) return '480p / SD';
  return `${height}p`;
}

function detectHdr(video) {
  if (!video) return { isHdr: false, signal: '' };
  const transfer = String(video.color_transfer || '').toLowerCase();
  const primaries = String(video.color_primaries || '').toLowerCase();
  const space = String(video.color_space || '').toLowerCase();
  const sideData = JSON.stringify(video.side_data_list || []).toLowerCase();

  const isHdr =
    transfer.includes('smpte2084') ||
    transfer.includes('arib-std-b67') ||
    sideData.includes('mastering display') ||
    sideData.includes('content light level') ||
    (primaries.includes('bt2020') && (transfer.includes('smpte') || transfer.includes('arib')));

  const signals = [];
  if (transfer) signals.push(`transfer=${transfer}`);
  if (primaries) signals.push(`primaries=${primaries}`);
  if (space) signals.push(`space=${space}`);
  return { isHdr, signal: signals.join(', ') };
}

function advertisedFlags(name) {
  const n = normalizeText(name);
  return {
    claims4k: /(^| )(4k|uhd|2160p)( |$)/.test(n),
    claims1080: /(^| )(fhd|full hd|1080p)( |$)/.test(n),
    claims720: /(^| )(hd|720p)( |$)/.test(n),
    claimsHdr: /(^| )(hdr|hdr10|dolby vision|dv)( |$)/.test(n),
    claimsHevc: /(^| )(hevc|h265|h 265|x265)( |$)/.test(n)
  };
}

function makeVerdict({ advertisedName, width, height, videoCodec, hdr, type }) {
  const flags = advertisedFlags(advertisedName);
  const lines = [];

  if (flags.claims4k && height < 2000 && width < 3500) {
    lines.push('⚠️ Anunciado como 4K/UHD, mas a resolução real não é 4K.');
  } else if (flags.claims4k && (height >= 2000 || width >= 3500)) {
    lines.push('✅ Resolução compatível com 4K/UHD real.');
  }

  if (flags.claims1080 && height < 1000 && width < 1800) {
    lines.push('⚠️ Anunciado como Full HD/1080p, mas a resolução real é menor.');
  } else if (flags.claims1080 && (height >= 1000 || width >= 1800)) {
    lines.push('✅ Resolução compatível com Full HD/1080p.');
  }

  if (flags.claimsHdr && !hdr?.isHdr) {
    lines.push('⚠️ O nome anuncia HDR/DV, mas o ffprobe não encontrou sinal claro de HDR nos metadados.');
  } else if (flags.claimsHdr && hdr?.isHdr) {
    lines.push('✅ Metadados indicam HDR.');
  }

  if (flags.claimsHevc && !String(videoCodec || '').toLowerCase().includes('hevc')) {
    lines.push('⚠️ O nome anuncia HEVC/H.265, mas o codec real parece ser outro.');
  }

  if (type === 'live' && !lines.length) {
    lines.push('ℹ️ LiveTV inspecionada. Para canais ao vivo, bitrate/FPS podem variar e a duração normalmente não aparece.');
  } else if (!lines.length) {
    lines.push('ℹ️ Sem conflito óbvio entre o nome anunciado e os metadados reais encontrados.');
  }

  return lines;
}

function summarizeProbe(probe, advertisedName = '', type = '') {
  const streams = Array.isArray(probe?.streams) ? probe.streams : [];
  const format = probe?.format || {};
  const video = streams.find(s => s.codec_type === 'video') || null;
  const audio = streams.filter(s => s.codec_type === 'audio').map(s => ({
    index: s.index,
    codec: s.codec_name || '',
    codecLongName: s.codec_long_name || '',
    channels: s.channels || null,
    channelLayout: s.channel_layout || '',
    language: s.tags?.language || '',
    bitrate: parseNumber(s.bit_rate),
    bitrateHuman: humanBitrate(s.bit_rate)
  }));

  const width = parseNumber(video?.width);
  const height = parseNumber(video?.height);
  const bitrate = parseNumber(video?.bit_rate) || parseNumber(format?.bit_rate);
  const hdr = detectHdr(video);

  return {
    contentType: type || '',
    container: format.format_name || '',
    containerLongName: format.format_long_name || '',
    durationSeconds: parseNumber(format.duration),
    duration: humanDuration(format.duration),
    sizeBytes: parseNumber(format.size),
    size: humanBytes(format.size),
    bitrate,
    bitrateHuman: humanBitrate(bitrate),
    video: video ? {
      index: video.index,
      codec: video.codec_name || '',
      codecLongName: video.codec_long_name || '',
      profile: video.profile || '',
      width,
      height,
      resolution: resolutionLabel(width, height),
      fps: parseFrameRate(video.avg_frame_rate || video.r_frame_rate),
      bitrate: parseNumber(video.bit_rate),
      bitrateHuman: humanBitrate(video.bit_rate),
      pixelFormat: video.pix_fmt || '',
      colorRange: video.color_range || '',
      colorSpace: video.color_space || '',
      colorTransfer: video.color_transfer || '',
      colorPrimaries: video.color_primaries || '',
      hdr
    } : null,
    audio,
    subtitles: streams.filter(s => s.codec_type === 'subtitle').map(s => ({
      index: s.index,
      codec: s.codec_name || '',
      language: s.tags?.language || ''
    })),
    verdict: makeVerdict({ advertisedName, width, height, videoCodec: video?.codec_name, hdr, type })
  };
}

async function handleSearch(req, res) {
  const body = await readJsonBody(req);
  const { baseUrl, username, password, query = '', limit = 50 } = body;
  const type = normalizeContentType(body.type || body.contentType || 'movie');
  if (!username || !password) throw new Error('username e password são obrigatórios.');

  const items = await getXtreamList({ baseUrl, username, password, type });
  const results = filterResults(items, query, limit, type);
  sendJson(res, 200, { type, label: TYPE_LABELS[type], count: results.length, results });
}

async function handleItemInfo(req, res) {
  const body = await readJsonBody(req);
  const type = normalizeContentType(body.type || body.contentType || 'movie');
  const { baseUrl, username, password, streamId, seriesId } = body;
  if (!username || !password) throw new Error('username e password são obrigatórios.');

  if (type === 'movie') {
    if (!streamId) throw new Error('streamId é obrigatório para filme/VOD.');
    const info = await getVodInfo({ baseUrl, username, password, streamId });
    sendJson(res, 200, { type, raw: info });
    return;
  }

  if (type === 'series') {
    if (!seriesId) throw new Error('seriesId é obrigatório para série.');
    const info = await getSeriesInfo({ baseUrl, username, password, seriesId });
    const episodes = flattenSeriesEpisodes(info);
    sendJson(res, 200, { type, count: episodes.length, episodes, raw: info });
    return;
  }

  sendJson(res, 200, {
    type,
    message: 'Live TV normalmente não tem um get_info específico no Xtream. Use Inspecionar mídia real para abrir o stream do canal.'
  });
}

async function handleVodInfo(req, res) {
  const body = await readJsonBody(req);
  const { baseUrl, username, password, streamId } = body;
  if (!username || !password || !streamId) throw new Error('username, password e streamId são obrigatórios.');
  const info = await getVodInfo({ baseUrl, username, password, streamId });
  sendJson(res, 200, info);
}

async function makeInspectCandidates({ type, baseUrl, username, password, streamId, seriesId, episodeId, extension, mediaUrl }) {
  if (mediaUrl) return [{ label: 'URL manual', url: mediaUrl, type: 'manual' }];

  const cleanType = normalizeContentType(type || 'movie');
  if (!baseUrl || !username || !password) throw new Error('Informe mediaUrl ou baseUrl + username + password.');

  if (cleanType === 'movie') {
    if (!streamId) throw new Error('streamId é obrigatório para inspecionar filme/VOD.');
    let vodInfo = null;
    try { vodInfo = await getVodInfo({ baseUrl, username, password, streamId }); } catch {}
    const extensions = uniqueValues([extension, getExtensionFromVodInfo(vodInfo), ...MOVIE_FALLBACK_EXTENSIONS, '']);
    return uniqueCandidates(extensions.map(ext => ({
      label: ext ? `Xtream Filme/VOD .${ext}` : 'Xtream Filme/VOD sem extensão',
      url: makeMediaUrl(baseUrl, username, password, 'movie', streamId, ext),
      type: cleanType
    })));
  }

  if (cleanType === 'series') {
    const id = episodeId || streamId;
    if (!id) throw new Error('episodeId é obrigatório para inspecionar série. Carregue os episódios e selecione um episódio.');

    let episodeExtension = '';
    if (seriesId) {
      try {
        const seriesInfo = await getSeriesInfo({ baseUrl, username, password, seriesId });
        const ep = flattenSeriesEpisodes(seriesInfo).find(e => String(e.episodeId) === String(id));
        episodeExtension = ep?.containerExtension || '';
      } catch {}
    }

    const extensions = uniqueValues([extension, episodeExtension, ...SERIES_FALLBACK_EXTENSIONS, '']);
    return uniqueCandidates(extensions.map(ext => ({
      label: ext ? `Xtream Série/Episódio .${ext}` : 'Xtream Série/Episódio sem extensão',
      url: makeMediaUrl(baseUrl, username, password, 'series', id, ext),
      type: cleanType
    })));
  }

  if (cleanType === 'live') {
    if (!streamId) throw new Error('streamId é obrigatório para inspecionar Live TV.');
    const extensions = uniqueValues([extension, ...LIVE_FALLBACK_EXTENSIONS, '']);
    const candidates = [];
    for (const ext of extensions) {
      candidates.push({
        label: ext ? `Xtream LiveTV /live .${ext}` : 'Xtream LiveTV /live sem extensão',
        url: makeMediaUrl(baseUrl, username, password, 'live', streamId, ext),
        type: cleanType
      });
    }
    for (const ext of extensions) {
      candidates.push({
        label: ext ? `Xtream LiveTV genérico .${ext}` : 'Xtream LiveTV genérico sem extensão',
        url: makeGenericStreamUrl(baseUrl, username, password, streamId, ext),
        type: cleanType
      });
    }
    return uniqueCandidates(candidates);
  }

  throw new Error(`Tipo de conteúdo inválido: ${type}`);
}

async function inspectCandidate(candidate) {
  const httpInfo = await getFinalHttpInfo(candidate.url).catch(error => ({ error: error.message }));
  const probe = await runFfprobe(candidate.url);
  return { httpInfo, probe };
}

async function handleInspect(req, res) {
  const body = await readJsonBody(req);
  const {
    baseUrl,
    username,
    password,
    streamId,
    seriesId,
    episodeId,
    extension,
    mediaUrl,
    advertisedName = ''
  } = body;
  const type = mediaUrl ? 'manual' : normalizeContentType(body.type || body.contentType || 'movie');

  const candidates = await makeInspectCandidates({ type, baseUrl, username, password, streamId, seriesId, episodeId, extension, mediaUrl });
  const attempts = [];

  for (const candidate of candidates) {
    try {
      const { httpInfo, probe } = await inspectCandidate(candidate);
      const summary = summarizeProbe(probe, advertisedName, candidate.type || type);
      sendJson(res, 200, {
        type: candidate.type || type,
        inspectedUrl: redactUrl(candidate.url),
        inspectedCandidate: candidate.label,
        attempts,
        http: httpInfo,
        advertisedName,
        real: summary,
        rawProbe: probe
      });
      return;
    } catch (error) {
      attempts.push({
        candidate: candidate.label,
        url: redactUrl(candidate.url),
        error: error.message || 'Falha desconhecida.'
      });
    }
  }

  const error = new Error('ffprobe não conseguiu inspecionar a mídia em nenhuma URL candidata. Veja details para o erro real de cada tentativa.');
  error.details = attempts;
  throw error;
}

async function handleStatic(req, res, pathname) {
  let filePath = pathname === '/' ? '/index.html' : pathname;
  filePath = decodeURIComponent(filePath);
  if (filePath.includes('\0')) return sendText(res, 400, 'Bad request');

  const normalized = normalize(join(PUBLIC_DIR, filePath));
  if (!normalized.startsWith(PUBLIC_DIR)) return sendText(res, 403, 'Forbidden');

  try {
    const content = await readFile(normalized);
    const ext = extname(normalized);
    res.writeHead(200, {
      'content-type': CONTENT_TYPES[ext] || 'application/octet-stream',
      'cache-control': ext === '.html' ? 'no-store' : 'public, max-age=3600'
    });
    res.end(content);
  } catch {
    try {
      const content = await readFile(join(PUBLIC_DIR, 'index.html'));
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(content);
    } catch {
      sendText(res, 404, 'Not found');
    }
  }
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const pathname = url.pathname;

    if (pathname.startsWith('/api/')) {
      if (!requireApiToken(req)) return sendJson(res, 401, { error: 'Token inválido ou ausente.' });
      if (req.method !== 'POST' && pathname !== '/api/health') {
        return sendJson(res, 405, { error: 'Método não permitido.' });
      }
    }

    if (pathname === '/api/health') {
      return sendJson(res, 200, {
        ok: true,
        ffprobe: true,
        tokenRequired: Boolean(APP_TOKEN),
        supportedTypes: ['movie', 'series', 'live']
      });
    }

    if (pathname === '/api/search' && req.method === 'POST') return await handleSearch(req, res);
    if (pathname === '/api/item-info' && req.method === 'POST') return await handleItemInfo(req, res);
    if (pathname === '/api/vod-info' && req.method === 'POST') return await handleVodInfo(req, res); // compatibilidade com versão antiga
    if (pathname === '/api/inspect' && req.method === 'POST') return await handleInspect(req, res);

    if (pathname.startsWith('/api/')) return sendJson(res, 404, { error: 'Endpoint não encontrado.' });
    return await handleStatic(req, res, pathname);
  } catch (error) {
    const payload = { error: error.message || 'Erro interno.' };
    if (error.details) payload.details = error.details;
    if (error.stderr) payload.stderr = error.stderr;
    sendJson(res, 500, payload);
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Xtream Media Inspector listening on port ${PORT}`);
});
