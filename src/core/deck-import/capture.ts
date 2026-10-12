import { createReadStream } from "node:fs";
import * as fs from "node:fs/promises";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as path from "node:path";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import type { RawAnim, RawNode } from "./types.js";
import {
	deckReady,
	prepareDeck,
	readSlideMeta,
	settleSlide,
	walkSlide,
} from "./walker.page.js";

const SIZE = { width: 1920, height: 1080 };

const CONTENT_TYPES: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".mjs": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".webp": "image/webp",
	".gif": "image/gif",
	".svg": "image/svg+xml",
	".woff2": "font/woff2",
	".woff": "font/woff",
	".ttf": "font/ttf",
};

/**
 * Serves `srcDir` (read-only, GET/HEAD) on a random loopback port. The .dc.html runtime fetch()es
 * its own deck file and components, which file:// origins block, so decks are loaded over http.
 */
async function serveDir(srcDir: string) {
	const root = path.resolve(srcDir);
	let origin = "";
	const server = http.createServer(async (req, res) => {
		const fail = (code: number) => {
			res.writeHead(code, { "Content-Type": "text/plain" }).end();
		};
		try {
			if (req.method !== "GET" && req.method !== "HEAD") return fail(405);
			if (`http://${req.headers.host}` !== origin) return fail(403); // not our loopback origin
			const rel = decodeURIComponent(new URL(req.url ?? "/", origin).pathname);
			const file = path.resolve(root, `.${rel}`);
			if (file !== root && !file.startsWith(root + path.sep)) return fail(403);
			const st = await fs.stat(file);
			if (!st.isFile()) return fail(404);
			res.writeHead(200, {
				"Content-Type":
					CONTENT_TYPES[path.extname(file).toLowerCase()] ??
					"application/octet-stream",
				"Content-Length": st.size,
			});
			if (req.method === "HEAD") res.end();
			else createReadStream(file).pipe(res);
		} catch {
			fail(404);
		}
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	return {
		origin,
		close: () =>
			new Promise<void>((resolve) => {
				server.close(() => resolve());
				server.closeAllConnections();
			}),
	};
}

/** One headless Chrome page rendering one `.dc.html` deck, 1:1 (deck-stage `noscale`). */
export class DeckSession {
	private constructor(
		readonly page: Page,
		private readonly browser: Browser,
		private readonly server: { origin: string; close(): Promise<void> },
		private readonly count: number,
	) {}

	static async open(srcDir: string, deckFile: string): Promise<DeckSession> {
		const server = await serveDir(srcDir);
		let browser: Browser | undefined;
		try {
			const executablePath = process.env.DECK_IMPORT_CHROME_PATH;
			browser = await puppeteer.launch({
				headless: true,
				...(executablePath ? { executablePath } : { channel: "chrome" }),
			});
			const page = await browser.newPage();
			// tsx/esbuild (keepNames) wraps named inner functions in __name(); the page has no such helper.
			await page.evaluateOnNewDocument("globalThis.__name = (f) => f");
			await page.setViewport({ ...SIZE, deviceScaleFactor: 1 });
			await page.emulateMediaFeatures([
				{ name: "prefers-reduced-motion", value: "no-preference" },
			]);
			const url = `${server.origin}/${deckFile.split(/[\\/]/).map(encodeURIComponent).join("/")}`;
			await page.goto(url, { waitUntil: "load" });
			await page.waitForFunction(deckReady);
			const count = await page.evaluate(prepareDeck);
			return new DeckSession(page, browser, server, count);
		} catch (e) {
			await browser?.close();
			await server.close();
			throw e;
		}
	}

	slideCount(): number {
		return this.count;
	}

	slideMeta(
		i: number,
	): Promise<{ name: string; skipped: boolean; notes: string }> {
		return this.page.evaluate(readSlideMeta, i);
	}

	/** Loopback URL -> srcDir-relative path (decoded); every other URL is left as is. */
	private relative(url: string): string {
		const prefix = `${this.server.origin}/`;
		if (!url.startsWith(prefix)) return url;
		const rel = url.slice(prefix.length).replace(/[?#].*$/, "");
		try {
			return decodeURIComponent(rel);
		} catch {
			return rel;
		}
	}

	/** Slide `i` in its end state: entrances finished, infinite loops parked at t=0. */
	async capture(i: number): Promise<{ nodes: RawNode[]; anims: RawAnim[] }> {
		await this.page.evaluate(settleSlide, i);
		const { nodes, anims } = await this.page.evaluate(walkSlide, i);
		const prefix = `${this.server.origin}/`;
		for (const n of nodes) {
			if (n.img) n.img.src = this.relative(n.img.src);
			if (n.slot?.src) n.slot.src = this.relative(n.slot.src);
			// url(...) values in computed styles carry the same ephemeral origin.
			for (const k of ["backgroundImage", "maskImage"]) {
				if (n.style[k]?.includes(prefix)) {
					n.style[k] = n.style[k].split(prefix).join("");
				}
			}
		}
		return {
			nodes,
			anims: anims.map((a) => ({
				...a,
				iterations: a.iterations ?? Number.POSITIVE_INFINITY,
			})),
		};
	}

	async screenshot(i: number, outPath: string): Promise<void> {
		await this.page.evaluate(settleSlide, i);
		await this.page.screenshot({
			path: outPath as `${string}.png`,
			type: "png",
			clip: { x: 0, y: 0, ...SIZE },
		});
	}

	async close(): Promise<void> {
		await this.browser.close();
		await this.server.close();
	}
}
