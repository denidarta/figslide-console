import * as path from "node:path";
import { DeckSession } from "../../src/core/deck-import/capture.js";
import { chunkBase64, recordLoop } from "../../src/core/deck-import/gif.js";
import type { Box, RawNode } from "../../src/core/deck-import/types.js";

jest.setTimeout(120_000);

const MINI = path.resolve(__dirname, "../fixtures/deck-import/mini");

/** Walks the GIF block structure (independent of gifenc) and totals what a player would see. */
function parseGif(b: Uint8Array) {
	const skipSub = (p: number) => {
		while (b[p]) p += b[p] + 1;
		return p + 1;
	};
	const table = (flags: number) =>
		flags & 0x80 ? 3 * 2 ** ((flags & 7) + 1) : 0;
	let p = 13 + table(b[10]);
	let frames = 0;
	let delayCs = 0;
	let loops: number | undefined;
	while (b[p] !== 0x3b) {
		if (b[p] === 0x21) {
			if (b[p + 1] === 0xf9) delayCs += b[p + 4] | (b[p + 5] << 8);
			if (b[p + 1] === 0xff) loops = b[p + 16] | (b[p + 17] << 8); // NETSCAPE2.0
			p = skipSub(p + 2);
		} else if (b[p] === 0x2c) {
			frames++;
			p = skipSub(p + 10 + table(b[p + 9]) + 1);
		} else throw new Error(`bad GIF block 0x${b[p].toString(16)} at ${p}`);
	}
	return {
		width: b[6] | (b[7] << 8),
		height: b[8] | (b[9] << 8),
		frames,
		delayCs,
		loops,
	};
}

describe("recordLoop (real Chrome)", () => {
	let session: DeckSession;
	let nodes: RawNode[];
	let float: Box;
	let clock: Box;
	const whole = (n: RawNode): Box => ({
		x: n.box.x,
		y: n.box.y,
		w: Math.ceil(n.box.w),
		h: Math.ceil(n.box.h),
	});

	beforeAll(async () => {
		session = await DeckSession.open(MINI, "Mini.dc.html");
		let anims;
		({ nodes, anims } = await session.capture(2));
		float = whole(
			nodes.find(
				(n) => n.id === anims.find((a) => a.name === "mdFloat")?.nodeId,
			) as RawNode,
		);
		// The span is one digit wide when measured; the counter grows to three while we record.
		clock = {
			...whole(nodes.find((n) => n.loop && n.tag === "span") as RawNode),
			w: 120,
		};
	});
	afterAll(async () => {
		await session?.close();
	});
	afterEach(() => jest.restoreAllMocks());

	it("records a CSS loop deterministically: 30fps x cycle, 2x pixels, loops forever", async () => {
		const shots = jest.spyOn(session.page, "screenshot");
		const gif = await recordLoop(session, 2, float, 2000);

		expect(gif.frames).toBe(60);
		expect(gif.warnBig).toBe(false);
		expect(Buffer.from(gif.bytes.subarray(0, 6)).toString("latin1")).toBe(
			"GIF89a",
		);
		const parsed = parseGif(gif.bytes);
		expect(parsed).toEqual({
			width: float.w * 2,
			height: float.h * 2,
			frames: 60,
			delayCs: 200, // exactly the 2s cycle, not 60 x 3cs
			loops: 0,
		});

		// The animation actually advanced between frames: peak float (t=1s) differs from t=0.
		const png = await Promise.all(shots.mock.results.map((r) => r.value));
		expect(png).toHaveLength(60);
		expect(Buffer.compare(png[0], png[30])).not.toBe(0);
	});

	it("falls back to real time when no CSS animation overlaps the region", async () => {
		const shots = jest.spyOn(session.page, "screenshot");
		const t0 = Date.now();
		const gif = await recordLoop(session, 2, clock, 600);
		const wall = Date.now() - t0;

		const parsed = parseGif(gif.bytes);
		expect(gif.frames).toBeGreaterThan(1);
		expect(parsed.frames).toBe(gif.frames);
		expect(parsed.loops).toBe(0);
		expect(parsed.delayCs).toBeGreaterThanOrEqual(60); // plays back at least the cycle
		expect(wall).toBeGreaterThanOrEqual(600);
		const png = await Promise.all(shots.mock.results.map((r) => r.value));
		expect(png.some((p) => Buffer.compare(p, png[0]) !== 0)).toBe(true); // the clock ticked
	});

	it("leaves the page usable: a later capture sees loops parked at t=0", async () => {
		await recordLoop(session, 2, float, 500);
		const again = await session.capture(2);
		const owner = again.nodes.find(
			(n) => n.id === again.anims.find((a) => a.name === "mdFloat")?.nodeId,
		) as RawNode;
		expect(whole(owner)).toEqual(float);
		expect(again.anims.find((a) => a.name === "mdFloat")?.iterations).toBe(
			Infinity,
		);
	});

	it("records the slide it is told to, even when another one is active", async () => {
		await session.capture(0);
		const gif = await recordLoop(session, 2, float, 200);
		expect(gif.frames).toBe(6);
	});

	it("rejects a non-positive cycle", async () => {
		await expect(recordLoop(session, 2, float, 0)).rejects.toThrow(/cycleMs/);
	});
});

describe("chunkBase64", () => {
	it("splits 1.2MB into 3+ chunks that decode back to the input, joined or one by one", () => {
		const bytes = new Uint8Array(1_200_000).map((_, i) => (i * 7 + 3) % 256);
		const chunks = chunkBase64(bytes);
		expect(chunks.length).toBeGreaterThanOrEqual(3);
		expect(
			Buffer.from(chunks.join(""), "base64").equals(Buffer.from(bytes)),
		).toBe(true);
		const each = Buffer.concat(chunks.map((c) => Buffer.from(c, "base64")));
		expect(each.equals(Buffer.from(bytes))).toBe(true);
		expect(chunks.slice(0, -1).every((c) => !c.includes("="))).toBe(true);
	});

	it("honours a custom chunk size, honours subarray views, and returns [] for empty input", () => {
		const backing = new Uint8Array([9, 9, 1, 2, 3, 4, 5, 6, 7, 9]);
		const view = backing.subarray(2, 9); // 1..7
		const chunks = chunkBase64(view, 3);
		expect(chunks).toEqual([
			Buffer.from([1, 2, 3]).toString("base64"),
			Buffer.from([4, 5, 6]).toString("base64"),
			Buffer.from([7]).toString("base64"),
		]);
		expect(chunkBase64(new Uint8Array(0))).toEqual([]);
	});
});
