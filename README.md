# dsh-web-search-tavily

Tavily-backed search provider for the DSH web capability seam (`ctx.web`).
Soft replacement for the official `web-search-deepseek` provider: registers id
`tavily` via `ctx.web.registerSearchProvider`, selected with
`searchProvider: tavily` on the `web` service (or `$DSH_WEB_SEARCH_PROVIDER`).

## Install

Bundle patch (`cordis.patch.yml` ships with the package):

```yaml
- insert:
    - id: web-search-tavily
      name: 'dsh-web-search-tavily'
      config:
        apiKeyEnv: TAVILY_API_KEY
        baseURL: !!js process.env.TAVILY_BASE_URL || "https://api.tavily.com"
        searchDepth: basic
        maxResults: 8
        recordToSession: false
```

Pin the provider on the web seam (profile layer), otherwise selection follows
the seam rules: configured-but-missing → `WEB_PROVIDER_CONFIGURED_MISSING`,
configured-but-unusable → `WEB_PROVIDER_CONFIGURED_UNAVAILABLE`, several
usable providers with no pin → `WEB_PROVIDER_AMBIGUOUS`.

```yaml
- id: web
  name: '@deepseek-ai/dsh-web'
  config:
    searchProvider: tavily
```

## Config

| Key | Default | Notes |
| --- | ------- | ----- |
| `apiKey` | — | Literal key; prefer `apiKeyEnv` so no secret lands in config files. |
| `apiKeyEnv` | `TAVILY_API_KEY` | Credential ref resolved per search (credentials service, else ambient env). |
| `baseURL` | `https://api.tavily.com` | `$TAVILY_BASE_URL` overrides when set. `/search` is appended. |
| `searchDepth` / `topic` | `basic` / `general` | Passed through to Tavily. |
| `maxResults` | `8` | 1–20. The seam additionally caps `sources[]` to `request.maxResults`. |
| `recordToSession` | `false` | See below. Writes opaque out-of-repo event types; keep OFF unless you accept them in the log. |

## Session audit trail (`recordToSession`, default OFF)

When ON, each search appends two log-only events (payloads in
`lib/types/index.d.ts`, merged into `SessionEventMap` via
`declare module '@deepseek-ai/dsh-session/types'`):

- `web/tavily-search-request` — secret-free endpoint + body, before dispatch.
- `web/tavily-search-usage` — `{ credits }` block echoed by Tavily, after success.

The merge is type-level only: the core `KNOWN_SESSION_EVENT_TYPES` set is
built from first-party packages and never contains out-of-repo types, so
`web/tavily-*` events stay opaque to first-party readers. DSH 0.2.0's
`Session.append(type, data, …surfaceOpts)` carries no `ignorable` envelope
marker — opt-in writes are plain appends — so **default OFF is the only
setting that keeps third-party session tooling from ever seeing unknown
event types**.

## Tests

Stdlib only, no dev dependencies:

```sh
node --test tests/
```

Covers: provider registration id, zero session writes by default (poisoning
regression), opt-in plain-append writes (DSH 0.2.0 `Session.append` carries
no `ignorable` envelope parameter), `available()`
gating, Tavily response mapping, and 401/429 error mapping.

## Known Limitations and Deferred Work

- Session audit stays default-OFF. The `web/tavily-*` event types are
  out-of-repo unknowns (absent from the core `KNOWN_SESSION_EVENT_TYPES`,
  unlike the first-party `web/deepseek-search-llm-request`), and DSH 0.2.0's
  `Session.append(type, data, …surfaceOpts)` offers no `ignorable` marker —
  so opt-in `recordToSession: true` writes plain opaque appends. Keep OFF
  unless you accept unknown-type entries in the log.
- No fetch provider in this package; `fetchProvider` selection is untouched.
- `available()` is a cheap local check (key present + URL parseable); it never
  validates the key against the Tavily API.

## History

- `0.1.4` — DSH `0.2.0-rc.2` compat: exact peers (mirrors
  `dsh-web-search-deepseek`), Config fields marked `.volatile()`, `apply()`
  reads sections via `.get()` accessors (settings section is now composed
  automatically — no `ctx.inject(['settings'], installSection)`), opt-in
  session writes are plain appends (0.2.0 `append` has no `ignorable` param);
  test fake uses accessor sections plus a `ctx.inject` regression guard.
- `0.1.3` — peers `^0.1.2-rc.1` (0.1.2-rc.1 harness); test fake covers the
  settings-section install (`ctx.inject`); docs: `recordToSession` opt-in is safe
  on `0.1.2-rc.1`+ harnesses.
- `0.1.2` — `declare module` session-type merge, `invariant` companion +
  `./invariant` export, `recordToSession` docs/tests/README.
- `0.1.1` — `recordToSession` (default `false`); opt-in appends pass
  `{ ignorable: true }` for forward compatibility.
- `0.1.0` — initial provider; unconditional session writes (poisoned history
  on first-party readers — do not use).
