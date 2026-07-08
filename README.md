# Xtream Media Inspector

Ferramenta simples para rodar no Render com Docker e validar a mídia real de conteúdo Xtream Codes usando `ffprobe`.

Ela permite:

- Buscar **Filmes/VOD** via `get_vod_streams`.
- Buscar **Séries** via `get_series`.
- Consultar `get_series_info`, listar episódios e inspecionar o **episode id** correto.
- Buscar **Live TV** via `get_live_streams`.
- Montar URLs reais nos formatos:
  - `/movie/user/pass/stream_id.ext`
  - `/series/user/pass/episode_id.ext`
  - `/live/user/pass/stream_id.ext`
- Rodar `ffprobe` na URL da mídia.
- Retornar resolução real, codec, bitrate, áudio, HDR, container, duração e host final após redirect.
- Tentar automaticamente extensões alternativas quando a extensão do Xtream vier vazia/errada.
- Enviar `User-Agent` também no `ffprobe`, útil para providers que bloqueiam clientes desconhecidos.

> Use apenas com providers e conteúdos que você tem autorização para acessar.

## Arquitetura

```txt
public/
  index.html
  app.js
  style.css

src/
  server.js

Dockerfile
render.yaml
```

A página é servida pelo próprio backend Node. A API usa apenas módulos nativos do Node e o binário `ffprobe`, instalado no Docker via pacote `ffmpeg`.

## Endpoints

### `POST /api/search`

Busca conteúdo no Xtream. O campo `type` aceita `movie`, `series` ou `live`.

```json
{
  "baseUrl": "http://provider.com:80",
  "username": "usuario",
  "password": "senha",
  "type": "movie",
  "query": "Avatar",
  "limit": 50
}
```

Exemplos de ações usadas por tipo:

```txt
movie  -> action=get_vod_streams
series -> action=get_series
live   -> action=get_live_streams
```

### `POST /api/item-info`

Consulta detalhes do item selecionado.

Filme/VOD:

```json
{
  "baseUrl": "http://provider.com:80",
  "username": "usuario",
  "password": "senha",
  "type": "movie",
  "streamId": 12345
}
```

Série:

```json
{
  "baseUrl": "http://provider.com:80",
  "username": "usuario",
  "password": "senha",
  "type": "series",
  "seriesId": 999
}
```

Para séries, a resposta inclui `episodes`, já normalizado com `episodeId`, temporada, episódio e extensão. Esse `episodeId` é o ID usado na URL `/series/...`, não o `seriesId`.

Live TV normalmente não tem um `get_info` equivalente. A inspeção usa o `streamId` direto do canal.

### `POST /api/inspect`

Inspeciona a mídia real com `ffprobe`.

Filme/VOD:

```json
{
  "baseUrl": "http://provider.com:80",
  "username": "usuario",
  "password": "senha",
  "type": "movie",
  "streamId": 12345,
  "extension": "mkv",
  "advertisedName": "Filme X 4K HDR"
}
```

Série/episódio:

```json
{
  "baseUrl": "http://provider.com:80",
  "username": "usuario",
  "password": "senha",
  "type": "series",
  "seriesId": 999,
  "episodeId": 777777,
  "extension": "mkv",
  "advertisedName": "Série X - S01E01 4K"
}
```

Live TV:

```json
{
  "baseUrl": "http://provider.com:80",
  "username": "usuario",
  "password": "senha",
  "type": "live",
  "streamId": 12345,
  "extension": "m3u8",
  "advertisedName": "Canal X FHD"
}
```

Modo URL manual:

```json
{
  "mediaUrl": "http://provider.com/live/usuario/senha/12345.ts",
  "advertisedName": "Canal X FHD"
}
```

## Rodar localmente

Você precisa ter Node 22+ e `ffprobe` instalado.

```bash
npm install
npm start
```

Acesse:

```txt
http://localhost:10000
```

## Rodar localmente com Docker

```bash
docker build -t xtream-media-inspector .
docker run --rm -p 10000:10000 xtream-media-inspector
```

Com token de proteção:

```bash
docker run --rm -p 10000:10000 -e APP_TOKEN="minha-chave" xtream-media-inspector
```

## Deploy no Render

1. Crie um novo **Web Service** no Render.
2. Aponte para o repositório deste projeto.
3. Escolha deploy por **Docker**.
4. Configure a variável opcional `APP_TOKEN`.
5. Faça o deploy.

Se `APP_TOKEN` estiver definido, informe o mesmo token no campo “Token da ferramenta” da interface.

## Segurança

Como a ferramenta aceita URLs informadas pelo usuário, ela inclui algumas proteções básicas contra SSRF:

- Só permite `http` e `https`.
- Bloqueia `localhost`.
- Bloqueia IPs privados por padrão.
- Mascara usuário/senha em URLs retornadas.
- Suporta `APP_TOKEN` para proteger a API quando exposta publicamente.

Se você realmente precisar inspecionar alvos privados em uma implantação isolada, defina:

```bash
ALLOW_PRIVATE_TARGETS=true
```

Não recomendo isso em uma URL pública.

## Ajustes úteis

Variáveis opcionais:

```bash
FETCH_TIMEOUT_MS=20000
FFPROBE_TIMEOUT_MS=35000
FFPROBE_ANALYZE_US=10000000
FFPROBE_PROBESIZE_BYTES=10000000
FFPROBE_RW_TIMEOUT_US=15000000
MEDIA_USER_AGENT="Mozilla/5.0 ..."
MEDIA_REFERER="http://provider.com/"
MEDIA_ORIGIN="http://provider.com"
MOVIE_FALLBACK_EXTENSIONS="mkv,mp4,avi,ts,m3u8"
SERIES_FALLBACK_EXTENSIONS="mkv,mp4,avi,ts,m3u8"
LIVE_FALLBACK_EXTENSIONS="m3u8,ts"
```

Se aparecer `ffprobe falhou com código 1`, a interface mostra no JSON bruto o erro real retornado pelo `ffprobe` e cada URL candidata testada. Em geral, isso revela se foi `403`, `404`, extensão errada, redirect problemático, bloqueio por `User-Agent`, playlist HLS inválida ou timeout.

Para LiveTV, alguns canais podem demorar mais para entregar dados suficientes ao `ffprobe`. Se necessário, aumente `FFPROBE_TIMEOUT_MS`, `FFPROBE_ANALYZE_US` e `FFPROBE_PROBESIZE_BYTES`.

## Observações

- A inspeção depende do servidor permitir leitura parcial/streaming suficiente para o `ffprobe`.
- Séries precisam de seleção de episódio, porque o stream real usa `episodeId`.
- LiveTV pode não retornar duração/tamanho, porque é transmissão contínua.
- HDR nem sempre é simples de detectar; a ferramenta procura sinais como `smpte2084`, `arib-std-b67`, `bt2020` e side data de mastering display/content light level.
- Bitrate pode vir ausente quando o provider não informa ou quando o container não expõe esse metadado facilmente.
