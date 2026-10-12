import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { DeckSession } from "../../src/core/deck-import/capture.js";
import type { RawAnim, RawNode } from "../../src/core/deck-import/types.js";

jest.setTimeout(60_000);

const MINI = path.resolve(__dirname, "../fixtures/deck-import/mini");

describe("DeckSession (real Chrome)", () => {
	let session: DeckSession;
	let tmp: string;

	beforeAll(async () => {
		tmp = fs.mkdtempSync(path.join(os.tmpdir(), "deck-capture-"));
		session = await DeckSession.open(MINI, "Mini.dc.html");
	});
	afterAll(async () => {
		await session?.close();
		fs.rmSync(tmp, { recursive: true, force: true });
	});

	it("reports slide count and meta", async () => {
		expect(session.slideCount()).toBe(3);
		expect(await session.slideMeta(0)).toEqual({
			name: "00 Title",
			skipped: false,
			notes: "Note one",
		});
		expect((await session.slideMeta(2)).notes).toBe("Note three");
	});

	describe("slide 0: entrance + text", () => {
		let nodes: RawNode[];
		let anims: RawAnim[];
		beforeAll(async () => {
			({ nodes, anims } = await session.capture(0));
		});

		it("emits the section as the root with ids stable by DOM order", () => {
			expect(nodes[0]).toMatchObject({
				tag: "section",
				parentId: null,
				id: "s0-n0",
			});
			expect(nodes[0].box).toEqual({ x: 0, y: 0, w: 1920, h: 1080 });
			expect(new Set(nodes.map((n) => n.id)).size).toBe(nodes.length);
		});

		it("emits one #text-block with a bold run and the h1 text", () => {
			const blocks = nodes.filter((n) => n.tag === "#text-block");
			expect(blocks).toHaveLength(1);
			const tb = blocks[0];
			expect(tb.text?.runs.map((r) => r.chars).join("")).toBe(
				"Hello bold world",
			);
			expect(tb.text?.runs.filter((r) => r.fontWeight === 700)).toHaveLength(1);
			expect(tb.text?.runs.find((r) => r.fontWeight === 700)?.chars).toBe(
				"bold",
			);
			expect(tb.text?.lineCount).toBe(1);
			const owner = nodes.find((n) => n.id === tb.parentId);
			expect(owner?.tag).toBe("h1");
		});

		it("reports line-box geometry: one 72px x 1.1 line is 79.2px tall, at the h1 top", () => {
			const tb = nodes.find((n) => n.tag === "#text-block");
			const owner = nodes.find((n) => n.id === tb?.parentId);
			expect(tb?.box.h).toBeCloseTo(79.2, 0);
			expect(Math.abs((tb?.box.y ?? 0) - (owner?.box.y ?? 99))).toBeLessThan(
				0.5,
			);
		});

		it("records the entrance animation before finishing it", () => {
			expect(anims).toHaveLength(1);
			expect(anims[0]).toMatchObject({
				name: "npCard",
				delayMs: 1000,
				durationMs: 600,
				iterations: 1,
			});
			expect(anims[0].firstKeyframe.opacity).toBe("0");
			expect(anims[0].easing).toMatch(/cubic-bezier\(0\.65, 0, 0\.35, 1\)/);
			const card = nodes.find((n) => n.id === anims[0].nodeId);
			expect(card?.style.borderTopLeftRadius).toBe("24px");
		});

		it("leaves the card in its end state", () => {
			const card = nodes.find((n) => n.id === anims[0].nodeId);
			expect(card?.style.opacity).toBe("1");
		});

		it("normalizes modern color functions to rgb()/rgba()", () => {
			const card = nodes.find((n) => n.id === anims[0].nodeId);
			expect(card?.style.boxShadow).toMatch(/^rgba\(\d+, \d+, \d+, 0\.25\) /);
			const run = nodes.find((n) => n.tag === "#text-block")?.text?.runs[0];
			expect(run?.color).toMatch(/^rgb\(/);
			for (const n of nodes) {
				for (const v of Object.values(n.style))
					expect(v).not.toMatch(/oklch|lab\(|color\(/);
			}
		});
	});

	describe("slide 1: leaves and hidden", () => {
		let nodes: RawNode[];
		beforeAll(async () => {
			({ nodes } = await session.capture(1));
		});

		it("captures img, svg, icon, and image-slot leaves", () => {
			const img = nodes.filter((n) => n.img);
			expect(img).toHaveLength(1);
			expect(img[0].img).toMatchObject({
				naturalW: 16,
				naturalH: 16,
				objectFit: "cover",
			});
			expect(img[0].img?.src).toBe("assets/dot.png");
			expect(nodes.filter((n) => n.svg)).toHaveLength(1);
			expect(nodes.find((n) => n.svg)?.svg).toMatch(/^<svg[\s>]/);
			expect(nodes.filter((n) => n.iconClass === "icon-phone")).toHaveLength(1);
			const slot = nodes.filter((n) => n.slot);
			expect(slot).toHaveLength(1);
			expect(slot[0].slot).toMatchObject({
				placeholder: "Photo: test",
				shape: "rect",
			});
		});

		it("normalizes gradient stops on the section background", () => {
			expect(nodes[0].style.backgroundImage).toMatch(
				/^linear-gradient\(135deg, rgb\(\d+, \d+, \d+\), rgb\(\d+, \d+, \d+\)\)$/,
			);
		});

		it("marks display:none and off-slide elements hidden", () => {
			const gone = nodes.find(
				(n) => n.style.backgroundColor === "rgb(255, 0, 0)",
			);
			const far = nodes.find(
				(n) => n.style.backgroundColor === "rgb(0, 255, 0)",
			);
			expect(gone?.hidden).toBe(true);
			expect(far?.hidden).toBe(true);
			expect(far?.box.x).toBe(2400);
			expect(nodes.find((n) => n.img)?.hidden).toBeFalsy();
		});
	});

	describe("slide 2: loops", () => {
		it("flags the infinitely animated element, not its static sibling", async () => {
			const { nodes, anims } = await session.capture(2);
			const floater = nodes.find(
				(n) =>
					n.tag === "#text-block" && n.text?.runs[0]?.chars === "Floating text",
			);
			const floatOwner = nodes.find((n) => n.id === floater?.parentId);
			expect(floatOwner?.loop).toBe(true);
			const stat = nodes.find(
				(n) =>
					n.tag === "#text-block" && n.text?.runs[0]?.chars === "Static text",
			);
			expect(nodes.find((n) => n.id === stat?.parentId)?.loop).toBeFalsy();
			const float = anims.find((a) => a.name === "mdFloat");
			expect(float?.iterations).toBe(Infinity);
			expect(float?.nodeId).toBe(floatOwner?.id);
		});

		it("flags only the outermost JS-driven element", async () => {
			const { nodes } = await session.capture(2);
			const tick = nodes.find(
				(n) =>
					n.tag === "#text-block" && /^\d+$/.test(n.text?.runs[0]?.chars ?? ""),
			);
			const span = nodes.find((n) => n.id === tick?.parentId);
			expect(span?.tag).toBe("span");
			expect(span?.loop).toBe(true);
			expect(nodes.find((n) => n.id === span?.parentId)?.loop).toBeFalsy();
		});

		it("keeps &nbsp;, turns <br> into a newline and collapses other whitespace", async () => {
			const { nodes } = await session.capture(2);
			const tb = nodes.find(
				(n) =>
					n.tag === "#text-block" && n.text?.runs[0]?.chars.startsWith("Line"),
			);
			expect(tb?.text?.runs.map((r) => r.chars).join("")).toBe(
				"Line\u00A0one\nline two",
			);
			expect(tb?.text?.lineCount).toBe(2);
		});

		it("text block height is lineCount x line-height (1.2 x font size for normal)", async () => {
			const { nodes } = await session.capture(2);
			const tb = nodes.find(
				(n) =>
					n.tag === "#text-block" && n.text?.runs[0]?.chars.startsWith("Line"),
			);
			const run = tb?.text?.runs[0];
			expect(run?.lineHeight).toBe("normal");
			expect(
				Math.abs((tb?.box.h ?? 0) - 2 * 1.2 * (run?.fontSize ?? 0)),
			).toBeLessThan(0.5);
		});
	});

	it("captures a skipped slide and reports it as skipped", async () => {
		const mark = (on: boolean) =>
			session.page.evaluate((flag) => {
				const slide = document.querySelector("deck-stage")?.children[1];
				if (flag) slide?.setAttribute("data-deck-skip", "");
				else slide?.removeAttribute("data-deck-skip");
			}, on);
		await mark(true);
		try {
			expect((await session.slideMeta(1)).skipped).toBe(true);
			const { nodes } = await session.capture(1);
			expect(nodes.length).toBeGreaterThan(1);
			expect(nodes[0].hidden).toBeFalsy();
			expect(nodes[0].box).toEqual({ x: 0, y: 0, w: 1920, h: 1080 });
		} finally {
			await mark(false);
		}
	});

	it("maps a filled image-slot src back to a srcDir-relative path", async () => {
		const setSrc = (src: string | null) =>
			session.page.evaluate((v) => {
				const slot = document.querySelector("image-slot");
				if (v) slot?.setAttribute("src", v);
				else slot?.removeAttribute("src");
			}, src);
		await setSrc("assets/dot.png");
		try {
			const { nodes } = await session.capture(1);
			expect(nodes.find((n) => n.slot)?.slot?.src).toBe("assets/dot.png");
		} finally {
			await setSrc(null);
		}
	});

	it("serves only files under srcDir, to its own loopback origin", async () => {
		const origin = new URL(session.page.url()).origin;
		const get = (reqPath: string, host?: string) =>
			new Promise<number>((resolve, reject) => {
				http
					.get(origin + reqPath, host ? { headers: { host } } : {}, (res) => {
						res.resume();
						resolve(res.statusCode ?? 0);
					})
					.on("error", reject);
			});
		expect(await get("/assets/dot.png")).toBe(200);
		expect(await get("/..%2f..%2fpackage.json")).toBe(403);
		// the URL parser already folds these into /package.json, which is not under srcDir
		expect(await get("/%2e%2e/%2e%2e/package.json")).not.toBe(200);
		expect(await get("/..%5c..%5cpackage.json")).not.toBe(200);
		expect(await get("/missing.png")).toBe(404);
		expect(await get("/assets/dot.png", "evil.example")).toBe(403);
	});

	it("re-captures the active slide with its entrance animations restarted", async () => {
		const a = await session.capture(0);
		const b = await session.capture(0);
		expect(b.anims).toEqual(a.anims);
		expect(b.anims).toHaveLength(1);
		expect(b.nodes).toEqual(a.nodes);
	});

	it("screenshot writes a 1920x1080 PNG", async () => {
		const out = path.join(tmp, "s0.png");
		await session.screenshot(0, out);
		const buf = fs.readFileSync(out);
		expect(buf.subarray(1, 4).toString()).toBe("PNG");
		expect(buf.readUInt32BE(16)).toBe(1920);
		expect(buf.readUInt32BE(20)).toBe(1080);
	});
});
