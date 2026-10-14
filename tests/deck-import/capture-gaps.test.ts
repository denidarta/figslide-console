import * as path from "node:path";
import { describeWithChrome } from "../helpers/chrome.js";
import { DeckSession } from "../../src/core/deck-import/capture.js";
import type { RawNode } from "../../src/core/deck-import/types.js";

jest.setTimeout(60_000);

const MINI = path.resolve(__dirname, "../fixtures/deck-import/mini");

describeWithChrome("DeckSession fidelity gaps (real Chrome)", () => {
	let session: DeckSession;
	let nodes: RawNode[];
	const textStarting = (chars: string) =>
		nodes.find(
			(n) => n.tag === "#text-block" && n.text?.runs[0].chars.startsWith(chars),
		);

	beforeAll(async () => {
		session = await DeckSession.open(MINI, "Gaps.dc.html");
		({ nodes } = await session.capture(0));
	});
	afterAll(async () => {
		await session?.close();
	});

	it("captures -webkit-text-stroke on outline text (transparent fill)", () => {
		expect(textStarting("Outline")?.text?.runs[0]).toMatchObject({
			color: "rgba(0, 0, 0, 0)",
			strokeWidth: 2,
			strokeColor: "rgb(10, 108, 255)",
		});
		// ordinary text carries no stroke fields
		expect(textStarting("Title")?.text?.runs[0].strokeWidth).toBeUndefined();
	});

	it("sums per-line line heights for mixed font sizes instead of max x lines", () => {
		const tb = textStarting("Title");
		expect(tb?.text?.lineCount).toBe(2);
		expect(tb?.text?.lineHeights).toEqual([76.8, 28.8]);
		expect(tb?.box.h).toBeCloseTo(105.6, 1); // not 2 x 76.8
		expect(textStarting("Outline")?.text?.lineHeights).toBeUndefined();
	});

	it("keeps a leaf's padding next to its border, so normalize can inset the content", () => {
		const img = nodes.find((n) => n.tag === "img");
		expect(img?.box).toMatchObject({ w: 148, h: 148 });
		expect(img?.style).toMatchObject({
			paddingTop: "10px",
			paddingLeft: "10px",
			borderTopWidth: "4px",
			backgroundColor: "rgb(0, 255, 0)",
		});
	});

	describe("inline svg styled by page CSS", () => {
		let svg: string;
		beforeAll(() => {
			svg = nodes.find((n) => n.tag === "svg")?.svg ?? "";
		});

		it("writes class rules and var() out as attributes, and drops class / style", () => {
			expect(svg).toMatch(
				/<circle[^>]*r="40"[^>]*fill="none"[^>]*stroke="#0a6cff"[^>]*stroke-width="6"/,
			);
			expect(svg).not.toMatch(/\bclass=|\bstyle=/);
		});

		it("resolves currentColor from the page's color", () => {
			expect(svg).toMatch(/<circle[^>]*r="10"[^>]*fill="#ff0000"/);
		});

		it("leaves out display:none parts", () => {
			expect(svg).not.toContain("<rect");
		});

		it("expands <use> of a symbol into a nested svg with the symbol's styled content", () => {
			expect(svg).not.toContain("<use");
			expect(svg).toMatch(
				/<g transform="translate\(5 5\)"><svg viewBox="0 0 10 10" width="20" height="20">/,
			);
			expect(svg).toMatch(/<path[^>]*d="M5 0L10 10H0Z"[^>]*fill="#ff8800"/);
		});

		it("writes only non-default values on the root", () => {
			const root = /^<svg[^>]*>/.exec(svg)?.[0] ?? "";
			expect(root).not.toContain('fill="#000000"');
			expect(root).not.toContain("stroke-miterlimit");
			expect(root).toContain('font-family="Helvetica, sans-serif"');
		});
	});

	it("watches long enough to catch a JS timer loop slower than 300ms", async () => {
		const { nodes: slow } = await session.capture(1);
		const owner = (text: string) =>
			slow.find(
				(n) =>
					n.id ===
					slow.find(
						(t) =>
							t.tag === "#text-block" && t.text?.runs[0].chars.startsWith(text),
					)?.parentId,
			);
		// the 800ms interval rewrites the span inside #slow; a 300ms window catches it only by luck
		const loops = slow.filter((n) => n.loop);
		expect(loops).toHaveLength(1);
		expect(loops[0].tag).toBe("span");
		expect(owner("Static")?.loop).toBeUndefined();
	});
});
