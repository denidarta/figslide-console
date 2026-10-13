import { checkSlide } from "../../src/core/deck-import/qa.js";
import type {
	Box,
	FigmaDumpNode,
	NodeIR,
	QaIssue,
	SlideIR,
	TextRun,
} from "../../src/core/deck-import/types.js";

const R0: [number, number, number, number] = [0, 0, 0, 0];
const box = (x: number, y: number, w: number, h: number): Box => ({
	x,
	y,
	w,
	h,
});
const RUN: TextRun = {
	chars: "Hello",
	fontFamily: '"Geist", sans-serif',
	fontWeight: 600,
	fontStyle: "normal",
	fontSize: 40,
	color: "rgb(0, 0, 0)",
	letterSpacing: "normal",
	lineHeight: "48px",
	textDecoration: "none",
};

const frame = (
	id: string,
	b: Box,
	children: NodeIR[] = [],
	over: { opacity?: number; flags?: string[] } = {},
): NodeIR => ({
	kind: "frame",
	id,
	box: b,
	fills: [],
	strokes: null,
	radii: R0,
	effects: [],
	clip: false,
	opacity: over.opacity ?? 1,
	children,
	flags: over.flags ?? [],
});
const text = (
	id: string,
	b: Box,
	lineCount = 1,
	runs: TextRun[] = [RUN],
): NodeIR => ({
	kind: "text",
	id,
	box: b,
	runs,
	lineCount,
	align: "LEFT",
	opacity: 1,
	flags: [],
});
const image = (id: string, b: Box): NodeIR => ({
	kind: "image",
	id,
	box: b,
	src: "a.png",
	scaleMode: "FILL",
	radii: R0,
	opacity: 1,
	flags: [],
});
const vector = (id: string, b: Box, svg = "<svg/>"): NodeIR => ({
	kind: "vector",
	id,
	box: b,
	svg,
	opacity: 1,
	flags: [],
});
const slot = (id: string, b: Box): NodeIR => ({
	kind: "slot",
	id,
	box: b,
	name: "Image slot · x",
	radii: R0,
	flags: [],
});
const slide = (root: NodeIR[]): SlideIR => ({
	index: 0,
	name: "S1",
	background: [],
	skipped: false,
	notes: "",
	root,
	entrance: null,
	flags: [],
});

const SOLID = { type: "SOLID", hasImage: false };
const IMG = { type: "IMAGE", hasImage: true };
const dn = (
	importId: string | null,
	type: string,
	b: Box,
	over: Partial<FigmaDumpNode> = {},
): FigmaDumpNode => ({
	id: `f:${importId ?? "x"}`,
	importId,
	type,
	name: `${type} #${importId}`,
	box: b,
	visible: true,
	fills: [SOLID],
	strokes: 0,
	effects: 0,
	clips: false,
	children: [],
	...over,
});
const dtext = (
	id: string,
	b: Box,
	lineCount = 1,
	fonts = ["Geist SemiBold"],
): FigmaDumpNode =>
	dn(id, "TEXT", b, { text: { chars: "Hello", lineCount, fonts } });
const root = (...children: FigmaDumpNode[]): FigmaDumpNode =>
	dn(null, "SLIDE", box(0, 0, 1920, 1080), { fills: [], children });

const kinds = (issues: QaIssue[]) => issues.map((i) => i.kind);
const ids = (issues: QaIssue[]) => issues.map((i) => i.importId);
const B10 = box(0, 0, 10, 10);

describe("checkSlide", () => {
	it("passes a faithful dump", () => {
		const ir = slide([
			frame("a", box(10, 10, 200, 100), [text("t", box(20, 20, 100, 48))]),
		]);
		const dump = root(
			dn("a", "FRAME", box(10, 10, 200, 100), {
				children: [dtext("t", box(20, 20, 100, 48))],
			}),
		);
		expect(checkSlide(ir, dump)).toEqual({ pass: true, issues: [] });
	});

	it("flags an empty frame and rectangle but not an Image slot", () => {
		const ir = slide([frame("a", B10), image("b", B10), slot("c", B10)]);
		const dump = root(
			dn("a", "FRAME", B10, { fills: [] }),
			dn("b", "RECTANGLE", B10, { fills: [] }),
			dn("c", "FRAME", B10, { fills: [], name: "Image slot · x #c" }),
		);
		const issues = checkSlide(ir, dump).issues;
		expect(kinds(issues)).toEqual(["empty", "empty"]);
		expect(ids(issues)).toEqual(["a", "b"]);
	});

	it("a frame with a stroke, an effect or children is not empty", () => {
		const ir = slide([
			frame("a", B10),
			frame("b", B10),
			frame("c", B10, [
				frame("d", box(0, 0, 5, 5)),
				frame("e", box(5, 5, 5, 5)),
			]),
		]);
		const dump = root(
			dn("a", "FRAME", B10, { fills: [], strokes: 1 }),
			dn("b", "FRAME", B10, { fills: [], effects: 1 }),
			dn("c", "FRAME", B10, {
				fills: [],
				children: [
					dn("d", "FRAME", box(0, 0, 5, 5), { effects: 1, fills: [] }),
					dn("e", "FRAME", box(5, 5, 5, 5), { effects: 1, fills: [] }),
				],
			}),
		);
		expect(checkSlide(ir, dump).issues).toEqual([]);
	});

	it("flags a pass-through frame but not one with fill, stroke, effect or clip", () => {
		const b = box(0, 0, 50, 50);
		const ir = slide(
			["a", "b", "c", "d", "e"].map((id) => frame(id, b, [image(`${id}1`, b)])),
		);
		const f = (id: string, over: Partial<FigmaDumpNode>) =>
			dn(id, "FRAME", b, {
				fills: [],
				children: [dn(`${id}1`, "RECTANGLE", b, { fills: [IMG] })],
				...over,
			});
		const dump = root(
			f("a", {}),
			f("b", { fills: [SOLID] }),
			f("c", { strokes: 1 }),
			f("d", { effects: 1 }),
			f("e", { clips: true }),
		);
		const issues = checkSlide(ir, dump).issues;
		expect(kinds(issues)).toEqual(["passthrough"]);
		expect(issues[0].importId).toBe("a");
		expect(issues[0].figmaId).toBe("f:a");
	});

	it("does not lint frames kept for opacity < 1 or flags as empty or pass-through", () => {
		const b = box(0, 0, 50, 50);
		const keep = (id: string, over: { opacity?: number; flags?: string[] }) => [
			frame(`${id}-empty`, b, [], over),
			frame(`${id}-wrap`, b, [image(`${id}-img`, b)], over),
		];
		const ir = slide([
			...keep("o", { opacity: 0.5 }),
			...keep("f", { flags: ["unsupported:filter"] }),
			frame("plain-empty", b),
			frame("plain-wrap", b, [image("plain-img", b)]),
		]);
		const wrap = (id: string) =>
			dn(`${id}-wrap`, "FRAME", b, {
				fills: [],
				children: [dn(`${id}-img`, "RECTANGLE", b, { fills: [IMG] })],
			});
		const dump = root(
			dn("o-empty", "FRAME", b, { fills: [] }),
			wrap("o"),
			dn("f-empty", "FRAME", b, { fills: [] }),
			wrap("f"),
			dn("plain-empty", "FRAME", b, { fills: [] }),
			wrap("plain"),
		);
		const issues = checkSlide(ir, dump).issues;
		expect(ids(issues)).toEqual(["plain-empty", "plain-wrap"]);
		expect(kinds(issues)).toEqual(["empty", "passthrough"]);
	});

	it("does not treat a createNodeFromSvg vector frame as empty or pass-through", () => {
		const ir = slide([vector("v", box(0, 0, 24, 24))]);
		const dump = root(
			dn("v", "FRAME", box(0, 0, 24, 24), {
				fills: [],
				children: [
					dn(null, "FRAME", box(0, 0, 24, 24), {
						fills: [],
						children: [dn(null, "VECTOR", box(2, 2, 20, 20))],
					}),
				],
			}),
		);
		expect(checkSlide(ir, dump).issues).toEqual([]);
	});

	it("flags an image fill on a node that is not an image or gif", () => {
		const ir = slide([
			frame("a", B10),
			image("b", B10),
			{ kind: "gif", id: "g", box: B10, gifKey: "k", flags: [] },
		]);
		const dump = root(
			dn("a", "RECTANGLE", B10, { fills: [IMG] }),
			dn("b", "RECTANGLE", B10, { fills: [IMG] }),
			dn("g", "RECTANGLE", B10, { fills: [IMG] }),
		);
		const issues = checkSlide(ir, dump).issues;
		expect(kinds(issues)).toEqual(["raster"]);
		expect(ids(issues)).toEqual(["a"]);
	});

	it("flags text that arrived as a non-TEXT node", () => {
		const ir = slide([text("t", box(0, 0, 100, 48))]);
		const dump = root(dn("t", "RECTANGLE", box(0, 0, 100, 48)));
		expect(kinds(checkSlide(ir, dump).issues)).toEqual(["text-not-text"]);
	});

	it("box: 1px and 2px offsets pass, 3px fails; position and size are both checked", () => {
		const ir = slide([image("t", box(100, 100, 200, 48))]);
		const at = (b: Box) =>
			checkSlide(ir, root(dn("t", "RECTANGLE", b, { fills: [IMG] })));
		expect(at(box(101, 100, 200, 48)).pass).toBe(true);
		expect(at(box(102, 102, 200, 48)).pass).toBe(true);
		expect(at(box(100, 100, 201, 49)).pass).toBe(true);
		const moved = at(box(103, 100, 200, 48));
		expect(kinds(moved.issues)).toEqual(["box"]);
		expect(moved.pass).toBe(false);
		expect(kinds(at(box(100, 100, 203, 48)).issues)).toEqual(["box"]);
		expect(kinds(at(box(100, 100, 200, 52)).issues)).toEqual(["box"]);
	});

	it("box: turned text takes the slack on its top and bottom edges instead", () => {
		const ir = slide([
			{ ...text("t", box(100, 100, 24, 200)), rotation: 90 } as NodeIR,
		]);
		const at = (b: Box) => checkSlide(ir, root(dtext("t", b)));
		expect(at(box(100, 95, 24, 205)).pass).toBe(true); // top edge 5 away: 3 slack + 2
		expect(kinds(at(box(105, 100, 24, 200)).issues)).toEqual(["box"]); // left edge has none
	});

	it("box: text edges may be off by the width slack (1.5%, here 3px) on top of the tolerance, horizontally only", () => {
		const ir = slide([text("t", box(100, 100, 200, 48))]);
		const at = (b: Box) => checkSlide(ir, root(dtext("t", b)));
		// ops widen the box by 3 and shift x by the alignment; Figma may then measure a little off
		expect(at(box(98, 100, 204, 48)).pass).toBe(true); // both edges 2 + 2 away
		expect(at(box(95, 100, 205, 48)).pass).toBe(true); // left edge 5 away
		expect(kinds(at(box(94, 100, 206, 48)).issues)).toEqual(["box"]); // 6 away
		expect(kinds(at(box(100, 100, 206, 48)).issues)).toEqual(["box"]); // right edge 6 away
		// vertical edges keep the plain tolerance
		expect(at(box(100, 102, 200, 48)).pass).toBe(true);
		expect(kinds(at(box(100, 103, 200, 48)).issues)).toEqual(["box"]);
		expect(kinds(at(box(100, 100, 200, 51)).issues)).toEqual(["box"]);
	});

	it("box: text uses line-box geometry (lines x line-height), not the content area", () => {
		// 72px font, line-height 1.1 = 79.2px, two lines: the block is 158.4px tall at the line top.
		const ir = slide([text("t", box(120, 200, 900, 158.4), 2)]);
		const at = (b: Box) => checkSlide(ir, root(dtext("t", b, 2)));
		expect(at(box(120, 200.4, 900, 158.4)).pass).toBe(true);
		// the content-area rect union (taller, shifted by the half-leading) is what used to be reported
		expect(kinds(at(box(120, 196.4, 900, 165.6)).issues)).toEqual(["box"]);
	});

	it("box: a vector fitted into its box (centred, one axis filled) passes", () => {
		const ir = slide([vector("v", box(100, 100, 200, 100))]);
		const v = (b: Box) =>
			checkSlide(
				ir,
				root(
					dn("v", "FRAME", b, { fills: [], children: [dn(null, "VECTOR", b)] }),
				),
			);
		expect(v(box(150, 100, 100, 100)).pass).toBe(true); // square svg in a wide box
		expect(v(box(100, 100, 200, 100)).pass).toBe(true);
		expect(kinds(v(box(125, 112, 100, 50)).issues)).toEqual(["box"]); // too small
		expect(kinds(v(box(250, 100, 100, 100)).issues)).toEqual(["box"]); // off centre
	});

	it("lines: line count must match exactly", () => {
		const ir = slide([text("t", box(0, 0, 100, 96), 2)]);
		expect(checkSlide(ir, root(dtext("t", box(0, 0, 100, 96), 2))).pass).toBe(
			true,
		);
		const r = checkSlide(ir, root(dtext("t", box(0, 0, 100, 96), 3)));
		expect(kinds(r.issues)).toEqual(["lines"]);
		expect(r.issues[0].detail).toContain("2");
		expect(r.issues[0].detail).toContain("3");
	});

	it("missing: an IR id absent from the dump", () => {
		const ir = slide([frame("a", B10), text("t", B10)]);
		const r = checkSlide(ir, root(dtext("t", B10)));
		expect(r.pass).toBe(false);
		expect(r.issues).toEqual([
			{
				kind: "missing",
				importId: "a",
				figmaId: "",
				detail: expect.any(String),
			},
		]);
	});

	it("missing: honours expectedIds and by default skips empty-svg vectors", () => {
		const ir = slide([frame("a", B10), vector("v", B10, ""), text("t", B10)]);
		expect(ids(checkSlide(ir, root(dtext("t", B10))).issues)).toEqual(["a"]);
		expect(ids(checkSlide(ir, root(), new Set(["t"])).issues)).toEqual(["t"]);
		expect(checkSlide(ir, root(), new Set()).pass).toBe(true);
	});

	it("walks nested IR and nested dump nodes", () => {
		const ir = slide([
			frame("a", box(0, 0, 100, 100), [text("t", box(5, 5, 50, 20))]),
		]);
		const dump = root(
			dn("a", "FRAME", box(0, 0, 100, 100), {
				children: [dtext("t", box(5, 5, 50, 20))],
			}),
		);
		expect(checkSlide(ir, dump).pass).toBe(true);
	});

	it("font: flags a run whose family is not among the node's fonts", () => {
		const ir = slide([text("t", box(0, 0, 100, 48))]);
		const fallback = checkSlide(
			ir,
			root(dtext("t", box(0, 0, 100, 48), 1, ["Inter Regular"])),
		);
		expect(kinds(fallback.issues)).toEqual(["font"]);
		expect(fallback.issues[0].detail).toContain("Geist");
		// case-insensitive, any style, any run
		const ok = root(
			dtext("t", box(0, 0, 100, 48), 1, ["geist Bold", "Inter Regular"]),
		);
		expect(checkSlide(ir, ok).pass).toBe(true);
	});

	it("font: checks only runs that have characters", () => {
		const ir = slide([
			text("t", box(0, 0, 100, 48), 1, [
				RUN,
				{ ...RUN, chars: "", fontFamily: "Nope" },
			]),
		]);
		expect(checkSlide(ir, root(dtext("t", box(0, 0, 100, 48)))).pass).toBe(
			true,
		);
	});
});
