# Xtream Media Inspector

Ferramenta simples para rodar no Render com Docker.

Ela permite:

- Buscar filmes em um painel compatível com Xtream Codes (`get_vod_streams`).
- Selecionar um resultado.
- Consultar `get_vod_info`.
- Montar a URL real do VOD.
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

Busca filmes no Xtream.

```json
{
  "baseUrl": "http://provider.com:80",
  "username": "usuario",
  "password": "senha",
  "query": "Avatar",
  "limit": 50
}
```

### `POST /api/vod-info`

Consulta detalhes do VOD.

```json
{
  "baseUrl": "http://provider.com:80",
  "username": "usuario",
  "password": "senha",
  "streamId": 12345
}
```

### `POST /api/inspect`

Inspeciona a mídia real com `ffprobe`.

Modo Xtream:

```json
{
  "baseUrl": "http://provider.com:80",
  "username": "usuario",
  "password": "senha",
  "streamId": 12345,
  "extension": "mkv",
  "advertisedName": "Filme X 4K HDR"
}
```

Modo URL manual:

```json
{
  "mediaUrl": "http://provider.com/movie/usuario/senha/12345.mkv",
  "advertisedName": "Filme X 4K HDR"
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
FFPROBE_TIMEOUT_MS=30000
FFPROBE_ANALYZE_US=10000000
FFPROBE_PROBESIZE_BYTES=10000000
FFPROBE_RW_TIMEOUT_US=15000000
MEDIA_USER_AGENT="Mozilla/5.0 ..."
MEDIA_REFERER="http://provider.com/"
MEDIA_ORIGIN="http://provider.com"
INSPECT_FALLBACK_EXTENSIONS="mkv,mp4,avi,ts,m3u8"
```

Se aparecer `ffprobe falhou com código 1`, a interface agora mostra no JSON bruto o erro real retornado pelo `ffprobe` e cada URL candidata testada. Em geral, isso revela se foi `403`, `404`, extensão errada, redirect problemático, bloqueio por `User-Agent`, playlist HLS inválida ou timeout.

Para providers lentos, aumente `FFPROBE_TIMEOUT_MS`, `FFPROBE_ANALYZE_US` e `FFPROBE_PROBESIZE_BYTES`.

Para evitar leitura excessiva, mantenha esses valores conservadores.

## Observações

- A inspeção depende do servidor permitir leitura parcial/streaming suficiente para o `ffprobe`.
- Alguns HLS/M3U8 podem exigir mais tempo de análise.
- HDR nem sempre é simples de detectar; a ferramenta procura sinais como `smpte2084`, `arib-std-b67`, `bt2020` e side data de mastering display/content light level.
- Bitrate pode vir ausente quando o provider não informa ou quando o container não expõe esse metadado facilmente.
