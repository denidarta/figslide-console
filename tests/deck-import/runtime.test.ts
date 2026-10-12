import { Sandbox } from "./fake-figma.js";

const GREY = [{ type: "SOLID", color: { r: 0.5, g: 0.5, b: 0.5 }, opacity: 1 }];
const NONE_T = {
	style: "NONE",
	duration: 0.01,
	curve: "EASE_OUT",
	timing: { type: "ON_CLICK" },
};

const frameOp = (id: string, parent: string | null, extra = {}) => ({
	op: "frame",
	id,
	parent,
	name: `Frame #${id}`,
	props: {
		x: 100,
		y: 200,
		w: 500,
		h: 300,
		fills: GREY,
		strokes: null,
		radii: [0, 0, 0, 0],
		effects: [],
		clip: false,
		opacity: 1,
		...extra,
	},
});
const textOp = (id: string, parent: string | null, extra = {}) => ({
	op: "text",
	id,
	parent,
	name: `Hello #${id}`,
	props: {
		x: 20,
		y: 30,
		w: 300,
		h: 48,
		text: "Hello world",
		align: "CENTER",
		opacity: 1,
		lineHeightPx: 48,
		runs: [
			{
				start: 0,
				end: 5,
				family: "Geist",
				style: "SemiBold",
				fontSize: 40,
				fills: GREY,
				letterSpacing: { unit: "PERCENT", value: -2 },
				lineHeight: { unit: "PIXELS", value: 48 },
				decoration: "UNDERLINE",
			},
			{
				start: 5,
				end: 11,
				family: "Geist",
				style: "Regular",
				fontSize: 20,
				fills: GREY,
				letterSpacing: { unit: "PERCENT", value: 0 },
				lineHeight: { unit: "PIXELS", value: 48 },
				decoration: "NONE",
			},
		],
		...extra,
	},
});
const slideMeta = (extra = {}) => ({
	name: "Title",
	background: [],
	skipped: false,
	notes: "",
	...extra,
});

/** A deck with one existing slide holding two children, where createSlide() throws. */
function deckWithOneSlide() {
	const sb = new Sandbox();
	const existing = sb.fake.addSlide("Blank");
	const a = sb.fake.api().createFrame();
	const b = sb.fake.api().createText();
	existing.appendChild(a);
	existing.appendChild(b);
	return { sb, existing, a, b };
}

describe("runtime buildSlide", () => {
	it("clones the last slide and empties it when createSlide throws", async () => {
		const { sb, existing, a, b } = deckWithOneSlide();
		const res = (await sb.run({
			cmd: "buildSlide",
			slide: slideMeta(),
			ops: [frameOp("s0-n1", null), textOp("s0-n2", "s0-n1")],
		})) as { slideId: string };

		const slide = sb.fake.nodes.get(res.slideId);
		expect(slide).toBeDefined();
		expect(slide?.id).not.toBe(existing.id);
		expect(slide?.name).toBe("Title");
		// the template's own children are gone, only the ops remain
		expect(a.parent).toBe(existing); // original untouched
		expect(existing.children).toEqual([a, b]);
		expect(slide?.children).toHaveLength(1);
		const frame = slide?.children[0];
		expect(frame?.name).toBe("Frame #s0-n1");
		expect(frame?.getPluginData("importId")).toBe("s0-n1");
		expect(frame?.children).toHaveLength(1);
		expect(frame?.children[0].type).toBe("TEXT");
		// appended at the end of the grid
		expect(sb.fake.gridIds()).toEqual([[existing.id, res.slideId]]);
	});

	it("resets the cloned slide's transition and notes", async () => {
		const { sb, existing } = deckWithOneSlide();
		existing.transition = { style: "SMART_ANIMATE" };
		existing.speakerNotes = "old notes";
		const res = (await sb.run({
			cmd: "buildSlide",
			slide: slideMeta({ notes: "new notes" }),
			ops: [],
		})) as { slideId: string };
		const slide = sb.fake.nodes.get(res.slideId);
		expect(slide?.transition).toEqual(NONE_T);
		expect(slide?.speakerNotes).toBe("new notes");
	});

	it("uses createSlide when it works", async () => {
		const sb = new Sandbox();
		sb.fake.canCreateSlide = true;
		const res = (await sb.run({
			cmd: "buildSlide",
			slide: slideMeta({ skipped: true, notes: "n" }),
			ops: [frameOp("f", null)],
		})) as { slideId: string };
		const slide = sb.fake.nodes.get(res.slideId);
		expect(slide?.isSkippedSlide).toBe(true);
		expect(slide?.speakerNotes).toBe("n");
		expect(slide?.children).toHaveLength(1);
	});

	it("tells the user to add a blank slide when the deck is empty", async () => {
		const sb = new Sandbox();
		await expect(
			sb.run({ cmd: "buildSlide", slide: slideMeta(), ops: [] }),
		).rejects.toThrow("Add one blank slide to the deck, then retry");
	});

	it("applies frame, text and image props", async () => {
		const { sb } = deckWithOneSlide();
		const res = (await sb.run({
			cmd: "buildSlide",
			slide: slideMeta({ background: GREY }),
			ops: [
				frameOp("f", null, {
					radii: [1, 2, 3, 4],
					strokes: {
						paints: GREY,
						weights: [1, 2, 3, 4],
						dashed: true,
					},
					effects: [{ type: "LAYER_BLUR", radius: 4, visible: true }],
					clip: true,
					opacity: 0.5,
				}),
				textOp("t", "f"),
				{
					op: "image",
					id: "i",
					parent: "f",
					name: "Image #i",
					props: {
						x: 1,
						y: 2,
						w: 30,
						h: 40,
						hash: "HASH",
						scaleMode: "FILL",
						radii: [5, 5, 5, 5],
						opacity: 1,
					},
				},
				{
					op: "slot",
					id: "sl",
					parent: null,
					name: "Image slot · hero #sl",
					props: { x: 0, y: 0, w: 10, h: 10, fills: [], radii: [0, 0, 0, 0] },
				},
			],
		})) as { slideId: string };
		const slide = sb.fake.nodes.get(res.slideId);
		expect(slide?.fills).toEqual(GREY);

		const [f, sl] = slide?.children ?? [];
		expect(f).toMatchObject({
			x: 100,
			y: 200,
			width: 500,
			height: 300,
			fills: GREY,
			topLeftRadius: 1,
			topRightRadius: 2,
			bottomRightRadius: 3,
			bottomLeftRadius: 4,
			strokes: GREY,
			strokeTopWeight: 1,
			strokeRightWeight: 2,
			strokeBottomWeight: 3,
			strokeLeftWeight: 4,
			strokeAlign: "INSIDE",
			effects: [{ type: "LAYER_BLUR", radius: 4, visible: true }],
			clipsContent: true,
			opacity: 0.5,
		});
		expect(f.dashPattern).toEqual([8, 8]);
		expect(sl).toMatchObject({ name: "Image slot · hero #sl", fills: [] });

		const [t, img] = f.children;
		expect(t).toMatchObject({
			type: "TEXT",
			characters: "Hello world",
			textAlignHorizontal: "CENTER",
			textAutoResize: "HEIGHT",
			x: 20,
			y: 30,
			width: 300,
		});
		expect(t.getPluginData("lineHeightPx")).toBe("48");
		expect(t.rangeFonts.map((r: { font: unknown }) => r.font)).toEqual([
			{ family: "Geist", style: "SemiBold" },
			{ family: "Geist", style: "Regular" },
		]);
		const fn = (name: string) =>
			t.ranges
				.filter((r: { fn: string }) => r.fn === name)
				.map((r: { args: unknown[] }) => r.args);
		expect(fn("fontSize")).toEqual([
			[0, 5, 40],
			[5, 11, 20],
		]);
		expect(fn("textDecoration")).toEqual([
			[0, 5, "UNDERLINE"],
			[5, 11, "NONE"],
		]);
		expect(fn("letterSpacing")[0]).toEqual([
			0,
			5,
			{ unit: "PERCENT", value: -2 },
		]);
		expect(fn("lineHeight")[1]).toEqual([5, 11, { unit: "PIXELS", value: 48 }]);
		expect(fn("fills")).toHaveLength(2);
		// every font is loaded before the text is written
		expect(sb.fake.loadedFonts).toContainEqual({
			family: "Geist",
			style: "SemiBold",
		});

		expect(img).toMatchObject({
			type: "RECTANGLE",
			width: 30,
			height: 40,
			cornerRadius: 5,
			fills: [{ type: "IMAGE", imageHash: "HASH", scaleMode: "FILL" }],
		});
	});

	it("fits a vector's svg uniformly into its box", async () => {
		const { sb } = deckWithOneSlide();
		const res = (await sb.run({
			cmd: "buildSlide",
			slide: slideMeta(),
			ops: [
				{
					op: "vector",
					id: "v",
					parent: null,
					name: "Vector #v",
					props: { x: 10, y: 20, w: 48, h: 96, svg: "<svg/>", opacity: 0.8 },
				},
			],
		})) as { slideId: string };
		const v = sb.fake.nodes.get(res.slideId)?.children[0];
		expect(v?.rescaled).toBe(2); // 24x24 -> min(48/24, 96/24)
		expect(v).toMatchObject({
			width: 48,
			height: 48,
			opacity: 0.8,
			x: 10,
			y: 44,
		});
		expect(v?.getPluginData("importId")).toBe("v");
	});

	it("reports an op that fails instead of aborting the slide", async () => {
		const { sb } = deckWithOneSlide();
		const res = (await sb.run({
			cmd: "buildSlide",
			slide: slideMeta(),
			ops: [
				{
					op: "vector",
					id: "bad",
					parent: null,
					name: "Vector #bad",
					props: { x: 0, y: 0, w: 10, h: 10, svg: "BAD" },
				},
				{
					op: "frame",
					id: "kid",
					parent: "bad",
					name: "Frame #kid",
					props: { x: 0, y: 0, w: 1, h: 1, fills: [] },
				},
				frameOp("ok", null),
			],
		})) as { slideId: string; warnings: string[] };
		const slide = sb.fake.nodes.get(res.slideId);
		expect(slide?.children.map((c) => c.name)).toEqual(["Frame #ok"]);
		expect(
			res.warnings.some((w) => w.includes("bad") && w.includes("Invalid SVG")),
		).toBe(true);
		expect(res.warnings.some((w) => w.includes("kid"))).toBe(true);
	});

	it("falls back to Inter when a font is missing and says so", async () => {
		const { sb } = deckWithOneSlide();
		sb.fake.missingFamilies.add("Geist");
		const res = (await sb.run({
			cmd: "buildSlide",
			slide: slideMeta(),
			ops: [textOp("t", null)],
		})) as { slideId: string; warnings: string[] };
		const t = sb.fake.nodes.get(res.slideId)?.children[0];
		expect(t?.rangeFonts[0].font).toEqual({
			family: "Inter",
			style: "Semi Bold",
		});
		expect(res.warnings).toContain(
			"font-fallback:Geist|SemiBold->Inter Semi Bold",
		);
	});

	it("inserts at the first replaced slide's grid position and removes the replaced ones", async () => {
		const sb = new Sandbox();
		const s1 = sb.fake.addSlide("One");
		const s2 = sb.fake.addSlide("Two");
		const s3 = sb.fake.addSlide("Three");
		sb.fake.rows.push([]); // a second row
		const s4 = sb.fake.addSlide("Four");
		const res = (await sb.run({
			cmd: "buildSlide",
			slide: slideMeta({ name: "New" }),
			ops: [],
			replaceIds: [s2.id, s3.id],
		})) as { slideId: string };
		expect(sb.fake.gridIds()).toEqual([[s1.id, res.slideId], [s4.id]]);
		expect(s2.removed).toBe(true);
		expect(s3.removed).toBe(true);
		expect(s1.removed).toBe(false);
	});

	it("inserts after a given slide", async () => {
		const sb = new Sandbox();
		const s1 = sb.fake.addSlide("One");
		const s2 = sb.fake.addSlide("Two");
		const res = (await sb.run({
			cmd: "buildSlide",
			slide: slideMeta(),
			ops: [],
			afterId: s1.id,
		})) as { slideId: string };
		expect(sb.fake.gridIds()).toEqual([[s1.id, res.slideId, s2.id]]);
	});
});

describe("runtime font resolution", () => {
	const run = (family: string, style: string, start: number, end: number) => ({
		start,
		end,
		family,
		style,
		fontSize: 20,
		fills: GREY,
		letterSpacing: { unit: "PERCENT", value: 0 },
		lineHeight: { unit: "PIXELS", value: 24 },
		decoration: "NONE",
	});
	async function build(runs: ReturnType<typeof run>[], sb?: Sandbox) {
		const box = sb ?? deckWithOneSlide().sb;
		const res = (await box.run({
			cmd: "buildSlide",
			slide: slideMeta(),
			ops: [
				textOp("t", null, {
					text: "x".repeat(runs[runs.length - 1].end),
					runs,
				}),
			],
		})) as { slideId: string; warnings: string[] };
		const t = box.fake.nodes.get(res.slideId)?.children[0];
		return {
			box,
			warnings: res.warnings,
			fonts: t?.rangeFonts.map((r: { font: unknown }) => r.font),
		};
	}

	it("maps canonical style names onto each family's own spelling", async () => {
		const r = await build([
			run("Inter", "SemiBold", 0, 1),
			run("Inter", "ExtraBold", 1, 2),
			run("Inter", "ExtraLight", 2, 3),
			run("Inter", "BoldItalic", 3, 4),
			run("Geist", "SemiBold", 4, 5),
		]);
		expect(r.fonts).toEqual([
			{ family: "Inter", style: "Semi Bold" },
			{ family: "Inter", style: "Extra Bold" },
			{ family: "Inter", style: "Extra Light" },
			{ family: "Inter", style: "Bold Italic" },
			{ family: "Geist", style: "SemiBold" },
		]);
		expect(r.warnings).toEqual([
			"font-fallback:Inter|SemiBold->Inter Semi Bold",
			"font-fallback:Inter|ExtraBold->Inter Extra Bold",
			"font-fallback:Inter|ExtraLight->Inter Extra Light",
			"font-fallback:Inter|BoldItalic->Inter Bold Italic",
		]); // Geist SemiBold is exact: no warning
	});

	it("takes the nearest weight of the same family before Inter", async () => {
		const { sb } = deckWithOneSlide();
		sb.fake.availableFonts.push(
			{ family: "Foo", style: "Regular" },
			{ family: "Foo", style: "Bold" },
		);
		const r = await build(
			[run("Foo", "SemiBold", 0, 1), run("Foo", "Light", 1, 2)],
			sb,
		);
		expect(r.fonts).toEqual([
			{ family: "Foo", style: "Bold" },
			{ family: "Foo", style: "Regular" },
		]);
		expect(r.warnings).toEqual([
			"font-fallback:Foo|SemiBold->Foo Bold",
			"font-fallback:Foo|Light->Foo Regular",
		]);
	});

	it("prefers the same slant when picking the nearest weight", async () => {
		const { sb } = deckWithOneSlide();
		sb.fake.availableFonts.push(
			{ family: "Foo", style: "Regular" },
			{ family: "Foo", style: "Italic" },
			{ family: "Foo", style: "Bold" },
			{ family: "Foo", style: "Bold Italic" },
		);
		const r = await build(
			[run("Foo", "SemiBold Italic", 0, 1), run("Foo", "Medium", 1, 2)],
			sb,
		);
		expect(r.fonts).toEqual([
			{ family: "Foo", style: "Bold Italic" },
			{ family: "Foo", style: "Regular" },
		]);
	});

	it("falls back to Inter in its own spelling when the family is not installed", async () => {
		const r = await build([run("Nope", "ExtraBold", 0, 1)]);
		expect(r.fonts).toEqual([{ family: "Inter", style: "Extra Bold" }]);
		expect(r.warnings).toEqual([
			"font-fallback:Nope|ExtraBold->Inter Extra Bold",
		]);
	});

	it("lists the installed fonts once per call", async () => {
		const { sb } = deckWithOneSlide();
		let listed = 0;
		const api = sb.fake.api;
		sb.fake.api = () => {
			const f = api.call(sb.fake);
			const list = f.listAvailableFontsAsync;
			f.listAvailableFontsAsync = async () => {
				listed++;
				return list();
			};
			return f;
		};
		sb.reset();
		await build(
			[run("Inter", "SemiBold", 0, 1), run("Geist", "Bold", 1, 2)],
			sb,
		);
		expect(listed).toBe(1);
	});

	it("still loads fonts when the list is unavailable", async () => {
		const { sb } = deckWithOneSlide();
		const api = sb.fake.api;
		sb.fake.api = () => {
			const f = api.call(sb.fake);
			f.listAvailableFontsAsync = async () => {
				throw new Error("no font list");
			};
			return f;
		};
		sb.reset();
		const r = await build([run("Geist", "SemiBold", 0, 1)], sb);
		expect(r.fonts).toEqual([{ family: "Geist", style: "SemiBold" }]);
		expect(r.warnings).toEqual([]);
	});
});

describe("runtime makeEntrance", () => {
	async function built() {
		const { sb } = deckWithOneSlide();
		const res = (await sb.run({
			cmd: "buildSlide",
			slide: slideMeta(),
			ops: [
				frameOp("s0-n1", null),
				textOp("s0-n3", "s0-n1"),
				frameOp("s0-n4", null, { x: 0, y: 0, w: 200, h: 100 }),
			],
		})) as { slideId: string };
		return { sb, slideId: res.slideId };
	}

	it("clones before the original, applies the start state to the copy only, sets both transitions", async () => {
		const { sb, slideId } = await built();
		const original = sb.fake.nodes.get(slideId);
		const origText = original?.children[0].children[0];
		const res = (await sb.run({
			cmd: "makeEntrance",
			slideId,
			start: { "s0-n3": { opacity: 0, dy: 24 } },
			transition: { duration: 0.6, curve: "EASE_IN_AND_OUT" },
		})) as { enterSlideId: string };

		const copy = sb.fake.nodes.get(res.enterSlideId);
		expect(copy?.name).toBe("Title · enter");
		expect(sb.fake.gridIds()[0].slice(-2)).toEqual([res.enterSlideId, slideId]);

		const copyText = copy?.findAll(
			(n) => n.getPluginData("importId") === "s0-n3",
		)[0];
		expect(copyText?.opacity).toBe(0);
		expect(copyText?.y).toBe(origText?.y !== undefined ? origText.y + 24 : NaN);
		expect(origText?.opacity).toBe(1);
		expect(origText?.y).toBe(30);
		// untouched nodes of the copy keep their state
		const copyFrame = copy?.findAll(
			(n) => n.getPluginData("importId") === "s0-n4",
		)[0];
		expect(copyFrame?.opacity).toBe(1);

		expect(copy?.transition).toEqual(NONE_T);
		expect(original?.transition).toEqual({
			style: "SMART_ANIMATE",
			duration: 0.6,
			curve: "EASE_IN_AND_OUT",
			timing: { type: "AFTER_DELAY", delay: 0 },
		});
	});

	it("scales about the node's centre and can target several ids", async () => {
		const { sb, slideId } = await built();
		const res = (await sb.run({
			cmd: "makeEntrance",
			slideId,
			start: {
				"s0-n1": { scale: 0.5, dx: 10 },
				"s0-n4": { opacity: 0, scale: 0 },
			},
			transition: { duration: 0.3, curve: "EASE_OUT" },
		})) as { enterSlideId: string };
		const copy = sb.fake.nodes.get(res.enterSlideId);
		const f = copy?.findAll((n) => n.getPluginData("importId") === "s0-n1")[0];
		// 500x300 at (100,200) scaled 0.5 about (350,350): 250x150 at (225,275), then +10
		expect(f).toMatchObject({ width: 250, height: 150, x: 235, y: 275 });
		const g = copy?.findAll((n) => n.getPluginData("importId") === "s0-n4")[0];
		expect(g?.opacity).toBe(0);
		expect(g?.rescaled).toBe(0.01); // clamped, Figma cannot size to 0
	});

	it("removes the start copy and leaves the original alone when the copy's transition fails", async () => {
		const { sb, slideId } = await built();
		const before = sb.fake.gridIds();
		const original = sb.fake.nodes.get(slideId);
		const transition = original?.transition;
		sb.fake.onClone = (c) => {
			if (c.type === "SLIDE")
				c.setSlideTransition = () => {
					throw new Error("transitions unavailable");
				};
		};
		await expect(
			sb.run({
				cmd: "makeEntrance",
				slideId,
				start: { "s0-n3": { opacity: 0 } },
				transition: { duration: 0.5, curve: "EASE_OUT" },
			}),
		).rejects.toThrow("transitions unavailable");
		expect(sb.fake.gridIds()).toEqual(before);
		expect(
			sb.fake.pageSlides.filter((x) => !x.removed && x.name.endsWith("enter")),
		).toEqual([]);
		expect(original?.transition).toEqual(transition);
	});

	it("removes the start copy when the original's transition fails after the copy's succeeded", async () => {
		const { sb, slideId } = await built();
		const before = sb.fake.gridIds();
		const original = sb.fake.nodes.get(slideId);
		const transition = original?.transition;
		if (original)
			original.setSlideTransition = () => {
				throw new Error("smart animate unavailable");
			};
		await expect(
			sb.run({
				cmd: "makeEntrance",
				slideId,
				start: {},
				transition: { duration: 0.5, curve: "EASE_OUT" },
			}),
		).rejects.toThrow("smart animate unavailable");
		expect(sb.fake.gridIds()).toEqual(before);
		expect(
			sb.fake.pageSlides.filter((x) => !x.removed && x.name.endsWith("enter")),
		).toEqual([]);
		expect(original?.transition).toEqual(transition);
	});

	it("never sets a duration below 0.01", async () => {
		const { sb, slideId } = await built();
		await sb.run({
			cmd: "makeEntrance",
			slideId,
			start: {},
			transition: { duration: 0, curve: "LINEAR" },
		});
		expect(sb.fake.nodes.get(slideId)?.transition).toMatchObject({
			duration: 0.01,
		});
	});
});

describe("runtime uploadChunk", () => {
	const bytes = Buffer.from(Array.from({ length: 30 }, (_, i) => i * 7));
	const parts = [
		bytes.subarray(0, 12),
		bytes.subarray(12, 24),
		bytes.subarray(24),
	];
	const send = (sb: Sandbox, i: number, total = 3, key = "img") =>
		sb.run({
			cmd: "uploadChunk",
			key,
			index: i,
			total,
			b64: parts[i].toString("base64"),
		}) as Promise<{ hash?: string; error?: string }>;

	it("creates one image from three chunks and returns its hash on the last", async () => {
		const sb = new Sandbox();
		expect((await send(sb, 0)).hash).toBeUndefined();
		expect((await send(sb, 1)).hash).toBeUndefined();
		expect(sb.fake.images).toHaveLength(0);
		const last = await send(sb, 2);
		expect(last.hash).toBe("hash1");
		expect(sb.fake.images).toHaveLength(1);
		expect(Buffer.from(sb.fake.images[0]).equals(bytes)).toBe(true);
	});

	it("reports 'chunks lost' when the context was wiped mid-upload", async () => {
		const sb = new Sandbox();
		await send(sb, 0);
		sb.reset();
		expect(await send(sb, 1)).toEqual({ error: "chunks lost" });
		expect(sb.fake.images).toHaveLength(0);
	});

	it("accepts a whole image as a single chunk", async () => {
		const sb = new Sandbox();
		const r = (await sb.run({
			cmd: "uploadChunk",
			key: "k",
			index: 0,
			total: 1,
			b64: bytes.toString("base64"),
		})) as { hash: string };
		expect(r.hash).toBe("hash1");
		expect(Buffer.from(sb.fake.images[0]).equals(bytes)).toBe(true);
	});

	it("keeps uploads with different keys apart", async () => {
		const sb = new Sandbox();
		await send(sb, 0, 3, "a");
		await send(sb, 0, 3, "b");
		await send(sb, 1, 3, "a");
		await send(sb, 1, 3, "b");
		expect((await send(sb, 2, 3, "a")).hash).toBe("hash1");
		expect((await send(sb, 2, 3, "b")).hash).toBe("hash2");
	});
});

describe("runtime dump", () => {
	it("returns the tree with importId from pluginData, nested children and absolute boxes", async () => {
		const { sb } = deckWithOneSlide();
		const res = (await sb.run({
			cmd: "buildSlide",
			slide: slideMeta({ background: GREY }),
			ops: [
				frameOp("s0-n1", null, {
					clip: true,
					strokes: { paints: GREY, weights: [1, 1, 1, 1], dashed: false },
					effects: [{ type: "LAYER_BLUR", radius: 2, visible: true }],
				}),
				textOp("s0-n2", "s0-n1"),
				{
					op: "image",
					id: "s0-n3",
					parent: "s0-n1",
					name: "Image #s0-n3",
					props: { x: 0, y: 0, w: 10, h: 10, hash: "H", scaleMode: "FILL" },
				},
			],
		})) as { slideId: string };
		const slide = sb.fake.nodes.get(res.slideId);
		// the fake does not lay text out: pretend Figma wrapped it onto 2 lines of 48px
		slide!.children[0].children[0].height = 96;

		const d = (await sb.run({ cmd: "dump", slideId: res.slideId })) as any;
		expect(d).toMatchObject({
			id: res.slideId,
			importId: null,
			type: "SLIDE",
			name: "Title",
			box: { x: 0, y: 0, w: 1920, h: 1080 },
			visible: true,
		});
		expect(d.children).toHaveLength(1);
		const f = d.children[0];
		expect(f).toMatchObject({
			importId: "s0-n1",
			type: "FRAME",
			name: "Frame #s0-n1",
			box: { x: 100, y: 200, w: 500, h: 300 },
			fills: [{ type: "SOLID", hasImage: false }],
			strokes: 1,
			effects: 1,
			clips: true,
		});
		expect(f.children.map((c: any) => c.importId)).toEqual(["s0-n2", "s0-n3"]);
		const [t, img] = f.children;
		expect(t.box).toEqual({ x: 120, y: 230, w: 300, h: 96 });
		expect(t.text).toEqual({
			chars: "Hello world",
			lineCount: 2,
			fonts: ["Geist SemiBold", "Geist Regular"],
		});
		expect(img.fills).toEqual([{ type: "IMAGE", hasImage: true }]);
		expect(img.text).toBeUndefined();
		expect(img.children).toEqual([]);
	});

	it("rejects an unknown node", async () => {
		const sb = new Sandbox();
		await expect(sb.run({ cmd: "dump", slideId: "9:9" })).rejects.toThrow(
			"Node not found",
		);
	});
});

describe("runtime patch", () => {
	it("applies the same prop setters to one node", async () => {
		const { sb } = deckWithOneSlide();
		const res = (await sb.run({
			cmd: "buildSlide",
			slide: slideMeta(),
			ops: [frameOp("f", null), textOp("t", "f")],
		})) as { slideId: string };
		const f = sb.fake.nodes.get(res.slideId)?.children[0];
		const t = f?.children[0];

		await sb.run({
			cmd: "patch",
			nodeId: f?.id,
			props: {
				x: 5,
				y: 6,
				w: 70,
				h: 80,
				opacity: 0.3,
				radii: [9, 9, 9, 9],
				clip: true,
			},
		});
		expect(f).toMatchObject({
			x: 5,
			y: 6,
			width: 70,
			height: 80,
			opacity: 0.3,
			cornerRadius: 9,
			clipsContent: true,
		});

		await sb.run({
			cmd: "patch",
			nodeId: t?.id,
			props: {
				w: 250,
				text: "Hi",
				lineHeightPx: 30,
				runs: [
					{
						start: 0,
						end: 2,
						family: "Geist",
						style: "Bold",
						fontSize: 24,
						fills: GREY,
						letterSpacing: { unit: "PERCENT", value: 0 },
						lineHeight: { unit: "PIXELS", value: 30 },
						decoration: "NONE",
					},
				],
			},
		});
		expect(t).toMatchObject({
			characters: "Hi",
			width: 250,
			textAutoResize: "HEIGHT",
		});
		expect(t?.getPluginData("lineHeightPx")).toBe("30");
		expect(t?.rangeFonts[t.rangeFonts.length - 1].font).toEqual({
			family: "Geist",
			style: "Bold",
		});
	});

	it("rejects an unknown node", async () => {
		const sb = new Sandbox();
		await expect(
			sb.run({ cmd: "patch", nodeId: "9:9", props: {} }),
		).rejects.toThrow("Node not found");
	});

	it("rejects an unknown command", async () => {
		const sb = new Sandbox();
		await expect(sb.run({ cmd: "nope" })).rejects.toThrow("Unknown");
	});
});
