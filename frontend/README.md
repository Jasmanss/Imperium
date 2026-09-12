# Imperium phone app

Next.js 16 (App Router) + React 19 + TypeScript + Tailwind v4, built as a
**static export** that the FastAPI backend serves at `/app`, on the same origin
as the API. Screens: Command, Activity, Audit, Stats, Settings.

```bash
npm ci
npm run dev        # dev server on :3000, proxies API paths to http://127.0.0.1:8000
npm run build      # static export into ./out — the backend serves this
npm run lint
npm run typecheck
npm test
```

The backend serves `out/` at `/app` with `basePath: "/app"` and
`trailingSlash: true`, so a route lives at `/app/audit/` and its file is
`out/audit/index.html`. Without a build, `/app` serves a page telling you to run
`npm run build`.

## Constraints this app is built under

- **Same origin only.** Every request uses a relative path (`/text-command`,
  `/events`, …). The dev proxy exists so `npm run dev` behaves the same way.
- **Strict CSP.** Each page is served with `script-src 'self'` plus the sha256
  hashes of that page's inline scripts — no `unsafe-inline`, no `unsafe-eval`.
  So: no `dangerouslySetInnerHTML` (ESLint enforces `react/no-danger`), no
  inline `<script>` of our own, no `eval`/`new Function`, no third-party
  scripts, fonts, or CDNs.
- **The pairing token** arrives once in the URL fragment (`/app#token=…`), is
  stored in `localStorage` under `imperium_token`, is sent as
  `Authorization: Bearer`, and never appears in a URL, log, or error message.
- **The event stream** uses `fetch` rather than `EventSource`, because
  `EventSource` cannot send an Authorization header. One shared connection for
  the whole app, with backoff and `Last-Event-ID` resume.
- **Minimal dependencies.** No UI kit, chart, icon, or data-fetching library.
