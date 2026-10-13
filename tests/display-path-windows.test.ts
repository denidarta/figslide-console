// The Windows half of component-doc-report-3's displayPath tests: run them with win32 path rules, so the
// "\\" separators Windows produces are caught on any CI OS.
jest.mock("node:path", () => jest.requireActual("node:path").win32);

import { displayPath } from "../src/core/design-code-tools";

describe("displayPath with Windows path rules", () => {
	it("returns repo-relative paths with forward slashes", () => {
		expect(displayPath("/Users/robin/work/ds/src/tabs/Tabs.tsx", "/Users/robin/work/ds")).toBe("src/tabs/Tabs.tsx");
		expect(displayPath("C:\\Users\\robin\\work\\ds\\src\\tabs\\Tabs.tsx", "C:\\Users\\robin\\work\\ds")).toBe("src/tabs/Tabs.tsx");
	});

	it("reduces a path outside the root to its file name", () => {
		expect(displayPath("/Users/robin/elsewhere/Tabs.tsx", "/Users/robin/work/ds")).toBe("Tabs.tsx");
		expect(displayPath("C:\\Users\\robin\\work\\ds\\src\\Tabs.tsx")).toBe("Tabs.tsx");
		expect(displayPath("D:\\other\\Tabs.tsx", "C:\\Users\\robin\\work\\ds")).toBe("Tabs.tsx");
	});
});
