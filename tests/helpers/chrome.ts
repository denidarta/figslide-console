import * as fs from "node:fs";

const STANDARD_PATHS = [
	"/opt/google/chrome/chrome",
	"/usr/bin/google-chrome",
	"/usr/bin/google-chrome-stable",
	"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
	"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
	"C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
];

/** True when DeckSession.open() can find a Chrome: DECK_IMPORT_CHROME_PATH, or an install in a standard place. */
export function chromeAvailable(): boolean {
	const fromEnv = process.env.DECK_IMPORT_CHROME_PATH;
	if (fromEnv) return fs.existsSync(fromEnv);
	return STANDARD_PATHS.some((p) => fs.existsSync(p));
}

/**
 * `describe` for suites that drive real Chrome. Without Chrome the suite is skipped
 * and one line says why, so a bare environment fails nothing but hides nothing.
 */
export function describeWithChrome(name: string, fn: () => void): void {
	if (chromeAvailable()) {
		describe(name, fn);
		return;
	}
	console.warn(
		`[skipped] "${name}" needs Chrome. Install Google Chrome or set DECK_IMPORT_CHROME_PATH to a Chrome executable.`,
	);
	describe.skip(name, fn);
}
