import { emittedIds, normalizeSlide, ownerMap } from "../../src/core/deck-import/normalize.js";
import type { NodeIR, RawNode, TextRun } from "../../src/core/deck-import/types.js";

// Computed-style defaults, as walker.page.ts emits them for an unstyled element.
const PLAIN: Record<string, string> = {
	backgroundColor: "rgba(0, 0, 0, 0)",
	backgroundImage: "none",
	borderTopWidth: "0px",
	borderRightWidth: "0px",
	borderBottomWidth: "0px",
	borderLeftWidth: "0px",
	borderTopColor: "rgb(0, 0, 0)",
	borderRightColor: "rgb(0, 0, 0)",
	borderBottomColor: "rgb(0, 0, 0)",
	borderLeftColor: "rgb(0, 0, 0)",
	borderStyle: "none",
	borderTopLeftRadius: "0px",
	borderTopRightRadius: "0px",
	borderBottomRightRadius: "0px",
	borderBottomLeftRadius: "0px",
	boxShadow: "none",
	opacity: "1",
	overflow: "visible",
	transform: "none",
	backdropFilter: "none",
	filter: "none",
	clipPath: "none",
	mixBlendMode: "normal",
	maskImage: "none",
	objectFit: "fill",
};
const BOX = { x: 100, y: 200, w: 300, h: 400 };

const section = (style: Record<string, string> = {}): RawNode => ({
	id: "s0-n0",
	parentId: null,
	tag: "section",
	box: { x: 0, y: 0, w: 1920, h: 1080 },
	style: { ...PLAIN, ...style },
});
const el = (
	id: string,
	parentId: string,
	style: Record<string, string> = {},
	extra: Partial<RawNode> = {},
): RawNode => ({
	id,
	parentId,
	tag: "div",
	box: BOX,
	style: { ...PLAIN, ...style },
	...extra,
});
const run = (chars: string): TextRun => ({
	chars,
	fontFamily: "Inter",
	fontWeight: 400,
	fontStyle: "normal",
	fontSize: 24,
	color: "rgb(0, 0, 0)",
	letterSpacing: "normal",
	lineHeight: "normal",
	textDecoration: "none",
});
// What the walker emits for an element with direct text: a child node tagged #text-block.
const tb = (
	id: string,
	parentId: string,
	chars: string,
	style: Record<string, string> = {},
): RawNode => ({
	id,
	parentId,
	tag: "#text-block",
	box: BOX,
	style: { textAlign: "start", ...style },
	text: { runs: [run(chars)], lineCount: 1 },
});
const WHITE = "rgb(255, 255, 255)";
const meta = { index: 0, name: "Slide", skipped: false, notes: "" };
const norm = (...nodes: RawNode[]) => normalizeSlide([section(), ...nodes], meta);
const only = (...nodes: RawNode[]) => norm(...nodes).root;

describe("normalizeSlide", () => {
	it("copies meta and uses the section's background", () => {
		const s = normalizeSlide(
			[
				section({
					backgroundColor: "rgb(255, 0, 0)",
					backgroundImage: "linear-gradient(rgb(0, 0, 0), rgb(255, 255, 255))",
				}),
			],
			{ index: 3, name: "Intro", skipped: true, notes: "hello" },
		);
		expect(s).toMatchObject({ index: 3, name: "Intro", skipped: true, notes: "hello", root: [] });
		expect(s.background.map((p) => p.type)).toEqual(["SOLID", "GRADIENT_LINEAR"]);
		expect("entrance" in s).toBe(false);
	});

	it("hoists text out of non-drawing wrapper chains", () => {
		const root = only(
			el("s0-n1", "s0-n0"),
			el("s0-n2", "s0-n1"),
			tb("s0-n3", "s0-n2", "Hello"),
		);
		expect(root).toHaveLength(1);
		expect(root[0]).toMatchObject({ kind: "text", id: "s0-n3" });
	});

	it("keeps a drawing wrapper and hoists its plain child to it", () => {
		const root = only(
			el("s0-n1", "s0-n0", { backgroundColor: WHITE, borderTopLeftRadius: "24px" }),
			el("s0-n2", "s0-n1"),
			tb("s0-n3", "s0-n2", "Hello"),
		);
		expect(root).toHaveLength(1);
		const f = root[0];
		if (f.kind !== "frame") throw new Error("expected frame");
		expect(f.fills).toEqual([{ type: "SOLID", color: { r: 1, g: 1, b: 1, a: 1 } }]);
		expect(f.radii).toEqual([24, 0, 0, 0]);
		expect(f.children.map((c) => [c.kind, c.id])).toEqual([["text", "s0-n3"]]);
	});

	it("keeps a drawing element with direct text as frame + text-block child", () => {
		const root = only(
			el("s0-n1", "s0-n0", { backgroundColor: WHITE }),
			tb("s0-n2", "s0-n1", "Hi"),
		);
		expect(root).toMatchObject([{ kind: "frame", children: [{ kind: "text", id: "s0-n2" }] }]);
	});

	it("keeps a drawing frame with a single child", () => {
		const root = only(
			el("s0-n1", "s0-n0", { backgroundColor: WHITE }),
			el("s0-n2", "s0-n1", { backgroundColor: "rgb(0, 0, 0)" }),
		);
		expect(root).toMatchObject([{ kind: "frame", children: [{ kind: "frame", id: "s0-n2" }] }]);
	});

	it("preserves text characters (emoji, nbsp, newline)", () => {
		const chars = "Hi 👋 there\nnext";
		const root = only(tb("s0-n1", "s0-n0", chars));
		expect(root[0]).toMatchObject({ kind: "text", runs: [{ chars }], lineCount: 1 });
	});

	it("maps text-align", () => {
		const align = (textAlign: string) =>
			(only(tb("s0-n1", "s0-n0", "x", { textAlign }))[0] as { align: string }).align;
		expect(["start", "left", "center", "right", "end", "justify", "weird"].map(align)).toEqual([
			"LEFT",
			"LEFT",
			"CENTER",
			"RIGHT",
			"RIGHT",
			"JUSTIFIED",
			"LEFT",
		]);
	});

	it("applies text-transform, which the IR cannot carry", () => {
		const chars = (textTransform: string, text = "hello big wOrld") => {
			const n = only(tb("s0-n1", "s0-n0", text, { textTransform }))[0];
			return n.kind === "text" ? n.runs[0].chars : "";
		};
		expect(chars("uppercase")).toBe("HELLO BIG WORLD");
		expect(chars("lowercase", "AbC")).toBe("abc");
		expect(chars("capitalize")).toBe("Hello Big WOrld");
		expect(chars("none")).toBe("hello big wOrld");
	});

	it("capitalizes across run boundaries without restarting mid-word", () => {
		const t = tb("s0-n1", "s0-n0", "", { textTransform: "capitalize" });
		t.text = { runs: [run("hel"), run("lo wor"), run("ld")], lineCount: 1 };
		const n = only(t)[0];
		expect(n.kind === "text" && n.runs.map((r) => r.chars)).toEqual(["Hel", "lo Wor", "ld"]);
	});

	it("drops hidden nodes together with visible descendants", () => {
		const root = only(
			el("s0-n1", "s0-n0", { backgroundColor: WHITE }, { hidden: true }),
			tb("s0-n2", "s0-n1", "ghost"),
			el("s0-n3", "s0-n1", { backgroundColor: WHITE }),
		);
		expect(root).toEqual([]);
	});

	it("drops a hidden text block but keeps its owner's other content", () => {
		const hiddenTb = { ...tb("s0-n2", "s0-n1", "x"), hidden: true };
		const root = only(el("s0-n1", "s0-n0", { backgroundColor: WHITE }), hiddenTb);
		expect(root).toMatchObject([{ kind: "frame", children: [] }]);
	});

	it("turns a loop node into a single gif and discards its subtree", () => {
		const root = only(
			el("s0-n1", "s0-n0", {}, { loop: true }),
			el("s0-n2", "s0-n1", { backgroundColor: WHITE }),
			el("s0-n3", "s0-n2", { backgroundColor: WHITE }),
			tb("s0-n4", "s0-n2", "a"),
			tb("s0-n5", "s0-n3", "b"),
			el("s0-n6", "s0-n1", {}, { svg: "<svg/>" }),
		);
		expect(root).toEqual([
			{
				kind: "gif",
				id: "s0-n1",
				box: BOX,
				gifKey: "s0-n1",
				radii: [0, 0, 0, 0],
				flags: [],
			},
		]);
	});

	it("carries the loop owner's corner radii into the gif", () => {
		const root = only(
			el(
				"s0-n1",
				"s0-n0",
				{
					borderTopLeftRadius: "24px",
					borderTopRightRadius: "12px",
					borderBottomRightRadius: "50%",
					borderBottomLeftRadius: "0px",
				},
				{ loop: true },
			),
		);
		// 50% of a 300x400 box, clamped to half the short side
		expect(root).toMatchObject([
			{ kind: "gif", radii: [24, 12, 150, 0] },
		]);
	});

	it("keeps a loop node as gif even when the walker marked it hidden", () => {
		const root = only(
			el("s0-n1", "s0-n0", {}, { loop: true, hidden: true, box: { x: 10, y: 10, w: 0, h: 0 } }),
			tb("s0-n2", "s0-n1", "x"),
		);
		expect(root).toMatchObject([{ kind: "gif", id: "s0-n1", gifKey: "s0-n1" }]);
	});

	it("maps a slot without src to a named slot", () => {
		const root = only(
			el("s0-n1", "s0-n0", { borderTopLeftRadius: "12px" }, {
				tag: "image-slot",
				slot: { placeholder: "Photo: test", shape: "rounded" },
			}),
		);
		expect(root).toEqual([
			{
				kind: "slot",
				id: "s0-n1",
				box: BOX,
				name: "Image slot · Photo: test",
				radii: [12, 0, 0, 0],
				flags: [],
			},
		]);
	});

	it("maps a slot with src to an image", () => {
		const root = only(
			el("s0-n1", "s0-n0", {}, {
				tag: "image-slot",
				slot: { placeholder: "p", shape: "rounded", src: "http://x/a.png" },
			}),
		);
		expect(root).toMatchObject([
			{ kind: "image", src: "http://x/a.png", scaleMode: "FILL", flags: [] },
		]);
	});

	it("maps img object-fit", () => {
		const img = (objectFit: string) =>
			only(
				el("s0-n1", "s0-n0", {}, {
					tag: "img",
					img: { src: "http://x/a.png", naturalW: 10, naturalH: 10, objectFit },
				}),
			)[0] as Extract<NodeIR, { kind: "image" }>;
		expect(img("cover")).toMatchObject({ scaleMode: "FILL", flags: [] });
		expect(img("contain")).toMatchObject({ scaleMode: "FIT", flags: [] });
		expect(img("fill")).toMatchObject({ scaleMode: "FILL", flags: ["object-fit:fill"] });
		expect(img("scale-down")).toMatchObject({ scaleMode: "FIT", flags: ["object-fit:scale-down"] });
		expect(img("none")).toMatchObject({ scaleMode: "FILL", flags: ["object-fit:none"] });
	});

	it("doesn't flag object-fit fill when the box keeps the image's aspect ratio", () => {
		const [n] = only(
			el("s0-n1", "s0-n0", {}, {
				tag: "img",
				img: { src: "http://x/a.png", naturalW: 30.2, naturalH: 40, objectFit: "fill" },
			}),
		) as Extract<NodeIR, { kind: "image" }>[];
		expect(n).toMatchObject({ scaleMode: "FILL", flags: [] });
	});

	it("maps svg to vector and lucide icons to an empty vector with an icon flag", () => {
		const root = only(
			el("s0-n1", "s0-n0", { opacity: "0.5" }, { tag: "svg", svg: "<svg></svg>" }),
			el("s0-n2", "s0-n0", {}, { tag: "i", iconClass: "icon-phone" }),
		);
		expect(root).toMatchObject([
			{ kind: "vector", svg: "<svg></svg>", opacity: 0.5, flags: [] },
			{ kind: "vector", svg: "", flags: ["icon:icon-phone"] },
		]);
	});

	it("flags clip-path on a frame", () => {
		const root = only(
			el("s0-n1", "s0-n0", { backgroundColor: WHITE, clipPath: "circle(50%)" }),
		);
		expect(root).toMatchObject([{ kind: "frame", flags: ["unsupported:clip-path"] }]);
	});

	it("keeps a non-drawing node that carries an unsupported prop, so the flag survives", () => {
		const root = only(
			el("s0-n1", "s0-n0", { mixBlendMode: "multiply", filter: "grayscale(1)", maskImage: "url(a.png)" }),
			tb("s0-n2", "s0-n1", "x"),
		);
		expect(root).toMatchObject([
			{
				kind: "frame",
				fills: [],
				flags: ["unsupported:mask-image", "unsupported:mix-blend-mode", "unsupported:filter"],
				children: [{ kind: "text" }],
			},
		]);
	});

	it("flags css background images (url) that cannot be imported", () => {
		const root = only(el("s0-n1", "s0-n0", { backgroundImage: 'url("http://x/a.png")' }));
		expect(root).toMatchObject([{ kind: "frame", fills: [], flags: ["unsupported:background-image"] }]);
	});

	it("flags unsupported props on leaves too", () => {
		const root = only(
			el("s0-n1", "s0-n0", { filter: "blur(4px)" }, { tag: "svg", svg: "<svg/>" }),
		);
		expect(root).toMatchObject([{ kind: "vector", flags: ["unsupported:filter"] }]);
	});

	it("maps backdrop-filter blur to BACKGROUND_BLUR with an approx flag", () => {
		const root = only(
			el("s0-n1", "s0-n0", { backdropFilter: "blur(12px) saturate(1.5)" }),
			el("s0-n2", "s0-n0", { backdropFilter: "brightness(2)" }),
		);
		expect(root).toMatchObject([
			{
				kind: "frame",
				effects: [{ type: "BACKGROUND_BLUR", radius: 24 }], // css blur(12px) = figma radius 24
				flags: ["approx:backdrop-filter"],
			},
			{ kind: "frame", effects: [], flags: ["unsupported:backdrop-filter"] },
		]);
	});

	it("turns box-shadow into effects and keeps the node", () => {
		const root = only(
			el("s0-n1", "s0-n0", { boxShadow: "rgba(0, 0, 0, 0.2) 0px 4px 12px 0px" }),
		);
		expect(root).toMatchObject([
			{ kind: "frame", effects: [{ type: "DROP_SHADOW", x: 0, y: 4, blur: 12, spread: 0 }] },
		]);
	});

	it("builds strokes from border widths and colors", () => {
		const root = only(
			el("s0-n1", "s0-n0", {
				borderTopWidth: "0px",
				borderRightWidth: "2px",
				borderBottomWidth: "3px",
				borderLeftWidth: "0px",
				borderRightColor: "rgb(255, 0, 0)",
				borderBottomColor: "rgb(0, 0, 255)",
				borderStyle: "none dashed solid none",
			}),
		);
		expect(root).toMatchObject([
			{
				kind: "frame",
				strokes: { color: { r: 1, g: 0, b: 0, a: 1 }, weights: [0, 2, 3, 0], dashed: true },
			},
		]);
	});

	it("ignores borders with a transparent color", () => {
		const root = only(
			el("s0-n1", "s0-n0", {
				borderTopWidth: "1px",
				borderTopColor: "rgba(0, 0, 0, 0)",
			}),
		);
		expect(root).toEqual([]);
	});

	it("keeps overflow clipping only when there are children", () => {
		const root = only(
			el("s0-n1", "s0-n0", { overflow: "hidden" }),
			tb("s0-n2", "s0-n1", "x"),
			el("s0-n3", "s0-n0", { overflow: "hidden" }),
		);
		expect(root).toMatchObject([{ kind: "frame", id: "s0-n1", clip: true, children: [{ kind: "text" }] }]);
	});

	it("keeps a translucent wrapper as a frame so its opacity survives", () => {
		const root = only(
			el("s0-n1", "s0-n0", { opacity: "0.4" }),
			tb("s0-n2", "s0-n1", "x"),
		);
		expect(root).toMatchObject([{ kind: "frame", opacity: 0.4, children: [{ kind: "text" }] }]);
	});

	it("keeps DOM order across hoisted siblings", () => {
		const root = only(
			tb("s0-n1", "s0-n0", "a"),
			el("s0-n2", "s0-n0"),
			tb("s0-n3", "s0-n2", "b"),
			tb("s0-n4", "s0-n2", "c"),
			tb("s0-n5", "s0-n0", "d"),
		);
		expect(root.map((n) => n.id)).toEqual(["s0-n1", "s0-n3", "s0-n4", "s0-n5"]);
	});

	it("returns an empty slide when there is no root node", () => {
		expect(normalizeSlide([], meta)).toMatchObject({ background: [], root: [], flags: [] });
	});

	it("reports the section's own unsupported props as slide flags", () => {
		expect(norm().flags).toEqual([]);
		const s = normalizeSlide([section({ filter: "blur(2px)" })], meta);
		expect(s.flags).toEqual(["unsupported:filter"]);
	});
});

describe("features that used to vanish silently", () => {
	const flagsOfRoot = (...nodes: RawNode[]) => norm(...nodes);

	it("flags a rotated or skewed element, but not a translated or scaled one", () => {
		const flagged = (transform: string) =>
			(
				only(
					el("s0-n1", "s0-n0", { backgroundColor: WHITE, transform }),
				)[0] as { flags: string[] }
			).flags;
		expect(flagged("matrix(0.9848, 0.1736, -0.1736, 0.9848, 0, 0)")).toEqual([
			"unsupported:transform-rotate",
		]);
		expect(flagged("matrix(1, 0, 0.3, 1, 0, 0)")).toEqual([
			"unsupported:transform-rotate",
		]); // skew
		expect(
			flagged(
				"matrix3d(0.9848, 0.1736, 0, 0, -0.1736, 0.9848, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1)",
			),
		).toEqual(["unsupported:transform-rotate"]);
		expect(flagged("matrix(1, 0, 0, 1, 40, -10)")).toEqual([]);
		expect(flagged("matrix(2, 0, 0, 0.5, 0, 0)")).toEqual([]);
		expect(flagged("matrix3d(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 5, 6, 0, 1)")).toEqual([]);
		expect(flagged("none")).toEqual([]);
	});

	it("turns a pseudo-element mark into one slide flag, ignoring hidden nodes", () => {
		const pseudo = { pseudo: true };
		const s = flagsOfRoot(
			el("s0-n1", "s0-n0", { backgroundColor: WHITE }, pseudo),
			el("s0-n2", "s0-n0", {}, pseudo),
			el("s0-n3", "s0-n0", {}, { ...pseudo, hidden: true }),
		);
		expect(s.flags).toEqual(["unsupported:pseudo-element"]);
		// the marks do not change what is emitted
		expect(s.root).toMatchObject([{ kind: "frame", id: "s0-n1", flags: [] }]);
		expect(
			flagsOfRoot(el("s0-n1", "s0-n0", {}, { pseudo: true, hidden: true })).flags,
		).toEqual([]);
		// a pseudo-element on the slide itself counts too
		const onSlide = normalizeSlide([{ ...section(), pseudo: true }], meta);
		expect(onSlide.flags).toEqual(["unsupported:pseudo-element"]);
	});

	it("flags canvas, video, iframe, object, embed and audio leaves on the slide", () => {
		const tags = ["canvas", "video", "iframe", "object", "embed", "audio"];
		const s = flagsOfRoot(
			...tags.map((tag, i) => el(`s0-n${i + 1}`, "s0-n0", {}, { tag })),
		);
		expect(s.flags).toEqual(tags.map((t) => `unsupported:${t}`));
		expect(s.root).toEqual([]); // still not drawn, but no longer silent
	});

	it("does not flag a hidden unsupported leaf or one recorded as a loop gif", () => {
		const s = flagsOfRoot(
			el("s0-n1", "s0-n0", {}, { tag: "video", hidden: true }),
			el("s0-n2", "s0-n0", {}, { tag: "canvas", loop: true }),
		);
		expect(s.flags).toEqual([]);
		expect(s.root).toMatchObject([{ kind: "gif", id: "s0-n2" }]);
	});
});

describe("background-clip: text", () => {
	const GRADIENT = "linear-gradient(90deg, rgb(255, 0, 0), rgb(0, 0, 255))";
	const CLIP = {
		backgroundImage: GRADIENT,
		backgroundClip: "text",
		webkitBackgroundClip: "text",
	};
	const transparent = (id: string, parentId: string, chars: string) => {
		const t = tb(id, parentId, chars);
		t.text = {
			runs: [{ ...run(chars), color: "rgba(0, 0, 0, 0)" }],
			lineCount: 1,
		};
		return t;
	};

	it("paints transparent text with the first gradient stop, drops the owner's box fill and flags it", () => {
		const s = norm(
			el("s0-n1", "s0-n0", CLIP),
			transparent("s0-n2", "s0-n1", "Gradient"),
		);
		// the gradient only shows through the glyphs: no rectangle behind the text
		expect(s.root).toHaveLength(1);
		expect(s.root[0]).toMatchObject({
			kind: "text",
			id: "s0-n2",
			runs: [{ chars: "Gradient", color: "rgba(255, 0, 0, 1)" }],
			flags: ["approx:background-clip-text"],
		});
	});

	it("takes the topmost gradient layer and skips transparent leading stops", () => {
		const css =
			"linear-gradient(90deg, rgba(0, 0, 0, 0), rgb(0, 0, 255)), linear-gradient(rgb(0, 128, 0), rgb(0, 100, 0))";
		const root = only(
			el("s0-n1", "s0-n0", { ...CLIP, backgroundImage: css }),
			transparent("s0-n2", "s0-n1", "x"),
		);
		// CSS lists the top layer first: the one with the transparent leading stop
		expect(root[0]).toMatchObject({
			runs: [{ color: "rgba(0, 0, 255, 1)" }],
		});
	});

	it("finds a clipping ancestor and uses a solid background colour when there is no gradient", () => {
		const root = only(
			el("s0-n1", "s0-n0", {
				backgroundClip: "text",
				backgroundColor: "rgb(10, 20, 30)",
			}),
			el("s0-n2", "s0-n1"),
			transparent("s0-n3", "s0-n2", "x"),
		);
		expect(root[0]).toMatchObject({
			kind: "text",
			runs: [{ color: "rgba(10, 20, 30, 1)" }],
			flags: ["approx:background-clip-text"],
		});
	});

	it("leaves visible text alone, and does nothing without background-clip: text", () => {
		const visible = only(
			el("s0-n1", "s0-n0", CLIP),
			tb("s0-n2", "s0-n1", "Solid"),
		);
		expect(visible).toMatchObject([
			{ kind: "text", runs: [{ color: "rgb(0, 0, 0)" }], flags: [] },
		]);
		const plain = only(
			el("s0-n1", "s0-n0", { backgroundImage: GRADIENT }),
			transparent("s0-n2", "s0-n1", "Ghost"),
		);
		expect(plain).toMatchObject([
			{ kind: "frame" },
		]);
		const ghost = (plain[0] as { children: NodeIR[] }).children[0];
		expect(ghost).toMatchObject({ runs: [{ color: "rgba(0, 0, 0, 0)" }], flags: [] });
	});

	it("flags text it has no colour for instead of leaving it invisible silently", () => {
		const root = only(
			el("s0-n1", "s0-n0", { backgroundClip: "text" }),
			transparent("s0-n2", "s0-n1", "x"),
		);
		expect(root[0]).toMatchObject({
			runs: [{ color: "rgba(0, 0, 0, 0)" }],
			flags: ["unsupported:background-clip-text"],
		});
	});
});

describe("ownerMap", () => {
	const nodes = [
		section(),
		el("s0-n1", "s0-n0", { backgroundColor: WHITE }), // emitted frame with direct text
		tb("s0-n2", "s0-n1", "a"),
		el("s0-n3", "s0-n1"), // hoisted wrapper
		el("s0-n4", "s0-n3"), // hoisted wrapper
		el("s0-n5", "s0-n4", { backgroundColor: WHITE }),
		el("s0-n6", "s0-n0"), // hoisted, owns a text block
		tb("s0-n7", "s0-n6", "b"),
		el("s0-n8", "s0-n0", {}, { loop: true }),
		el("s0-n9", "s0-n8", { backgroundColor: WHITE }),
		el("s0-n10", "s0-n0", { backgroundColor: WHITE }, { hidden: true }),
		el("s0-n11", "s0-n10", { backgroundColor: WHITE }),
		el("s0-n12", "s0-n0"), // hoisted wrapper over a frame and a gif
		el("s0-n13", "s0-n12", { backgroundColor: WHITE }),
		el("s0-n14", "s0-n12", {}, { loop: true }),
		el("s0-n15", "s0-n12", { backgroundColor: WHITE }),
		el("s0-n16", "s0-n0"), // hoisted wrapper with direct text and two element children
		tb("s0-n17", "s0-n16", "c"),
		el("s0-n18", "s0-n16", { backgroundColor: WHITE }),
		el("s0-n19", "s0-n16", { backgroundColor: WHITE }),
	];
	const root = normalizeSlide(nodes, meta).root;
	const owner = ownerMap(nodes, root);

	it("maps an emitted node to itself, even when it has a text block", () => {
		expect([owner("s0-n1"), owner("s0-n2"), owner("s0-n5")]).toEqual([["s0-n1"], ["s0-n2"], ["s0-n5"]]);
	});

	it("maps a hoisted node to its own text block, else its topmost emitted descendants", () => {
		expect(owner("s0-n6")).toEqual(["s0-n7"]);
		expect(owner("s0-n3")).toEqual(["s0-n5"]);
		expect(owner("s0-n0")).toEqual(["s0-n1", "s0-n7", "s0-n13", "s0-n15", "s0-n17", "s0-n18", "s0-n19"]);
		expect(owner("s0-n12")).toEqual(["s0-n13", "s0-n15"]); // the gif is skipped
	});

	it("unions a hoisted wrapper's own text block with its element children, in document order", () => {
		expect(owner("s0-n16")).toEqual(["s0-n17", "s0-n18", "s0-n19"]);
	});

	it("never falls back to an ancestor: gifs, their insides, hidden subtrees and unknown ids are empty", () => {
		expect(["nope", "s0-n8", "s0-n9", "s0-n10", "s0-n11", "s0-n14"].map(owner)).toEqual([[], [], [], [], [], []]);
	});
});

describe("emittedIds", () => {
	it("collects nested ids and leaves gifs out", () => {
		const nodes = [
			section(),
			el("s0-n1", "s0-n0", { backgroundColor: WHITE }),
			tb("s0-n2", "s0-n1", "a"),
			el("s0-n3", "s0-n0", {}, { loop: true }),
		];
		expect([...emittedIds(normalizeSlide(nodes, meta).root)]).toEqual(["s0-n1", "s0-n2"]);
	});
});
