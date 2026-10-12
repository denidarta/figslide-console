import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { DeckSession } from "../../src/core/deck-import/capture.js";
import type { FigmaDeck } from "../../src/core/deck-import/figma.js";
import { recordLoop } from "../../src/core/deck-import/gif.js";
import { importSlide, loadBuilt } from "../../src/core/deck-import/pipeline.js";
import type {
	FigmaDumpNode,
	NodeIR,
	RawAnim,
	RawNode,
	SlideIR,
} from "../../src/core/deck-import/types.js";
import {
	pauseForRecording,
	seekLoops,
	walkSlide,
} from "../../src/core/deck-import/walker.page.js";

jest.mock("../../src/core/deck-import/gif.js", () => ({
	...jest.requireActual("../../src/core/deck-import/gif.js"),
	recordLoop: jest.fn(),
}));

const MINI = path.resolve(__dirname, "../fixtures/deck-import/mini");

const node = (
	id: string,
	parentId: string | null,
	extra: Partial<RawNode> = {},
): RawNode => ({
	id,
	parentId,
	tag: "div",
	box: { x: 0, y: 0, w: 100, h: 100 },
	style: {},
	...extra,
});
const section = (): RawNode =>
	node("s0-n0", null, {
		tag: "section",
		box: { x: 0, y: 0, w: 1920, h: 1080 },
		style: { backgroundColor: "rgb(0, 0, 0)" },
	});
const anim = (nodeId: string, extra: Partial<RawAnim> = {}): RawAnim => ({
	nodeId,
	name: "a",
	iterations: 1,
	delayMs: 0,
	durationMs: 600,
	easing: "ease-out",
	firstKeyframe: { opacity: "0" },
	...extra,
});
const emptyDump = (children: FigmaDumpNode[] = []): FigmaDumpNode => ({
	id: "9:1",
	importId: null,
	type: "SLIDE",
	name: "Slide",
	box: { x: 0, y: 0, w: 1920, h: 1080 },
	visible: true,
	fills: [],
	strokes: 0,
	effects: 0,
	clips: false,
	children,
});

const flatten = (list: NodeIR[]): NodeIR[] =>
	list.flatMap((n) => [n, ...(n.kind === "frame" ? flatten(n.children) : [])]);

describe("importSlide", () => {
	let tmp: string;
	let deckDir: string;
	let cacheDir: string;
	let srcDir: string;
	let rawNodes: RawNode[];
	let anims: RawAnim[];
	let walks: RawNode[][];
	let dumpWith: () => FigmaDumpNode;
	let session: any;
	let figma: any;
	let order: string[];

	const run = (replaceIds?: string[], onBuilt?: (ids: string[]) => void) =>
		importSlide(
			{
				session: session as DeckSession,
				figma: figma as FigmaDeck,
				srcDir,
				cacheDir,
				deckDir,
				onBuilt,
			},
			1,
			replaceIds,
		);
	const built = (): { ir: SlideIR; hashes: Map<string, string> } => ({
		ir: figma.buildSlide.mock.calls[0][0],
		hashes: figma.buildSlide.mock.calls[0][1],
	});

	beforeEach(() => {
		tmp = fs.mkdtempSync(path.join(os.tmpdir(), "deck-pipeline-"));
		deckDir = path.join(tmp, "deck.import", "decks", "Deck");
		cacheDir = path.join(tmp, "deck.import", "cache");
		srcDir = MINI;
		rawNodes = [section()];
		anims = [];
		walks = [];
		dumpWith = () => emptyDump();
		order = [];
		let walkCall = 0;
		session = {
			slideMeta: jest.fn(async () => ({
				name: "Intro",
				skipped: false,
				notes: "n",
			})),
			capture: jest.fn(async () => ({ nodes: rawNodes, anims })),
			screenshot: jest.fn(async (_i: number, out: string) => {
				order.push("html-shot");
				fs.writeFileSync(out, "html");
			}),
			page: {
				evaluate: jest.fn(async (fn: unknown) => {
					if (fn === pauseForRecording) return { x: 0, y: 0, seekable: true };
					if (fn === seekLoops) return undefined;
					if (fn === walkSlide)
						return { nodes: walks[walkCall++ % walks.length], anims: [] };
					throw new Error("unexpected page.evaluate");
				}),
			},
		};
		figma = {
			uploadImage: jest.fn(async (key: string) => `hash:${key}`),
			buildSlide: jest.fn(async () => {
				order.push("build");
				return { slideId: "9:1", warnings: [] };
			}),
			dump: jest.fn(async () => dumpWith()),
			screenshot: jest.fn(async (_id: string, out: string) => {
				order.push("figma-shot");
				fs.mkdirSync(path.dirname(out), { recursive: true });
				fs.writeFileSync(out, "figma");
			}),
		};
		(recordLoop as jest.Mock).mockReset().mockResolvedValue({
			bytes: new Uint8Array([71, 73, 70]),
			frames: 3,
			warnBig: false,
		});
	});
	afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

	it("builds the slide, screenshots both sides into shots/ and returns ids + QA", async () => {
		const out = await run(["4:1", "4:2"]);
		expect(figma.buildSlide).toHaveBeenCalledTimes(1);
		const [ir, , replace] = figma.buildSlide.mock.calls[0];
		expect(ir).toMatchObject({
			index: 0,
			name: "Intro",
			notes: "n",
			entrance: null,
		});
		expect(replace).toEqual(["4:1", "4:2"]);
		expect(out).toMatchObject({
			figmaIds: ["9:1"],
			qa: { pass: true, issues: [] },
		});
		expect(session.capture).toHaveBeenCalledWith(0);
		expect(
			fs.readFileSync(path.join(deckDir, "shots", "1-html.png"), "utf8"),
		).toBe("html");
		expect(
			fs.readFileSync(path.join(deckDir, "shots", "1-figma.png"), "utf8"),
		).toBe("figma");
	});

	it("reports the built ids before the screenshots, so a later failure cannot orphan the slide", async () => {
		figma.buildSlide.mockResolvedValue({
			slideId: "9:2",
			enterSlideId: "9:1",
			warnings: [],
		});
		figma.screenshot.mockRejectedValue(new Error("shot failed"));
		const seen: string[][] = [];
		await expect(run(undefined, (ids) => seen.push(ids))).rejects.toThrow(
			"shot failed",
		);
		expect(seen).toEqual([["9:1", "9:2"]]); // [enterSlideId, slideId]
	});

	it("collapses entrances into the IR (owner = the emitted node)", async () => {
		rawNodes = [
			section(),
			node("s0-n1", "s0-n0", { style: { backgroundColor: "rgb(255, 0, 0)" } }),
		];
		anims = [anim("s0-n1")];
		await run();
		expect(built().ir.entrance).toMatchObject({
			durationS: 0.6,
			curve: "EASE_OUT",
			start: { "s0-n1": { opacity: 0 } },
		});
	});

	it("keeps node flags and build warnings as slide flags, without icon markers", async () => {
		rawNodes = [
			section(),
			node("s0-n1", "s0-n0", {
				style: { backgroundColor: "rgb(1, 2, 3)", clipPath: "circle(50%)" },
			}),
		];
		figma.buildSlide.mockResolvedValue({
			slideId: "9:1",
			warnings: ["font-fallback:Foo Bold->Inter Bold"],
		});
		const { flags } = await run();
		expect(flags).toEqual(
			expect.arrayContaining([
				"unsupported:clip-path",
				"font-fallback:Foo Bold->Inter Bold",
			]),
		);
	});

	describe("icons and vectors", () => {
		it("fills a Lucide icon with its svg, currentColor replaced by the owner's color", async () => {
			rawNodes = [
				section(),
				node("s0-n1", "s0-n0", {
					tag: "i",
					iconClass: "icon-phone",
					style: { color: "rgb(255, 0, 0)" },
				}),
			];
			const { flags } = await run();
			const v = flatten(built().ir.root)[0];
			expect(v).toMatchObject({ kind: "vector", id: "s0-n1", opacity: 1 });
			const svg = (v as { svg: string }).svg;
			expect(svg).toContain("#ff0000");
			expect(svg).not.toMatch(/currentColor/i);
			expect(flags.some((f) => f.startsWith("icon:"))).toBe(false);
		});

		it("drops an unknown icon and flags missing-icon", async () => {
			rawNodes = [
				section(),
				node("s0-n1", "s0-n0", { tag: "i", iconClass: "icon-nope-nope" }),
			];
			const { flags } = await run();
			expect(built().ir.root).toEqual([]);
			expect(flags).toContain("missing-icon:icon-nope-nope");
		});

		it("takes the color from the nearest ancestor when the node has none, and folds alpha into opacity", async () => {
			rawNodes = [
				section(),
				node("s0-n1", "s0-n0", { style: { color: "rgba(0, 0, 255, 0.5)" } }),
				node("s0-n2", "s0-n1", {
					tag: "svg",
					svg: '<svg viewBox="0 0 1 1"><path stroke="currentColor" d="M0 0"/></svg>',
				}),
			];
			await run();
			const v = flatten(built().ir.root).find((n) => n.kind === "vector") as {
				svg: string;
				opacity: number;
			};
			expect(v.svg).toContain("#0000ff");
			expect(v.opacity).toBeCloseTo(0.5);
		});
	});

	describe("images", () => {
		it("uploads a bitmap once and hands buildSlide the hash by src", async () => {
			rawNodes = [
				section(),
				node("s0-n1", "s0-n0", {
					tag: "img",
					img: {
						src: "assets/dot.png",
						naturalW: 1,
						naturalH: 1,
						objectFit: "cover",
					},
				}),
			];
			const { flags } = await run();
			expect(figma.uploadImage).toHaveBeenCalledWith(
				"assets/dot.png",
				expect.any(Uint8Array),
			);
			expect(built().hashes.get("assets/dot.png")).toBe("hash:assets/dot.png");
			expect(flags).toEqual([]);
		});

		it("turns an svg <img> into a vector, never a raster", async () => {
			fs.mkdirSync(path.join(tmp, "src"), { recursive: true });
			fs.writeFileSync(
				path.join(tmp, "src", "logo.svg"),
				'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 2 2"><path fill="currentColor" d="M0 0h2v2z"/></svg>',
			);
			srcDir = path.join(tmp, "src");
			rawNodes = [
				section(),
				node("s0-n1", "s0-n0", {
					tag: "img",
					box: { x: 5, y: 6, w: 40, h: 40 },
					style: { color: "rgb(255, 0, 0)" },
					img: {
						src: "logo.svg",
						naturalW: 2,
						naturalH: 2,
						objectFit: "contain",
					},
				}),
			];
			await run();
			const v = built().ir.root[0] as {
				kind: string;
				svg: string;
				box: unknown;
			};
			expect(v.kind).toBe("vector");
			expect(v.svg).toContain("<path");
			expect(v.svg).not.toMatch(/currentColor/i); // an <img> svg renders it black
			expect(v.svg).toContain("#000000");
			expect(v.box).toEqual({ x: 5, y: 6, w: 40, h: 40 });
			expect(figma.uploadImage).not.toHaveBeenCalled();
		});

		it("drops an unreadable image and flags image-unsupported", async () => {
			rawNodes = [
				section(),
				node("s0-n1", "s0-n0", {
					tag: "img",
					img: {
						src: "assets/missing.webp",
						naturalW: 1,
						naturalH: 1,
						objectFit: "cover",
					},
				}),
			];
			const { flags, qa } = await run();
			expect(built().ir.root).toEqual([]);
			expect(flags).toContain("image-unsupported:assets/missing.webp");
			expect(qa.issues).toEqual([]); // nothing expected, nothing missing
		});

		it("keeps an image whose upload failed out of QA and flags image-missing", async () => {
			figma.uploadImage.mockRejectedValue(new Error("upload failed"));
			rawNodes = [
				section(),
				node("s0-n1", "s0-n0", {
					tag: "img",
					img: {
						src: "assets/dot.png",
						naturalW: 1,
						naturalH: 1,
						objectFit: "cover",
					},
				}),
			];
			const { flags, qa } = await run();
			expect(flags).toContain("image-missing:assets/dot.png");
			expect(qa.issues).toEqual([]);
		});

		it("shortens data: URIs in flags", async () => {
			const src = `data:image/webp;base64,${"A".repeat(500)}`;
			rawNodes = [
				section(),
				node("s0-n1", "s0-n0", {
					tag: "img",
					img: { src, naturalW: 1, naturalH: 1, objectFit: "cover" },
				}),
			];
			const { flags } = await run();
			const f = flags.find((x) => x.startsWith("image-unsupported:"));
			expect(f).toBeDefined();
			expect((f as string).length).toBeLessThan(120);
		});
	});

	describe("loop GIFs", () => {
		const owner = () =>
			node("s0-n1", "s0-n0", { loop: true, box: { x: 0, y: 0, w: 0, h: 0 } });
		const child = (x: number) =>
			node("s0-n2", "s0-n1", { box: { x, y: 50.5, w: 200, h: 100 } });

		beforeEach(() => {
			rawNodes = [section(), owner(), child(100.4)];
			walks = [
				[section(), owner(), child(100.4)],
				[section(), owner(), child(300.2)],
			];
			anims = [
				anim("s0-n2", {
					iterations: Number.POSITIVE_INFINITY,
					durationMs: 2000,
				}),
				anim("s0-n9", {
					iterations: Number.POSITIVE_INFINITY,
					durationMs: 9000,
				}), // outside the loop
			];
		});

		it("re-measures the owner over the cycle, records it and uploads it by gifKey", async () => {
			await run();
			expect(recordLoop).toHaveBeenCalledTimes(1);
			const [, slideIndex, box, cycleMs] = (recordLoop as jest.Mock).mock
				.calls[0];
			expect(slideIndex).toBe(0);
			expect(cycleMs).toBe(2000);
			// union of x 100.4..300.2+200, y 50.5..150.5, rounded outward
			expect(box).toEqual({ x: 100, y: 50, w: 401, h: 101 });
			expect(figma.uploadImage).toHaveBeenCalledWith(
				"s0-n1",
				expect.any(Uint8Array),
			);
			const gif = built().ir.root[0] as { kind: string; box: unknown };
			expect(gif.kind).toBe("gif");
			expect(gif.box).toEqual({ x: 100, y: 50, w: 401, h: 101 });
			expect(built().hashes.get("s0-n1")).toBe("hash:s0-n1");
		});

		it("keeps the loop owner's rounded corners on the gif, resolved against the measured box", async () => {
			rawNodes = [
				section(),
				{
					...owner(),
					style: {
						borderTopLeftRadius: "20px",
						borderTopRightRadius: "50%",
						borderBottomRightRadius: "0px",
						borderBottomLeftRadius: "0px",
					},
				},
				child(100.4),
			];
			await run();
			const gif = built().ir.root[0] as { kind: string; radii: number[] };
			expect(gif.kind).toBe("gif");
			// the captured box is 0x0 (radii would clamp to 0); the measured one is 401x101, so 50% clamps to 50.5
			expect(gif.radii).toEqual([20, 50.5, 0, 0]);
		});

		it("defaults the cycle to 3s without an infinite animation inside", async () => {
			anims = [];
			await run();
			expect((recordLoop as jest.Mock).mock.calls[0][3]).toBe(3000);
		});

		it("clamps to the slide and flags big and heavy loops", async () => {
			walks = [
				[
					section(),
					owner(),
					node("s0-n2", "s0-n1", { box: { x: -50, y: -10, w: 2100, h: 1200 } }),
				],
			];
			anims = [
				anim("s0-n2", {
					iterations: Number.POSITIVE_INFINITY,
					durationMs: 12000,
				}),
			];
			(recordLoop as jest.Mock).mockResolvedValue({
				bytes: new Uint8Array([1]),
				frames: 1,
				warnBig: true,
			});
			const { flags } = await run();
			expect((recordLoop as jest.Mock).mock.calls[0][2]).toEqual({
				x: 0,
				y: 0,
				w: 1920,
				h: 1080,
			});
			expect(flags).toEqual(
				expect.arrayContaining(["big-loop:s0-n1", "gif-over-5mb:s0-n1"]),
			);
		});

		it("flags a loop that cannot be recorded instead of failing the slide", async () => {
			(recordLoop as jest.Mock).mockRejectedValue(
				new Error("screenshot failed"),
			);
			const { flags, qa } = await run();
			expect(flags).toEqual(
				expect.arrayContaining(["gif-failed:s0-n1", "image-missing:s0-n1"]),
			);
			expect(qa.issues).toEqual([]);
		});
	});

	describe("QA bookkeeping", () => {
		const redBox = () => [
			section(),
			node("s0-n1", "s0-n0", {
				box: { x: 10, y: 20, w: 100, h: 50 },
				style: { backgroundColor: "rgb(255, 0, 0)" },
			}),
		];
		const frameDump = (x: number): FigmaDumpNode =>
			emptyDump([
				{
					...emptyDump(),
					id: "7:2",
					type: "FRAME",
					importId: "s0-n1",
					name: "Frame #s0-n1",
					box: { x, y: 20, w: 100, h: 50 },
					fills: [{ type: "SOLID", hasImage: false }],
				},
			]);

		it("persists IR, expected ids and QA, and records fixed:<kind> when a re-import passes", async () => {
			rawNodes = redBox();
			dumpWith = () => frameDump(14);
			const first = await run();
			expect(first.qa.issues.map((i) => i.kind)).toEqual(["box"]);
			expect(first.flags.some((f) => f.startsWith("fixed:"))).toBe(false);
			const saved = loadBuilt(deckDir, 1);
			expect(saved?.ir.root).toHaveLength(1);
			expect(saved?.expected).toEqual(["s0-n1"]);
			expect(saved?.qa?.issues).toHaveLength(1);

			dumpWith = () => frameDump(10);
			const second = await run(["9:1"]);
			expect(second.qa.pass).toBe(true);
			expect(second.flags).toContain("fixed:box");
			expect(loadBuilt(deckDir, 1)?.qa?.pass).toBe(true);
		});

		it("writes the stored IR atomically and treats an unparsable file as missing", async () => {
			rawNodes = redBox();
			dumpWith = () => frameDump(10);
			await run();
			const dir = path.join(deckDir, "ir");
			expect(fs.readdirSync(dir)).toEqual(["1.json"]); // no leftover temp file

			fs.writeFileSync(path.join(dir, "1.json"), '{"ir": {"na'); // truncated by a crash
			expect(loadBuilt(deckDir, 1)).toBeNull();
			await expect(run(["9:1"])).resolves.toMatchObject({ qa: { pass: true } });
			expect(loadBuilt(deckDir, 1)?.qa?.pass).toBe(true);
		});
	});
});
