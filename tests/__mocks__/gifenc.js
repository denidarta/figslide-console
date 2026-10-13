/**
 * CJS shim for gifenc (Jest).
 *
 * Node ESM can only see gifenc's API through the default import (module.exports), so src does
 * `import gifenc from "gifenc"`. Jest's CJS interop would hand that import the package's own
 * `default` (the GIFEncoder function), so expose the real module as the default instead.
 * createRequire bypasses moduleNameMapper, which would otherwise map this require back here.
 */
const { createRequire } = process.getBuiltinModule("node:module");

module.exports = {
	__esModule: true,
	default: createRequire(__filename)("gifenc"),
};
