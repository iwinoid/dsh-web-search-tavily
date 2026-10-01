// Regression suite for dsh-web-search-tavily (run: `node --test tests/`).
// Covers the SessionFormatUnsupportedError poisoning bug and the web-seam
// basics that decide "plugin installed but not effective".
//
// Loaded with `--import ./tests/setup.mjs` so the five harness bare
// specifiers resolve to `./stubs/*` (see ./resolve-hook.mjs).
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as plugin from '../lib/index.js';
import * as invariant from '../lib/invariant.js';

const TAVILY_OK = {
  results: [
    { url: 'https://a.test/1', title: 'A', content: 'snippet A', published_date: '2026-01-01' },
    { url: 'https://a.test/1', title: 'A dup', content: 'dup must be dropped' },
    { url: 'https://b.test/2', title: 'B', content: 'snippet B' },
    { url: 'https://c.test/3' },
  ],
  usage: { credits: 1 },
};

let fetchCalls;
function stubFetch(handler) {
  fetchCalls = [];
  globalThis.fetch = async (url, init) => {
    fetchCalls.push({ url, init });
    return handler(url, init);
  };
}
const jsonRes = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** Wrap a plain object in DSH 0.2.0 Config accessors ({ get() }). */
function section(values) {
  return new Proxy(
    {},
    {
      get: (_t, k) => ({ get: () => values[k] }),
    },
  );
}

/** Fake harness ctx: captures the registered provider and session appends. */
function makeCtx() {
  const appends = [];
  const session = {
    append(type, data, opts) {
      appends.push({ type, data, opts });
      return { type };
    },
  };
  const registered = [];
  const ctx = {
    get: (name) => (name === 'agents' ? { currentInitiator: () => ({ session }) } : undefined),
    // DSH 0.2.0 composes the settings section from the exported Config
    // automatically; apply() must NOT call ctx.inject(['settings'], …).
    // Keep a guard stub so a regression back to installSection throws here.
    inject: () => {
      throw new Error('apply() must not use ctx.inject on DSH 0.2.0');
    },
    web: {
      registerSearchProvider(p) {
        registered.push(p);
        return () => {};
      },
    },
  };
  return { ctx, session, appends, registered };
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('plugin shape (packages/AGENTS.md function-plugin contract)', () => {
  it('has named exports only, no default export', () => {
    assert.equal(plugin.name, 'web-search-tavily');
    assert.deepEqual(plugin.inject, ['web']);
    assert.equal(typeof plugin.apply, 'function');
    assert.ok(!('default' in plugin), 'default export would drop the namespace');
  });

  it('invariant companion passes the verify-built-package-invariants contract', () => {
    assert.equal(invariant.name, 'web-search-tavily-invariant');
    assert.ok(invariant.inject.includes('invariants'));
    assert.equal(typeof invariant.apply, 'function');
    assert.ok(!('default' in invariant));
  });
});

describe('provider registration', () => {
  it('registers id "tavily" (the value `searchProvider: tavily` must pin)', () => {
    const { ctx, registered } = makeCtx();
    plugin.apply(ctx, section({ apiKey: 'k' }));
    assert.equal(registered.length, 1);
    assert.equal(registered[0].id, 'tavily');
  });
});

describe('session audit (poisoning regression)', () => {
  beforeEach(() => {
    stubFetch(() => jsonRes(TAVILY_OK));
  });

  it('default config performs ZERO session appends', async () => {
    const { ctx, registered, appends } = makeCtx();
    plugin.apply(ctx, section({ apiKey: 'k' }));
    const res = await registered[0].search({ query: 'q' });
    assert.equal(res.sources.length, 3);
    assert.deepEqual(
      appends,
      [],
      'any web/tavily-* write poisons history on first-party readers (SessionFormatUnsupportedError)',
    );
    // Sanity: the request really went to Tavily, audit was skipped, not the search.
    assert.equal(fetchCalls.length, 1);
    assert.match(fetchCalls[0].url, /api\.tavily\.com\/search/);
  });

  it('recordToSession:true writes both events as plain appends (0.2.0 has no ignorable envelope param)', async () => {
    const { ctx, registered, appends } = makeCtx();
    plugin.apply(ctx, section({ apiKey: 'k', recordToSession: true }));
    await registered[0].search({ query: 'q' });
    assert.equal(appends.length, 2);
    assert.equal(appends[0].type, 'web/tavily-search-request');
    assert.equal(appends[1].type, 'web/tavily-search-usage');
    assert.equal(appends[0].opts, undefined);
    assert.equal(appends[1].opts, undefined);
    assert.equal(appends[0].data.body.query, 'q');
    assert.deepEqual(appends[1].data, { credits: 1 });
  });
});

describe('available() gating (WEB_PROVIDER_* triage)', () => {
  it('stays usable when only a resolver exists (key failure surfaces at search, not here)', async () => {
    // Mirrors the official deepseek provider: available() is true while a
    // resolver is present; a missing key rejects inside search() with
    // WEB_PROVIDER_CREDENTIAL_MISSING before any fetch. This is the
    // WEB_PROVIDER_CONFIGURED_UNAVAILABLE triage path.
    stubFetch(() => {
      throw new Error('fetch must not be reached without a key');
    });
    const { ctx, registered } = makeCtx();
    plugin.apply(ctx, section({}));
    assert.equal(registered[0].available(), true);
    await assert.rejects(registered[0].search({ query: 'q' }), /TAVILY_API_KEY/);
    assert.equal(fetchCalls.length, 0);
  });

  it('false with an unparseable baseURL even when keyed', () => {
    const { ctx, registered } = makeCtx();
    plugin.apply(ctx, section({ apiKey: 'k', baseURL: '::not-a-url::' }));
    assert.equal(registered[0].available(), false);
  });

  it('true with a literal key and the default endpoint', () => {
    const { ctx, registered } = makeCtx();
    plugin.apply(ctx, section({ apiKey: 'k' }));
    assert.equal(registered[0].available(), true);
  });
});

describe('Tavily response mapping', () => {
  beforeEach(() => {
    stubFetch(() => jsonRes(TAVILY_OK));
  });

  it('dedupes by url, joins content->snippet and published_date->publishedAt', async () => {
    const { ctx, registered } = makeCtx();
    plugin.apply(ctx, section({ apiKey: 'k' }));
    const res = await registered[0].search({ query: 'q' });
    assert.deepEqual(res.sources[0], {
      url: 'https://a.test/1',
      title: 'A',
      snippet: 'snippet A',
      publishedAt: '2026-01-01',
    });
    assert.equal(res.truncated, false);
  });

  it('honours request.maxResults', async () => {
    const { ctx, registered } = makeCtx();
    plugin.apply(ctx, section({ apiKey: 'k' }));
    const res = await registered[0].search({ query: 'q', maxResults: 1 });
    assert.equal(res.sources.length, 1);
  });
});

describe('error mapping', () => {
  it('401 surfaces a credential-missing code', async () => {
    stubFetch(() => jsonRes({ message: 'unauthorized' }, 401));
    const { ctx, registered } = makeCtx();
    plugin.apply(ctx, section({ apiKey: 'bad' }));
    await assert.rejects(registered[0].search({ query: 'q' }), (err) => {
      assert.equal(err.code, 'WEB_PROVIDER_CREDENTIAL_MISSING');
      return true;
    });
  });

  it('429 mentions exhausted credits', async () => {
    stubFetch(() => jsonRes({ detail: 'usage limit' }, 429));
    const { ctx, registered } = makeCtx();
    plugin.apply(ctx, section({ apiKey: 'k' }));
    await assert.rejects(registered[0].search({ query: 'q' }), (err) => {
      assert.equal(err.code, 'WEB_PROVIDER_ERROR');
      assert.match(err.message, /credits exhausted/);
      return true;
    });
  });

  it('missing key raises before any fetch', async () => {
    stubFetch(() => jsonRes(TAVILY_OK));
    const { ctx, registered } = makeCtx();
    plugin.apply(ctx, section({}));
    await assert.rejects(registered[0].search({ query: 'q' }), /TAVILY_API_KEY/);
    assert.equal(fetchCalls.length, 0);
  });
});
