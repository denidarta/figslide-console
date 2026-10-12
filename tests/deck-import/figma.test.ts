import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { FigmaDeck } from "../../src/core/deck-import/figma.js";
import { RUNTIME_SOURCE } from "../../src/core/deck-import/runtime.plugin.js";
import type { SlideIR } from "../../src/core/deck-import/types.js";
import { type FNode, Sandbox } from "./fake-figma.js";

/** A connector that runs EXECUTE_CODE against a sandboxed fake plugin, like the websocket bridge does. */
function connectorFor(sb: Sandbox) {
	const calls: { code: string; timeout: number }[] = [];
	const shots: { nodeId: string; options: unknown }[] = [];
	return {
		calls,
		shots,
		afterCall: undefined as undefined | ((code: string) => void),
		async executeCodeViaUI(code: string, timeout: number) {
			calls.push({ code, timeout });
			try {
				const result = await sb.exec(code);
				this.afterCall?.(code);
				return { success: true, result };
			} catch (e) {
				return { success: false, error: `Error: ${(e as Error).message}` };
			}
		},
		async captureScreenshot(nodeId: string, options: unknown) {
			shots.push({ nodeId, options });
			return {
				success: true,
				image: { base64: Buffer.from("PNGDATA").toString("base64") },
			};
		},
	};
}

const slide = (extra: Partial<SlideIR> = {}): SlideIR => ({
	index: 0,
	name: "Title",
	background: [{ type: "SOLID", color: { r: 0, g: 0, b: 0, a: 1 } }],
	skipped: false,
	notes: "talk",
	root: [
		{
			kind: "frame",
			id: "s0-n1",
			box: { x: 10, y: 20, w: 300, h: 200 },
			fills: [],
			strokes: null,
			radii: [0, 0, 0, 0],
			effects: [],
			clip: false,
			opacity: 1,
			children: [
				{
					kind: "image",
					id: "s0-n2",
					box: { x: 20, y: 30, w: 100, h: 50 },
					src: "logo.png",
					scaleMode: "FILL",
					radii: [0, 0, 0, 0],
					opacity: 1,
					flags: [],
				},
			],
			flags: [],
		},
	],
	entrance: null,
	flags: [],
	...extra,
});

describe("FigmaDeck", () => {
	it("sends the runtime plus one command per call with a 60s timeout", async () => {
		const sb = new Sandbox();
		sb.fake.addSlide("Blank");
		const conn = connectorFor(sb);
		const deck = new FigmaDeck(conn);
		const { slideId, enterSlideId } = await deck.buildSlide(
			slide(),
			new Map([["logo.png", "HASH"]]),
		);
		expect(enterSlideId).toBeUndefined();
		expect(conn.calls).toHaveLength(1);
		expect(conn.calls[0].timeout).toBe(60000);
		expect(conn.calls[0].code.startsWith(RUNTIME_SOURCE)).toBe(true);
		expect(conn.calls[0].code).toContain("return await __deckImport({");

		const built = sb.fake.nodes.get(slideId) as FNode;
		expect(built.name).toBe("Title");
		expect(built.speakerNotes).toBe("talk");
		expect(built.fills).toEqual([
			{ type: "SOLID", color: { r: 0, g: 0, b: 0 }, opacity: 1 },
		]);
		const img = built.children[0].children[0];
		expect(img.fills).toEqual([
			{ type: "IMAGE", imageHash: "HASH", scaleMode: "FILL" },
		]);
		expect(img).toMatchObject({ x: 10, y: 10, width: 100, height: 50 });
	});

	it("keeps U+2028/U+2029 in slide text out of the sent code", async () => {
		const ls = String.fromCharCode(0x2028);
		const ps = String.fromCharCode(0x2029);
		const name = ["A", "B", "C"].join(ls + ps);
		const sb = new Sandbox();
		sb.fake.addSlide("Blank");
		const conn = connectorFor(sb);
		const { slideId } = await new FigmaDeck(conn).buildSlide(
			slide({ name }),
			new Map([["logo.png", "H"]]),
		);
		expect(conn.calls[0].code).not.toContain(ls);
		expect(conn.calls[0].code).not.toContain(ps);
		expect(sb.fake.nodes.get(slideId)?.name).toBe(name);
	});

	it("builds the entrance pair when the slide has one", async () => {
		const sb = new Sandbox();
		sb.fake.addSlide("Blank");
		const conn = connectorFor(sb);
		const deck = new FigmaDeck(conn);
		const res = await deck.buildSlide(
			slide({
				entrance: {
					durationS: 0.5,
					curve: "EASE_OUT",
					start: { "s0-n1": { opacity: 0, dy: 24 } },
				},
			}),
			new Map([["logo.png", "HASH"]]),
		);
		expect(conn.calls).toHaveLength(2);
		const copy = sb.fake.nodes.get(res.enterSlideId as string) as FNode;
		expect(copy.name).toBe("Title · enter");
		const start = copy.children[0];
		expect(start.opacity).toBe(0);
		expect(start.y).toBe(20 + 24);
		expect(sb.fake.nodes.get(res.slideId)?.transition).toMatchObject({
			style: "SMART_ANIMATE",
			duration: 0.5,
			curve: "EASE_OUT",
		});
	});

	it("passes replaceIds through", async () => {
		const sb = new Sandbox();
		const a = sb.fake.addSlide("A");
		const b = sb.fake.addSlide("B");
		const deck = new FigmaDeck(connectorFor(sb));
		const { slideId } = await deck.buildSlide(
			slide(),
			new Map([["logo.png", "H"]]),
			[a.id],
		);
		expect(sb.fake.gridIds()).toEqual([[slideId, b.id]]);
	});

	it("surfaces the plugin's message without the Error prefix", async () => {
		const deck = new FigmaDeck(connectorFor(new Sandbox()));
		await expect(deck.buildSlide(slide(), new Map())).rejects.toThrow(
			/^Add one blank slide to the deck, then retry$/,
		);
	});

	it("throws on a failed bridge call", async () => {
		const deck = new FigmaDeck({
			executeCodeViaUI: async () => ({
				success: false,
				error: "Execution timed out",
			}),
		});
		await expect(deck.dump("1:1")).rejects.toThrow("Execution timed out");
	});

	describe("uploadImage", () => {
		const bytes = new Uint8Array(Array.from({ length: 30 }, (_, i) => i * 7));

		it("uploads in chunks and creates one image", async () => {
			const sb = new Sandbox();
			const conn = connectorFor(sb);
			const deck = new FigmaDeck(conn, { chunkSize: 9 });
			const hash = await deck.uploadImage("a.png", bytes);
			expect(hash).toBe("hash1");
			expect(conn.calls).toHaveLength(4); // 9+9+9+3 bytes
			expect(sb.fake.images).toHaveLength(1);
			expect(Buffer.from(sb.fake.images[0]).equals(Buffer.from(bytes))).toBe(
				true,
			);
		});

		it("dedupes identical bytes by sha1 within a run", async () => {
			const sb = new Sandbox();
			const conn = connectorFor(sb);
			const deck = new FigmaDeck(conn);
			const a = await deck.uploadImage("a.png", bytes);
			const calls = conn.calls.length;
			const b = await deck.uploadImage("copy-of-a.png", new Uint8Array(bytes));
			expect(b).toBe(a);
			expect(conn.calls).toHaveLength(calls);
			expect(sb.fake.images).toHaveLength(1);
			const c = await deck.uploadImage("c.png", new Uint8Array([1, 2, 3]));
			expect(c).not.toBe(a);
			expect(sb.fake.images).toHaveLength(2);
		});

		it("re-sends everything in one call when the chunks were lost", async () => {
			const sb = new Sandbox();
			const conn = connectorFor(sb);
			let n = 0;
			conn.afterCall = () => {
				if (++n === 1) sb.reset(); // plugin context torn down after the first chunk
			};
			const deck = new FigmaDeck(conn, { chunkSize: 9 });
			const hash = await deck.uploadImage("a.png", bytes);
			expect(hash).toBe("hash1");
			expect(sb.fake.images).toHaveLength(1);
			expect(Buffer.from(sb.fake.images[0]).equals(Buffer.from(bytes))).toBe(
				true,
			);
			expect(conn.calls).toHaveLength(3); // chunk 0, chunk 1 (lost), whole image
		});

		it("rejects empty bytes", async () => {
			const deck = new FigmaDeck(connectorFor(new Sandbox()));
			await expect(deck.uploadImage("x", new Uint8Array())).rejects.toThrow(
				"empty",
			);
		});
	});

	it("dumps a slide", async () => {
		const sb = new Sandbox();
		sb.fake.addSlide("Blank");
		const deck = new FigmaDeck(connectorFor(sb));
		const { slideId } = await deck.buildSlide(
			slide(),
			new Map([["logo.png", "H"]]),
		);
		const d = await deck.dump(slideId);
		expect(d.children[0].importId).toBe("s0-n1");
		expect(d.children[0].children[0].fills).toEqual([
			{ type: "IMAGE", hasImage: true },
		]);
	});

	it("patches a node", async () => {
		const sb = new Sandbox();
		sb.fake.addSlide("Blank");
		const deck = new FigmaDeck(connectorFor(sb));
		const { slideId } = await deck.buildSlide(
			slide(),
			new Map([["logo.png", "H"]]),
		);
		const f = sb.fake.nodes.get(slideId)?.children[0] as FNode;
		await deck.patch(f.id, { x: 99 });
		expect(f.x).toBe(99);
	});

	it("saves a screenshot as a PNG file", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "deck-shot-"));
		try {
			const conn = connectorFor(new Sandbox());
			const out = path.join(dir, "nested", "s1.png");
			await new FigmaDeck(conn).screenshot("12:34", out);
			expect(fs.readFileSync(out, "utf8")).toBe("PNGDATA");
			expect(conn.shots).toEqual([
				{ nodeId: "12:34", options: { format: "PNG", scale: 1 } },
			]);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("fails a screenshot that returns no image", async () => {
		const deck = new FigmaDeck({
			captureScreenshot: async () => ({ success: false, error: "no export" }),
		});
		await expect(
			deck.screenshot("1:1", path.join(os.tmpdir(), "x.png")),
		).rejects.toThrow("no export");
	});
});
