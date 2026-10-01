// Minimal chainable stand-in for schemastery: every property/call returns the
// same chain object. Sufficient for module-level `Config = z.object({...})`.
const chain = new Proxy(function () {}, {
  get: () => chain,
  apply: () => chain,
});
export default chain;
