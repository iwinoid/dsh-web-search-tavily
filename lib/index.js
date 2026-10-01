import z from "@deepseek-ai/schemastery";
import { credentialRef } from "@deepseek-ai/dsh-credentials";
import { launchEnvironmentOf } from "@deepseek-ai/dsh-launch-environment";
import { WebError } from "@deepseek-ai/dsh-web";

const TAVILY_PROVIDER_ID = "tavily";
const TAVILY_DEFAULT_BASE_URL = "https://api.tavily.com";
const DEFAULT_API_KEY_ENV = "TAVILY_API_KEY";
const USER_AGENT = "deepseek-harness-tavily/0.1.4";

const Config = z.object({
  apiKey: z.string().role("secret").volatile(),
  apiKeyEnv: z.string().role("credential-ref").default(DEFAULT_API_KEY_ENV).volatile(),
  baseURL: z.string().volatile(),
  searchDepth: z.string().default("basic").volatile(),
  topic: z.string().default("general").volatile(),
  maxResults: z.number().step(1).min(1).max(20).default(8).volatile(),
  includeAnswer: z.union([z.boolean(), z.string()]).default(false).volatile(),
  includeRawContent: z.union([z.boolean(), z.string()]).default(false).volatile(),
  timeRange: z.string().volatile(),
  includeImages: z.boolean().default(false).volatile(),
  chunksPerSource: z.number().step(1).min(1).max(5).volatile(),
  // Session audit trail switch. Default OFF: out-of-repo session event
  // types (web/tavily-*) are unknown to the core KNOWN_SET (unlike the
  // first-party web/deepseek-search-llm-request), so writing them is
  // opt-in only. On DSH 0.2.0 Session.append carries no ignorable envelope
  // parameter (its rest opts are surface-only: sourceEventSeqs/surfaceOp),
  // so opt-in writes are plain appends of opaque log-only events.
  recordToSession: z.boolean().default(false).volatile(),
});

const WEB_SEARCH_TAVILY_SETTINGS_NAMESPACE = "web-search-tavily";

function isPositiveInteger(value) {
  return Number.isInteger(value) && value > 0;
}

function isAbortError(error) {
  return error instanceof DOMException && error.name === "AbortError";
}

function throwIfSearchAborted(signal) {
  if (signal?.aborted === true) throw searchAborted(signal);
}

function searchAborted(signal, fallback) {
  return new WebError("Tavily search aborted", "WEB_ABORTED", { cause: signal?.aborted === true ? signal.reason : fallback });
}

function abortable(operation, signal) {
  if (signal === void 0) return operation;
  if (signal.aborted) return Promise.reject(searchAborted(signal));
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(searchAborted(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then((value) => {
      signal.removeEventListener("abort", onAbort);
      resolve(value);
    }, (error) => {
      signal.removeEventListener("abort", onAbort);
      reject(new Error(String(error).replace(/^Error: /u, ""), { cause: error }));
    });
  });
}

function mapTavilyResponse(json, maxResults) {
  const results = json.results ?? [];
  const seen = new Set();
  const sources = [];
  for (const r of results) {
    if (!r.url || seen.has(r.url)) continue;
    seen.add(r.url);
    // Tavily content is snippet; raw_content if includeRawContent
    const snippet = r.content ?? "";
    const publishedAt = r.published_date ?? r.publishedAt ?? undefined;
    sources.push({
      url: r.url,
      ...(r.title ? { title: r.title } : {}),
      ...(snippet ? { snippet } : {}),
      ...(publishedAt ? { publishedAt } : {}),
    });
    if (maxResults !== undefined && sources.length >= maxResults) break;
  }
  const content = json.answer ?? undefined;
  return {
    ...(content ? { content } : {}),
    sources,
    truncated: false,
  };
}

class TavilySearchProvider {
  resolveOptions;
  id = TAVILY_PROVIDER_ID;
  constructor(resolveOptions) {
    this.resolveOptions = resolveOptions;
  }
  available() {
    const options = this.resolveOptions();
    return ((options.apiKey?.length ?? 0) > 0 || options.resolveApiKey !== undefined) && URL.canParse(options.baseURL);
  }
  async search(request, signal) {
    const options = this.resolveOptions();
    const apiKey = await this.apiKey(options, signal);
    throwIfSearchAborted(signal);
    const endpoint = `${options.baseURL.replace(/\/$/, "")}/search`;
    const body = {
      query: request.query,
      search_depth: options.searchDepth ?? "basic",
      max_results: request.maxResults ?? options.maxResults ?? 8,
      topic: options.topic ?? "general",
      include_answer: options.includeAnswer ?? false,
      include_raw_content: options.includeRawContent ?? false,
      include_images: options.includeImages ?? false,
      ...(options.timeRange ? { time_range: options.timeRange } : {}),
      ...(options.chunksPerSource ? { chunks_per_source: options.chunksPerSource } : {}),
      // ask for usage to allow tracking
      include_usage: true,
      auto_parameters: false,
    };

    options.recordRequest?.({
      endpoint,
      body,
    });

    throwIfSearchAborted(signal);
    let response;
    try {
      response = await fetch(endpoint, {
        method: "POST",
        redirect: "error",
        headers: {
          "Authorization": `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          "Accept": "application/json",
          "User-Agent": USER_AGENT,
        },
        body: JSON.stringify(body),
        ...(signal !== undefined ? { signal } : {}),
      });
    } catch (error) {
      if (signal?.aborted === true || isAbortError(error)) throw searchAborted(signal, error);
      throw new WebError(`Tavily search request failed: ${String(error)}`, "WEB_PROVIDER_ERROR", { cause: error });
    }

    if (!response.ok) {
      let message = `Tavily API error (HTTP ${response.status})`;
      try {
        const parsed = await response.json();
        const detail = parsed.detail?.error ?? parsed.error?.message ?? parsed.message ?? parsed.detail ?? "";
        if (detail && detail.length > 0) message = detail;
        else if (parsed.error && typeof parsed.error === "string") message = parsed.error;
      } catch (e) {
        if (signal?.aborted === true || isAbortError(e)) throw searchAborted(signal, e);
      }
      // Map 429 insufficient credits to credential-like message for user
      if (response.status === 429) {
        throw new WebError(`${message} (Tavily credits exhausted — resets 1st of month, or upgrade plan)`, "WEB_PROVIDER_ERROR");
      }
      if (response.status === 401) {
        throw new WebError(`${message} (check TAVILY_API_KEY)`, "WEB_PROVIDER_CREDENTIAL_MISSING");
      }
      throw new WebError(message, "WEB_PROVIDER_ERROR");
    }

    try {
      const json = await response.json();
      // Record usage if present
      if (json.usage && options.recordUsage) {
        options.recordUsage(json.usage);
      }
      return mapTavilyResponse(json, request.maxResults);
    } catch (error) {
      if (signal?.aborted === true || isAbortError(error)) throw searchAborted(signal, error);
      if (error instanceof WebError) throw error;
      throw new WebError(`Tavily returned unprocessable response: ${String(error)}`, "WEB_PROVIDER_ERROR", { cause: error });
    }
  }

  async apiKey(options, signal) {
    throwIfSearchAborted(signal);
    if (options.apiKey !== undefined && options.apiKey.length > 0) return options.apiKey;
    let resolved;
    try {
      resolved = await abortable(options.resolveApiKey?.() ?? Promise.resolve(undefined), signal);
    } catch (error) {
      if (signal?.aborted === true || isAbortError(error)) throw searchAborted(signal, error);
      throw new WebError(`Tavily credential resolution failed: ${String(error)}`, "WEB_PROVIDER_ERROR", { cause: error });
    }
    if (resolved !== undefined && resolved.length > 0) return resolved;
    throw new WebError(`Tavily search has no API key for "${options.apiKeyEnv ?? DEFAULT_API_KEY_ENV}"; store it via DSH credentials (Settings > web-search-tavily) or export TAVILY_API_KEY, or set literal apiKey in config`, "WEB_PROVIDER_CREDENTIAL_MISSING");
  }
}

function resolveOptions(ctx, config) {
  const apiKeyEnv = credentialRef(config.apiKeyEnv ?? DEFAULT_API_KEY_ENV);
  const literalApiKey = config.apiKey !== undefined && config.apiKey.length > 0 ? config.apiKey : undefined;
  return {
    ...(literalApiKey === undefined ? {} : { apiKey: literalApiKey }),
    resolveApiKey: async () => {
      const credentials = ctx.get("credentials");
      if (credentials !== undefined) return (await credentials.resolve(apiKeyEnv))?.value;
      const ambient = launchEnvironmentOf(ctx).get(apiKeyEnv);
      return ambient !== undefined && ambient.value.length > 0 ? ambient.value : undefined;
    },
    apiKeyEnv,
    baseURL: config.baseURL ?? launchEnvironmentOf(ctx).get("TAVILY_BASE_URL")?.value ?? TAVILY_DEFAULT_BASE_URL,
    searchDepth: config.searchDepth ?? "basic",
    topic: config.topic ?? "general",
    maxResults: config.maxResults ?? 8,
    includeAnswer: config.includeAnswer ?? false,
    includeRawContent: config.includeRawContent ?? false,
    timeRange: config.timeRange,
    includeImages: config.includeImages ?? false,
    chunksPerSource: config.chunksPerSource,
    recordToSession: config.recordToSession ?? false,
    recordRequest: (request) => {
      // Session audit is opt-in (see recordToSession): these out-of-repo
      // event types are unknown to the core KNOWN_SET. DSH 0.2.0's
      // Session.append(type, data, ...surfaceOpts) carries no ignorable
      // envelope parameter, so opt-in writes are plain opaque appends.
      if (config.recordToSession !== true) return;
      ctx.get("agents")?.currentInitiator()?.session.append("web/tavily-search-request", request);
    },
    recordUsage: (usage) => {
      // Same opt-in guard as recordRequest above.
      if (config.recordToSession !== true) return;
      ctx.get("agents")?.currentInitiator()?.session.append("web/tavily-search-usage", usage);
    },
  };
}

const name = "web-search-tavily";
const inject = ["web"];

function apply(ctx, config) {
  // DSH 0.2.0: the settings section is composed from the exported Config
  // automatically — no ctx.inject(['settings'], installSection) call.
  // Config fields are accessor objects; snapshot them per operation so one
  // search never mixes two sections (mirrors web-search-deepseek).
  ctx.web.registerSearchProvider(new TavilySearchProvider(() => resolveOptions(ctx, {
    apiKey: config.apiKey.get(),
    apiKeyEnv: config.apiKeyEnv.get(),
    baseURL: config.baseURL.get(),
    searchDepth: config.searchDepth.get(),
    topic: config.topic.get(),
    maxResults: config.maxResults.get(),
    includeAnswer: config.includeAnswer.get(),
    includeRawContent: config.includeRawContent.get(),
    timeRange: config.timeRange.get(),
    includeImages: config.includeImages.get(),
    chunksPerSource: config.chunksPerSource.get(),
    recordToSession: config.recordToSession.get(),
  })));
}

export { Config, WEB_SEARCH_TAVILY_SETTINGS_NAMESPACE, TAVILY_PROVIDER_ID, TAVILY_DEFAULT_BASE_URL, TavilySearchProvider, name, inject, apply };
