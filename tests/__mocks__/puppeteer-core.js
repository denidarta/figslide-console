/**
 * CJS shim for puppeteer-core (Jest).
 *
 * puppeteer-core is ESM-only and Jest's CJS loader cannot parse it. Node's own
 * require() (Node >= 22.12) can load ESM, but Jest replaces require("node:module")
 * with its own createRequire, so fetch the real one via process.getBuiltinModule.
 */
const { createRequire } = process.getBuiltinModule("node:module");

module.exports = createRequire(__filename)("puppeteer-core");
