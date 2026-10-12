import { buildEntrance } from "../../src/core/deck-import/entrance.js";
import { emittedIds, normalizeSlide, ownerMap } from "../../src/core/deck-import/normalize.js";
import type { RawAnim, RawNode } from "../../src/core/deck-import/types.js";

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
const WHITE = "rgb(255, 255, 255)";
const BOX = { x: 100, y: 200, w: 300, h: 400 };
const node = (
	id: string,
	parentId: string | null,
	style: Record<string, string> = {},
	extra: Partial<RawNode> = {},
): RawNode => ({ id, parentId, tag: "div", box: BOX, style: { ...PLAIN, ...style }, ...extra });
const text = (id: string, parentId: string): RawNode => ({
	id,
	parentId,
	tag: "#text-block",
	box: BOX,
	style: { textAlign: "start" },
	text: {
		runs: [
			{
				chars: "Hello",
				fontFamily: "Inter",
				fontWeight: 400,
				fontStyle: "normal",
				fontSize: 24,
				color: "rgb(0, 0, 0)",
				letterSpacing: "normal",
				lineHeight: "normal",
				textDecoration: "none",
			},
		],
		lineCount: 1,
	},
});
const anim = (nodeId: string, firstKeyframe: Record<string, string>, extra: Partial<RawAnim> = {}): RawAnim => ({
	nodeId,
	name: "a",
	iterations: 1,
	delayMs: 0,
	durationMs: 600,
	easing: "cubic-bezier(.65, 0, .35, 1)",
	firstKeyframe,
	...extra,
});

// A slide as the walker would capture it:
//   n1 .npCard   (white frame)         n2 text in it
//   n3 .npIn     (white frame)
//   n4 .stairUp  (white frame)
//   n5 .reveal   (non-drawing wrapper, hoisted away) > n6 frame > n12 text
//   n13 .group   (non-drawing wrapper inside n1) > n15 plain div > n14 text
//   n16 .pair    (non-drawing wrapper) > n17, n18 (white frames)
//   n19 .spinner (non-drawing wrapper) > n20 (looping -> gif)
//   n21 .mixed   (non-drawing wrapper, direct text n22) > n23, n24 (white frames)
//   n7 .loader   (looping -> gif)      n8 child of the gif
//   n9 h1.rise   (non-drawing, direct text) n10 its text block
//   n11 .ghost   (hidden)
const nodes: RawNode[] = [
	node("s0-n0", null),
	node("s0-n1", "s0-n0", { backgroundColor: WHITE }),
	text("s0-n2", "s0-n1"),
	node("s0-n3", "s0-n0", { backgroundColor: WHITE }),
	node("s0-n4", "s0-n0", { backgroundColor: WHITE }),
	node("s0-n5", "s0-n0"),
	node("s0-n6", "s0-n5", { backgroundColor: WHITE }),
	text("s0-n12", "s0-n6"),
	node("s0-n13", "s0-n1"),
	node("s0-n15", "s0-n13"),
	text("s0-n14", "s0-n15"),
	node("s0-n7", "s0-n0", {}, { loop: true }),
	node("s0-n8", "s0-n7", { backgroundColor: WHITE }),
	node("s0-n9", "s0-n0"),
	text("s0-n10", "s0-n9"),
	node("s0-n11", "s0-n0", { backgroundColor: WHITE }, { hidden: true }),
	node("s0-n16", "s0-n0"),
	node("s0-n17", "s0-n16", { backgroundColor: WHITE }),
	node("s0-n18", "s0-n16", { backgroundColor: WHITE }),
	node("s0-n19", "s0-n0"),
	node("s0-n20", "s0-n19", {}, { loop: true }),
	node("s0-n21", "s0-n0"),
	text("s0-n22", "s0-n21"),
	node("s0-n23", "s0-n21", { backgroundColor: WHITE }),
	node("s0-n24", "s0-n21", { backgroundColor: WHITE }),
];
const { root } = normalizeSlide(nodes, { index: 0, name: "Slide", skipped: false, notes: "" });
const build = (...anims: RawAnim[]) => buildEntrance(anims, emittedIds(root), ownerMap(nodes, root));

describe("buildEntrance", () => {
	it("npCard: fade + translateY(24px) over 600ms", () => {
		expect(build(anim("s0-n1", { opacity: "0", transform: "translateY(24px)" }))).toEqual({
			durationS: 0.6,
			curve: "EASE_IN_AND_OUT",
			start: { "s0-n1": { opacity: 0, dy: 24 } },
		});
	});

	it("npIn: ignores the percent part of translate(-50%, 16px)", () => {
		const e = build(anim("s0-n3", { opacity: "0", transform: "translate(-50%, 16px)" }));
		expect(e?.start["s0-n3"]).toEqual({ opacity: 0, dy: 16 });
		expect(e?.start["s0-n3"]).not.toHaveProperty("dx");
	});

	it("stairUp: height from 0 becomes fade + 24px rise", () => {
		expect(build(anim("s0-n4", { height: "0px" }))?.start).toEqual({
			"s0-n4": { opacity: 0, dy: 24 },
		});
	});

	it("clamps durationS to 1 second", () => {
		expect(build(anim("s0-n1", { opacity: "0" }, { durationMs: 1400 }))?.durationS).toBe(1);
	});

	it("returns null for infinite, zero-iteration and unowned animations", () => {
		const infinite = anim("s0-n1", { opacity: "0" }, { iterations: Number.POSITIVE_INFINITY });
		expect(build(infinite)).toBeNull();
		expect(build(anim("s0-n1", { opacity: "0" }, { iterations: 0 }))).toBeNull();
		expect(build(anim("missing", { opacity: "0" }))).toBeNull();
		expect(build()).toBeNull();
	});

	it("keeps finite repeated animations", () => {
		expect(build(anim("s0-n1", { opacity: "0" }, { iterations: 3 }))).not.toBeNull();
	});

	it("handles every transform form without throwing", () => {
		const start = (transform: string) => build(anim("s0-n1", { transform }))?.start["s0-n1"] ?? null;
		expect(start("translateX(-12px)")).toEqual({ dx: -12 });
		expect(start("translateY(24px)")).toEqual({ dy: 24 });
		expect(start("translate(8px, -16px)")).toEqual({ dx: 8, dy: -16 });
		expect(start("translate3d(8px, 0px, 0px)")).toEqual({ dx: 8 });
		expect(start("scale(0.75)")).toEqual({ scale: 0.75 });
		expect(start("translateY(16px) scale(0.9)")).toEqual({ dy: 16, scale: 0.9 });
		expect(start("scaleX(0)")).toEqual({ opacity: 0 });
		expect(start("scaleY(0)")).toEqual({ opacity: 0 });
		expect(start("scaleX(0.5)")).toBeNull();
		expect(start("matrix(0.5, 0, 0, 0.5, 10, 20)")).toEqual({ dx: 10, dy: 20, scale: 0.5 });
		expect(start("matrix(0, 0, 0, 1, 0, 0)")).toEqual({ opacity: 0 });
		expect(start("matrix(1, 0, 0, 1, 0, 0)")).toBeNull();
		expect(start("none")).toBeNull();
		expect(start("translate(-50%, -50%)")).toBeNull();
		expect(start("rotate(10deg) garbage(")).toBeNull();
		expect(start("scale(abc)")).toBeNull();
		expect(start("scale(0)")).toEqual({ scale: 0.01 });
		expect(start("scale(-1)")).toEqual({ scale: 0.01 });
		expect(start("translateX(2em)")).toBeNull();
	});

	it("maps stroke-dashoffset to opacity 0, in camelCase or kebab-case", () => {
		expect(build(anim("s0-n1", { strokeDashoffset: "100" }))?.start).toEqual({ "s0-n1": { opacity: 0 } });
		expect(build(anim("s0-n1", { "stroke-dashoffset": "100" }))?.start).toEqual({ "s0-n1": { opacity: 0 } });
	});

	it("treats max-height and padding starts like height", () => {
		for (const k of ["maxHeight", "max-height", "padding", "paddingTop"]) {
			expect(build(anim("s0-n1", { [k]: "0px" }))?.start).toEqual({ "s0-n1": { opacity: 0, dy: 24 } });
		}
	});

	it("ignores animations of properties it cannot start from", () => {
		expect(build(anim("s0-n1", { backgroundColor: "red", opacity: "abc" }))).toBeNull();
	});

	it("merges animations on one owner and keeps the longest one's timing", () => {
		const e = build(
			anim("s0-n1", { opacity: "0" }, { durationMs: 300, easing: "linear" }),
			anim("s0-n1", { transform: "translateY(8px)" }, { durationMs: 500, easing: "ease-out" }),
			anim("s0-n1", { backgroundColor: "red" }, { durationMs: 900, easing: "ease-in" }),
		);
		expect(e).toEqual({ durationS: 0.5, curve: "EASE_OUT", start: { "s0-n1": { opacity: 0, dy: 8 } } });
	});

	it("floors durationS at 0.01", () => {
		expect(build(anim("s0-n1", { opacity: "0" }, { durationMs: 0 }))?.durationS).toBe(0.01);
	});

	it("only starts nodes that were emitted", () => {
		expect(buildEntrance([anim("a", { opacity: "0" })], new Set(["b"]), () => ["a"])).toBeNull();
		expect(buildEntrance([anim("a", { opacity: "0" })], new Set(["a"]), () => [])).toBeNull();
	});

	describe("with ownerMap on a captured slide", () => {
		it("starts a hoisted wrapper's emitted children, never its ancestor or siblings", () => {
			const start = (id: string) => build(anim(id, { opacity: "0" }))?.start;
			expect(start("s0-n16")).toEqual({ "s0-n17": { opacity: 0 }, "s0-n18": { opacity: 0 } });
			expect(start("s0-n5")).toEqual({ "s0-n6": { opacity: 0 } });
			expect(start("s0-n21")).toEqual({
				"s0-n22": { opacity: 0 },
				"s0-n23": { opacity: 0 },
				"s0-n24": { opacity: 0 },
			}); // direct text and element children all start
			expect(start("s0-n13")).toEqual({ "s0-n14": { opacity: 0 } }); // not n1, which holds n2 too
		});

		it("animates the text block of a non-drawing element with direct text", () => {
			expect(build(anim("s0-n9", { opacity: "0", transform: "translateY(24px)" }))?.start).toEqual({
				"s0-n10": { opacity: 0, dy: 24 },
			});
		});

		it("ignores animations inside a gif and on hidden nodes", () => {
			expect(build(anim("s0-n8", { opacity: "0" }))).toBeNull();
			expect(build(anim("s0-n7", { opacity: "0" }))).toBeNull();
			expect(build(anim("s0-n11", { opacity: "0" }))).toBeNull();
			expect(build(anim("s0-n19", { opacity: "0" }))).toBeNull(); // wrapper whose only content is a gif
		});

		it("builds one step for a whole slide", () => {
			expect(
				build(
					anim("s0-n1", { opacity: "0", transform: "translateY(24px)" }),
					anim("s0-n3", { opacity: "0", transform: "translate(-50%, 16px)" }, { durationMs: 800 }),
					anim("s0-n4", { height: "0px" }, { iterations: Number.POSITIVE_INFINITY }),
				),
			).toEqual({
				durationS: 0.8,
				curve: "EASE_IN_AND_OUT",
				start: { "s0-n1": { opacity: 0, dy: 24 }, "s0-n3": { opacity: 0, dy: 16 } },
			});
		});
	});
});
