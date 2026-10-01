// Preloaded via `node --import ./tests/setup.mjs --test tests/`.
// Registers the bare-specifier stub hook before the test files import lib/.
import { register } from 'node:module';
register('./resolve-hook.mjs', import.meta.url);
