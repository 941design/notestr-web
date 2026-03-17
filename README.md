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

The build output in `out/` is plain HTML/JS/CSS served under the `/notestr/` base path (configured via `basePath` in `next.config.ts`). Deploy to any static host.

```sh
make deploy         # FTP upload to hosteurope
```

No SPA rewrite rules are needed — Next.js static export generates an `index.html` per route.

## Test

```sh
npm test            # vitest
```
