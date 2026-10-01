// node:test support hook (stdlib only): the built plugin imports four
// harness bare specifiers that only resolve inside a booted dsh Loader.
// Map them to local stubs so `node --test` can exercise the real built
// `lib/index.js` without harness dev dependencies.
const STUBS = {
  '@deepseek-ai/schemastery': './stubs/schemastery.mjs',
  '@deepseek-ai/dsh-credentials': './stubs/credentials.mjs',
  '@deepseek-ai/dsh-launch-environment': './stubs/launch-env.mjs',
  '@deepseek-ai/dsh-web': './stubs/web.mjs',
};
export async function resolve(specifier, context, next) {
  if (specifier in STUBS) {
    return { url: new URL(STUBS[specifier], import.meta.url).href, shortCircuit: true };
  }
  return next(specifier, context);
}
