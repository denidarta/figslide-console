import * as path from "node:path";
import { pathToFileURL } from "node:url";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import type { RawAnim, RawNode } from "./types.js";
import { readSlideMeta, settleSlide, walkSlide } from "./walker.page.js";

const SIZE = { width: 1920, height: 1080 };

/** One headless Chrome page rendering one `.dc.html` deck, 1:1 (deck-stage `noscale`). */
export class DeckSession {
	private constructor(
		readonly page: Page,
		private readonly browser: Browser,
		private readonly count: number,
	) {}

	static async open(srcDir: string, deckFile: string): Promise<DeckSession> {
		const executablePath = process.env.DECK_IMPORT_CHROME_PATH;
		const browser = await puppeteer.launch({
			headless: true,
			...(executablePath ? { executablePath } : { channel: "chrome" }),
			// The .dc.html runtime fetch()es its own deck file and components; file:// origins block that.
			args: ["--allow-file-access-from-files"],
		});
		try {
			const page = await browser.newPage();
			await page.setViewport({ ...SIZE, deviceScaleFactor: 1 });
			await page.emulateMediaFeatures([
				{ name: "prefers-reduced-motion", value: "no-preference" },
			]);
			await page.goto(pathToFileURL(path.resolve(srcDir, deckFile)).href, {
				waitUntil: "load",
			});
			await page.waitForFunction(
				() =>
					!!customElements.get("deck-stage") &&
					(document.querySelector("deck-stage")?.children.length ?? 0) > 0,
			);
			const count = await page.evaluate(async () => {
				const deck = document.querySelector("deck-stage") as HTMLElement;
				deck.setAttribute("noscale", "");
				// Deck chrome (slide counter, rail) would otherwise appear in screenshots.
				const hide = document.createElement("style");
				hide.textContent =
					".overlay,.rail,.rail-resize,.ctxmenu{display:none!important}";
				deck.shadowRoot?.appendChild(hide);
				await document.fonts.ready;
				return Array.from(deck.children).filter(
					(e) => !/^(TEMPLATE|SCRIPT|STYLE)$/.test(e.tagName),
				).length;
			});
			return new DeckSession(page, browser, count);
		} catch (e) {
			await browser.close();
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

	/** Slide `i` in its end state: entrances finished, infinite loops parked at t=0. */
	async capture(i: number): Promise<{ nodes: RawNode[]; anims: RawAnim[] }> {
		await this.page.evaluate(settleSlide, i);
		const { nodes, anims } = await this.page.evaluate(walkSlide, i);
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
	}
}
