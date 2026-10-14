import { buildOps, figmaPaints } from "../../src/core/deck-import/ops.js";
import type {
	Box,
	NodeIR,
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
	color: "rgb(255, 0, 0)",
	letterSpacing: "-0.8px",
	lineHeight: "48px",
	textDecoration: "underline",
};
const text = (id: string, b: Box, runs: TextRun[] = [RUN]): NodeIR => ({
	kind: "text",
	id,
	box: b,
	runs,
	lineCount: 1,
	align: "CENTER",
	opacity: 0.5,
	flags: [],
});
const frame = (id: string, b: Box, children: NodeIR[] = []): NodeIR => ({
	kind: "frame",
	id,
	box: b,
	fills: [],
	strokes: null,
	radii: R0,
	effects: [],
	clip: false,
	opacity: 1,
	children,
	flags: [],
});
const slide = (root: NodeIR[]): SlideIR => ({
	index: 0,
	name: "Title",
	background: [],
	skipped: false,
	notes: "",
	root,
	entrance: null,
	flags: [],
});

describe("buildOps", () => {
	it("emits a frame and its text child as two ops, child parented to the frame op", () => {
		const ops = buildOps(
			slide([
				frame("s0-n1", box(100, 200, 500, 300), [
					text("s0-n2", box(120, 230, 200, 48)),
				]),
			]),
			new Map(),
		);
		expect(ops).toHaveLength(2);
		expect(ops[0]).toMatchObject({ op: "frame", id: "s0-n1", parent: null });
		expect(ops[1]).toMatchObject({
			op: "text",
			id: "s0-n2",
			parent: ops[0].id,
		});
	});

	it("carries parent-relative positions", () => {
		const ops = buildOps(
			slide([
				frame("a", box(100, 200, 500, 300), [
					frame("b", box(120, 230, 200, 48), [
						text("c", box(125, 232, 50, 20)),
					]),
				]),
			]),
			new Map(),
		);
		expect(ops[0].props).toMatchObject({ x: 100, y: 200, w: 500, h: 300 });
		expect(ops[1].props).toMatchObject({ x: 20, y: 30, w: 200, h: 48 });
		expect(ops[2].props).toMatchObject({ x: 4, y: 2, w: 52, h: 20 }); // centred text: 2px slack
	});

	it("ends every op name with ' #<id>'", () => {
		const nodes: NodeIR[] = [
			frame("f", box(0, 0, 10, 10)),
			text("t", box(0, 0, 10, 10)),
			{
				kind: "image",
				id: "i",
				box: box(0, 0, 10, 10),
				src: "a.png",
				scaleMode: "FILL",
				radii: R0,
				opacity: 1,
				flags: [],
			},
			{
				kind: "vector",
				id: "v",
				box: box(0, 0, 10, 10),
				svg: "<svg/>",
				opacity: 1,
				flags: [],
			},
			{
				kind: "slot",
				id: "sl",
				box: box(0, 0, 10, 10),
				name: "Image slot · hero",
				radii: R0,
				flags: [],
			},
			{ kind: "gif", id: "g", box: box(0, 0, 10, 10), gifKey: "g", flags: [] },
		];
		const ops = buildOps(
			slide(nodes),
			new Map([
				["a.png", "H1"],
				["g", "H2"],
			]),
		);
		expect(ops).toHaveLength(6);
		for (const op of ops) expect(op.name.endsWith(` #${op.id}`)).toBe(true);
		expect(ops.find((o) => o.id === "sl")?.name).toBe("Image slot · hero #sl");
	});

	it("takes the image hash from the map and skips images without one", () => {
		const img = (id: string, src: string): NodeIR => ({
			kind: "image",
			id,
			box: box(10, 20, 30, 40),
			src,
			scaleMode: "FIT",
			radii: [1, 2, 3, 4],
			opacity: 0.7,
			flags: [],
		});
		const ops = buildOps(
			slide([img("a", "a.png"), img("b", "missing.png")]),
			new Map([["a.png", "HASH"]]),
		);
		expect(ops).toHaveLength(1);
		expect(ops[0]).toMatchObject({ op: "image", id: "a" });
		expect(ops[0].props).toMatchObject({
			hash: "HASH",
			scaleMode: "FIT",
			radii: [1, 2, 3, 4],
			opacity: 0.7,
			x: 10,
			y: 20,
			w: 30,
			h: 40,
		});
	});

	it("turns a gif into an image op with scaleMode FILL", () => {
		const ops = buildOps(
			slide([
				{
					kind: "gif",
					id: "g1",
					box: box(5, 6, 70, 80),
					gifKey: "k",
					flags: [],
				},
			]),
			new Map([["k", "GIFHASH"]]),
		);
		expect(ops).toHaveLength(1);
		expect(ops[0]).toMatchObject({ op: "image", id: "g1", parent: null });
		expect(ops[0].props).toMatchObject({
			hash: "GIFHASH",
			scaleMode: "FILL",
			x: 5,
			y: 6,
			w: 70,
			h: 80,
		});
	});

	it("gives a gif the loop owner's corner radii", () => {
		const [op] = buildOps(
			slide([
				{
					kind: "gif",
					id: "g",
					box: box(0, 0, 70, 80),
					gifKey: "k",
					radii: [8, 4, 2, 0],
					flags: [],
				},
			]),
			new Map([["k", "H"]]),
		);
		expect(op.props.radii).toEqual([8, 4, 2, 0]);
	});

	it("emits a slot op with no fills", () => {
		const ops = buildOps(
			slide([
				{
					kind: "slot",
					id: "s",
					box: box(0, 0, 100, 100),
					name: "Image slot · logo",
					radii: [8, 8, 8, 8],
					flags: [],
				},
			]),
			new Map(),
		);
		expect(ops[0].op).toBe("slot");
		expect(ops[0].props.fills ?? []).toEqual([]);
		expect(ops[0].props.radii).toEqual([8, 8, 8, 8]);
	});

	it("skips vectors with an empty svg and keeps resolved ones", () => {
		const vec = (id: string, svg: string): NodeIR => ({
			kind: "vector",
			id,
			box: box(0, 0, 24, 24),
			svg,
			opacity: 1,
			flags: [],
		});
		const ops = buildOps(
			slide([vec("empty", ""), vec("ok", "<svg viewBox='0 0 1 1'/>")]),
			new Map(),
		);
		expect(ops.map((o) => o.id)).toEqual(["ok"]);
		expect(ops[0].props.svg).toBe("<svg viewBox='0 0 1 1'/>");
	});

	it("converts frame decoration to Figma shapes", () => {
		const f: NodeIR = {
			...(frame("f", box(0, 0, 200, 100)) as Extract<
				NodeIR,
				{ kind: "frame" }
			>),
			fills: [{ type: "SOLID", color: { r: 1, g: 0.5, b: 0, a: 0.25 } }],
			strokes: {
				color: { r: 0, g: 0, b: 1, a: 1 },
				weights: [1, 2, 3, 4],
				dashed: true,
			},
			radii: [1, 2, 3, 4],
			effects: [
				{
					type: "DROP_SHADOW",
					color: { r: 0, g: 0, b: 0, a: 0.5 },
					x: 1,
					y: 2,
					blur: 3,
					spread: 4,
				},
				{ type: "BACKGROUND_BLUR", radius: 12 },
			],
			clip: true,
			opacity: 0.9,
		};
		const [op] = buildOps(slide([f]), new Map());
		expect(op.props.fills).toEqual([
			{ type: "SOLID", color: { r: 1, g: 0.5, b: 0 }, opacity: 0.25 },
		]);
		expect(op.props.strokes).toEqual({
			paints: [{ type: "SOLID", color: { r: 0, g: 0, b: 1 }, opacity: 1 }],
			weights: [1, 2, 3, 4],
			dashed: true,
		});
		expect(op.props.radii).toEqual([1, 2, 3, 4]);
		expect(op.props.effects).toEqual([
			{
				type: "DROP_SHADOW",
				color: { r: 0, g: 0, b: 0, a: 0.5 },
				offset: { x: 1, y: 2 },
				radius: 3,
				spread: 4,
				visible: true,
				blendMode: "NORMAL",
			},
			{ type: "BACKGROUND_BLUR", radius: 12, visible: true },
		]);
		expect(op.props.clip).toBe(true);
		expect(op.props.opacity).toBe(0.9);
	});

	it("converts text runs into ranges with Figma font, spacing and line height", () => {
		const runs: TextRun[] = [
			RUN,
			{
				...RUN,
				chars: " world",
				fontFamily: "'Geist Mono'",
				fontWeight: 400,
				fontStyle: "italic",
				letterSpacing: "normal",
				lineHeight: "normal",
				textDecoration: "line-through",
				color: "rgb(0, 0, 255)",
			},
		];
		const [op] = buildOps(
			slide([text("t", box(10, 20, 300, 60), runs)]),
			new Map(),
		);
		expect(op.props).toMatchObject({
			x: 7.75, // centred text: 1.5% (4.5px) width slack, shifted by half
			y: 20,
			w: 304.5,
			h: 60,
			text: "Hello world",
			align: "CENTER",
			opacity: 0.5,
			lineHeightPx: 48,
		});
		const r = op.props.runs as Record<string, unknown>[];
		expect(r).toHaveLength(2);
		expect(r[0]).toMatchObject({
			start: 0,
			end: 5,
			family: "Geist",
			style: "SemiBold",
			fontSize: 40,
			fills: [{ type: "SOLID", color: { r: 1, g: 0, b: 0 }, opacity: 1 }],
			letterSpacing: { unit: "PERCENT", value: -2 },
			lineHeight: { unit: "PIXELS", value: 48 },
			decoration: "UNDERLINE",
		});
		expect(r[1]).toMatchObject({
			start: 5,
			end: 11,
			family: "Geist Mono",
			style: "Italic",
			letterSpacing: { unit: "PERCENT", value: 0 },
			lineHeight: { unit: "PIXELS", value: 48 }, // 'normal' ~ 1.2 x 40
			decoration: "STRIKETHROUGH",
		});
	});

	it("gives transparent text no fill and unparseable colours black", () => {
		const fillsOf = (color: string) => {
			const [op] = buildOps(
				slide([text("t", box(0, 0, 10, 10), [{ ...RUN, color }])]),
				new Map(),
			);
			return (op.props.runs as { fills: unknown[] }[])[0].fills;
		};
		expect(fillsOf("rgba(0, 0, 0, 0)")).toEqual([]);
		expect(fillsOf("transparent")).toEqual([]);
		expect(fillsOf("rgba(255, 0, 0, 0.5)")).toEqual([
			{ type: "SOLID", color: { r: 1, g: 0, b: 0 }, opacity: 0.5 },
		]);
		expect(fillsOf("not-a-colour")).toEqual([
			{ type: "SOLID", color: { r: 0, g: 0, b: 0 }, opacity: 1 },
		]);
	});

	it("gives text 1.5% (at least 2px) of width slack, shifted by alignment, so Figma never wraps the last word", () => {
		const geo = (align: "LEFT" | "CENTER" | "RIGHT" | "JUSTIFIED") => {
			const [op] = buildOps(
				slide([
					{ ...text("t", box(100, 20, 300, 60)), align } as NodeIR,
				]),
				new Map(),
			);
			return { x: op.props.x, w: op.props.w, y: op.props.y, h: op.props.h };
		};
		expect(geo("LEFT")).toEqual({ x: 100, w: 304.5, y: 20, h: 60 });
		expect(geo("CENTER")).toEqual({ x: 97.75, w: 304.5, y: 20, h: 60 });
		expect(geo("RIGHT")).toEqual({ x: 95.5, w: 304.5, y: 20, h: 60 });
		expect(geo("JUSTIFIED")).toEqual({ x: 100, w: 304.5, y: 20, h: 60 });
	});

	it("lays vertical text out along the column and turns it, anchored where reading starts", () => {
		const geo = (rotation: number) => {
			const [op] = buildOps(
				slide([
					{ ...text("t", box(1870, 100, 24, 62)), lineCount: 1, rotation } as NodeIR,
				]),
				new Map(),
			);
			const { x, y, w, h, rotation: r } = op.props;
			return { x, y, w, h, r };
		};
		// reads bottom to top: origin at the bottom-left of the box
		expect(geo(90)).toEqual({ x: 1870, y: 162, w: 64, h: 24, r: 90 });
		// reads top to bottom: origin at the top-right
		expect(geo(-90)).toEqual({ x: 1894, y: 100, w: 64, h: 24, r: -90 });
	});

	it("applies the slack relative to the parent and marks only single-line text as auto-width", () => {
		const multi = { ...text("m", box(130, 40, 100, 96)), lineCount: 2 } as NodeIR;
		const ops = buildOps(
			slide([
				frame("f", box(100, 0, 500, 300), [text("one", box(120, 10, 50, 48)), multi]),
			]),
			new Map(),
		);
		const one = ops.find((o) => o.id === "one");
		const two = ops.find((o) => o.id === "m");
		expect(one?.props).toMatchObject({ x: 19, w: 52, autoWidth: true });
		expect(two?.props).toMatchObject({ x: 29, w: 102 });
		expect(two?.props.autoWidth).toBeFalsy();
	});

	it("names text after its content", () => {
		const [op] = buildOps(slide([text("t", box(0, 0, 10, 10))]), new Map());
		expect(op.name).toBe("Hello #t");
	});
});

describe("figmaPaints", () => {
	const stops = [
		{ pos: 0, color: { r: 1, g: 0, b: 0, a: 1 } },
		{ pos: 1, color: { r: 0, g: 0, b: 1, a: 0.5 } },
	];
	const size = { w: 100, h: 100 };

	it("maps gradient stops", () => {
		const [p] = figmaPaints(
			[{ type: "GRADIENT_LINEAR", angleDeg: 90, stops }],
			size,
		) as Record<string, unknown>[];
		expect(p.type).toBe("GRADIENT_LINEAR");
		expect(p.gradientStops).toEqual([
			{ position: 0, color: { r: 1, g: 0, b: 0, a: 1 } },
			{ position: 1, color: { r: 0, g: 0, b: 1, a: 0.5 } },
		]);
	});

	it("builds the Figma transform for 'to bottom' and 'to right' on a square", () => {
		const t = (angleDeg: number) =>
			(
				figmaPaints(
					[{ type: "GRADIENT_LINEAR", angleDeg, stops }],
					size,
				)[0] as { gradientTransform: number[][] }
			).gradientTransform;
		const down = t(180);
		const right = t(90);
		[
			[0, 1, 0],
			[-1, 0, 1],
		].forEach((row, i) =>
			row.forEach((v, j) => expect(down[i][j]).toBeCloseTo(v)),
		);
		[
			[1, 0, 0],
			[0, 1, 0],
		].forEach((row, i) =>
			row.forEach((v, j) => expect(right[i][j]).toBeCloseTo(v)),
		);
	});

	it("maps the start/end of a 45deg gradient to the opposite corners", () => {
		const [p] = figmaPaints(
			[{ type: "GRADIENT_LINEAR", angleDeg: 45, stops }],
			size,
		) as { gradientTransform: number[][] }[];
		const [[a, b, c]] = p.gradientTransform;
		expect(a * 0 + b * 1 + c).toBeCloseTo(0); // bottom-left
		expect(a * 1 + b * 0 + c).toBeCloseTo(1); // top-right
	});

	it("scales radial gradients to the farthest corner about the centre", () => {
		const [p] = figmaPaints(
			[{ type: "GRADIENT_RADIAL", angleDeg: 0, stops }],
			size,
		) as { gradientTransform: number[][] }[];
		const s = Math.SQRT1_2;
		expect(p.gradientTransform[0][0]).toBeCloseTo(s);
		expect(p.gradientTransform[1][1]).toBeCloseTo(s);
		expect(p.gradientTransform[0][2]).toBeCloseTo(0.5 - 0.5 * s);
	});
});

describe("buildOps outline text", () => {
	it("gives stroked text a centred stroke at the run's width", () => {
		const t: NodeIR = {
			...(text("t", box(0, 0, 100, 48)) as Extract<NodeIR, { kind: "text" }>),
			stroke: { color: { r: 0, g: 0, b: 1, a: 1 }, weight: 2 },
		};
		const [op] = buildOps(slide([t]), new Map());
		expect(op.props.strokes).toEqual({
			paints: [{ type: "SOLID", color: { r: 0, g: 0, b: 1 }, opacity: 1 }],
			weights: [2, 2, 2, 2],
			dashed: false,
			align: "CENTER",
		});
		const [plain] = buildOps(slide([text("t", box(0, 0, 100, 48))]), new Map());
		expect(plain.props).not.toHaveProperty("strokes");
	});
});
