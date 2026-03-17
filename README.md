# notestr

Encrypted task manager on Nostr with MLS groups.

## Development

```sh
npm install
npm run relay:up    # start local strfry relay (Docker)
npm run dev         # start Next.js dev server on port 3000
```

## Build

```sh
npm run build       # static export to out/
```

`next build` with `output: "export"` produces a fully static site in `out/`. No Node.js server required.

## Deployment

The build output in `out/` is plain HTML/JS/CSS. Set `NEXT_PUBLIC_BASE_PATH` in `.env` to serve under a subdirectory (e.g. `/notestr`), or leave it empty for root. Deploy to any static host.

```sh
make deploy         # FTP upload to hosteurope
```

No SPA rewrite rules are needed — Next.js static export generates an `index.html` per route.

## Test

```sh
npm test            # unit tests + static export verification
npm run test:unit   # vitest only
```
