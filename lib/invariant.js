/**
 * Package-owned invariant companion for `dsh-web-search-tavily`.
 * @module dsh-web-search-tavily/invariant
 *
 * Mirrors `@deepseek-ai/dsh-web-search-deepseek/invariant`: the package emits
 * pre-dispatch log events but owns no later authoritative dispatch event to
 * relate them to, so there is no runtime relation to check. Kept as a real
 * companion (rather than omitted) so the `verify-built-package-invariants`
 * contract holds: named `name`, `inject` containing `invariants`, function
 * `apply`, and no default export.
 */

/** Cordis companion plugin name. */
export const name = 'web-search-tavily-invariant';
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants'];

/**
 * No runtime invariant: the package emits pre-dispatch audit events
 * (`web/tavily-search-request`, `web/tavily-search-usage`, both opt-in via
 * `recordToSession` and otherwise never written) but owns no later
 * authoritative dispatch event to relate them to.
 */
const install = () => {};

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx) => Promise.resolve(ctx.invariants.register('dsh-web-search-tavily', install));
