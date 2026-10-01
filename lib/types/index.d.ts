/**
 * Type declarations for `dsh-web-search-tavily`.
 *
 * Mirrors the official `web-search-deepseek` pattern
 * (`packages/web/web-search-deepseek/src/provider.ts`): payload interfaces
 * plus a `declare module '@deepseek-ai/dsh-session/types'` merge so
 * misspelled event types or malformed payloads fail at compile time.
 *
 * NOTE: this merge is type-level only. The core `KNOWN_SESSION_EVENT_TYPES`
 * set is built from first-party packages and never includes out-of-repo
 * types, so `web/tavily-*` events stay opaque to first-party readers.
 * DSH 0.2.0's `Session.append` carries no `ignorable` envelope marker,
 * so the plugin keeps `recordToSession` OFF by default (see README).
 */
export declare const TAVILY_PROVIDER_ID = "tavily";
export declare const TAVILY_DEFAULT_BASE_URL = "https://api.tavily.com";
export declare const WEB_SEARCH_TAVILY_SETTINGS_NAMESPACE: string;
export declare const Config: any;

/** Secret-free Tavily `/search` request recorded immediately before dispatch. */
export interface TavilySearchRequest {
  /** Fully resolved `/search` endpoint. */
  readonly endpoint: string;
  /** Exact JSON body sent to Tavily (no secret — the key travels in headers). */
  readonly body: {
    readonly query: string;
    readonly search_depth: string;
    readonly max_results: number;
    readonly topic: string;
    readonly include_answer: boolean | string;
    readonly include_raw_content: boolean | string;
    readonly include_images: boolean;
    readonly time_range?: string;
    readonly chunks_per_source?: number;
    readonly include_usage: true;
    readonly auto_parameters: false;
  };
}

/** Tavily usage block echoed by the API when `include_usage` is set. */
export interface TavilySearchUsage {
  /** Credits consumed by the request (observed shape: `{ credits: 1 }`). */
  readonly credits?: number;
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Secret-free Tavily search request recorded before dispatch. */
    'web/tavily-search-request': TavilySearchRequest;
    /** Tavily usage block recorded after a successful search. */
    'web/tavily-search-usage': TavilySearchUsage;
  }
}

export declare class TavilySearchProvider {
  id: string;
  available(): boolean;
  search(request: any, signal?: AbortSignal): Promise<any>;
}
export declare const name = "web-search-tavily";
export declare const inject: string[];
export declare function apply(ctx: any, config: any): void;
