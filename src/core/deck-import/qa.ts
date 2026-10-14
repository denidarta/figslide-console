import { firstFamily, textSlack } from "./ops.js";
import type {
	Box,
	FigmaDumpNode,
	NodeIR,
	QaIssue,
	QaResult,
	RGBA,
	SlideIR,
} from "./types.js";

const TOL = 2; // px per box edge
const NUM_TOL = 0.5; // px for stroke weights, radii and effect geometry
const COLOR_TOL = 0.02; // per 0..1 channel, alpha included
const SLOT = "Image slot · ";

/** importId -> dump node, over the whole tree; unmarked nodes (a vector's internals) are not IR nodes. */
function index(
	n: FigmaDumpNode,
	out = new Map<string, FigmaDumpNode>(),
): Map<string, FigmaDumpNode> {
	if (n.importId && !out.has(n.importId)) out.set(n.importId, n);
	for (const c of n.children) index(c, out);
	return out;
}

const edges = (b: Box) => [b.x, b.y, b.x + b.w, b.y + b.h];
const fmt = (b: Box) =>
	`${[b.x, b.y, b.w, b.h].map((v) => Math.round(v * 10) / 10).join(",")}`;

/**
 * Largest edge difference, less `slack` on the edges along the text run (text boxes are widened on
 * purpose, see ops textSlack: left/right, or top/bottom for turned text); a vector is fitted into its box,
 * so it only has to be centred with one axis filled.
 */
function boxOff(
	ir: Box,
	d: Box,
	fitted: boolean,
	slack: number,
	alongY = false,
): number {
	if (!fitted) {
		const [a, b] = [edges(ir), edges(d)];
		return Math.max(
			...a.map(
				(v, i) => Math.abs(v - b[i]) - (i % 2 === (alongY ? 1 : 0) ? slack : 0),
			),
		);
	}
	const centre = Math.max(
		Math.abs(d.x + d.w / 2 - (ir.x + ir.w / 2)),
		Math.abs(d.y + d.h / 2 - (ir.y + ir.h / 2)),
	);
	const over = Math.max(d.w - ir.w, d.h - ir.h);
	const gap = Math.min(Math.abs(d.w - ir.w), Math.abs(d.h - ir.h));
	return Math.max(centre, over, gap);
}

type Add = (kind: QaIssue["kind"], detail: string) => void;
const r1 = (v: number) => Math.round(v * 10) / 10;
const rgba = (c: RGBA) =>
	`rgba(${[c.r, c.g, c.b].map((v) => Math.round(v * 255)).join(",")},${Math.round(c.a * 100) / 100})`;
const far = (a: number[], b: number[], tol: number) =>
	a.length !== b.length || a.some((v, i) => Math.abs(v - b[i]) > tol);

/**
 * Fills, strokes and effects of a frame against what Figma holds. Only a dump with paint numbers
 * (effectList, from the current runtime) is checked; counts alone cannot tell a fill from a placeholder.
 */
function paintIssues(n: Extract<NodeIR, { kind: "frame" }>, d: FigmaDumpNode, add: Add) {
	const list = d.effectList;
	if (!list) return;
	if (d.fills.length !== n.fills.length)
		add("fill", `expected ${n.fills.length} fills got ${d.fills.length}`);
	else
		n.fills.forEach((f, i) => {
			const got = d.fills[i];
			if (got.type !== f.type)
				add("fill", `fill ${i}: expected ${f.type} got ${got.type}`);
			else if (f.type === "SOLID" && got.color) {
				const [a, b] = [f.color, got.color];
				if (far([a.r, a.g, a.b, a.a], [b.r, b.g, b.b, b.a], COLOR_TOL))
					add("fill", `fill ${i}: expected ${rgba(a)} got ${rgba(b)}`);
			}
		});

	if (!n.strokes !== !d.strokes)
		add("stroke", n.strokes ? "stroke missing" : "unexpected stroke");
	else if (n.strokes && d.strokeWeights && far(n.strokes.weights, d.strokeWeights, NUM_TOL))
		add(
			"stroke",
			`expected weights ${n.strokes.weights.join(",")} got ${d.strokeWeights.map(r1).join(",")}`,
		);

	if (list.length !== n.effects.length) {
		add("effect", `expected ${n.effects.length} effects got ${list.length}`);
		return;
	}
	n.effects.forEach((e, i) => {
		const got = list[i];
		const want =
			"radius" in e ? [e.radius] : [e.x, e.y, e.blur, e.spread];
		const have =
			"radius" in e ? [got.radius] : [got.x, got.y, got.radius, got.spread];
		if (got.type !== e.type)
			add("effect", `effect ${i}: expected ${e.type} got ${got.type}`);
		else if (far(want, have, NUM_TOL))
			add(
				"effect",
				`effect ${i} (${e.type}): expected ${want.join(",")} got ${have.map(r1).join(",")}`,
			);
	});
}

/**
 * Checks the dumped Figma slide against the IR (§7.1 lint, §7.2 numbers). `expectedIds`: the op ids
 * buildOps emitted; only those can be `missing`. Default: every IR id except vectors with no svg yet.
 */
export function checkSlide(
	ir: SlideIR,
	dump: FigmaDumpNode,
	expectedIds?: Set<string>,
): QaResult {
	const byId = index(dump);
	const issues: QaIssue[] = [];

	const check = (n: NodeIR) => {
		const d = byId.get(n.id);
		if (!d) {
			const expected = expectedIds
				? expectedIds.has(n.id)
				: !(n.kind === "vector" && !n.svg);
			if (expected)
				issues.push({
					kind: "missing",
					importId: n.id,
					figmaId: "",
					detail: `${n.kind} node not found in Figma`,
				});
			return;
		}
		const add = (kind: QaIssue["kind"], detail: string) =>
			issues.push({ kind, importId: n.id, figmaId: d.id, detail });

		if (n.kind === "text" && d.type !== "TEXT")
			add("text-not-text", `text became ${d.type}`);
		const bare = !d.fills.length && !d.strokes && !d.effects;
		// normalize keeps a paint-less frame for opacity < 1 or an unsupported-CSS flag, neither of which
		// the dump can show; linting it as empty / pass-through would be an unfixable false positive.
		const kept = n.kind === "frame" && (n.opacity < 1 || n.flags.length > 0);
		if (
			!kept &&
			(d.type === "FRAME" || d.type === "RECTANGLE") &&
			bare &&
			!d.children.length &&
			!d.name.startsWith(SLOT)
		)
			add("empty", `${d.type} has no fill, stroke, effect or children`);
		if (
			!kept &&
			n.kind === "frame" &&
			d.type === "FRAME" &&
			bare &&
			!d.clips &&
			d.children.length === 1
		)
			add("passthrough", "frame wraps a single child and paints nothing");
		if (
			n.kind !== "image" &&
			n.kind !== "gif" &&
			d.fills.some((f) => f.hasImage)
		)
			add("raster", `${n.kind} node has an image fill`);
		if (n.kind === "frame") paintIssues(n, d, add);
		if ("radii" in n && d.radii && far(n.radii, d.radii, NUM_TOL))
			add(
				"radius",
				`expected ${n.radii.map(r1).join(",")} got ${d.radii.map(r1).join(",")}`,
			);

		const turned = n.kind === "text" && !!n.rotation;
		const slack =
			n.kind === "text" ? textSlack(turned ? n.box.h : n.box.w) : 0;
		if (boxOff(n.box, d.box, n.kind === "vector", slack, turned) > TOL)
			add("box", `expected ${fmt(n.box)} got ${fmt(d.box)} (x,y,w,h)`);

		if (n.kind === "text" && d.text) {
			// Mixed line heights: the dump's count (height / tallest line) is meaningless; the box check covers the height.
			if (!n.lineHeights && d.text.lineCount !== n.lineCount)
				add("lines", `expected ${n.lineCount} lines got ${d.text.lineCount}`);
			const have = d.text.fonts.map((f) => f.toLowerCase());
			const missing = new Set<string>();
			for (const r of n.runs) {
				if (!r.chars.length) continue;
				const fam = firstFamily(r.fontFamily);
				const low = fam.toLowerCase();
				// ponytail: "Geist" also matches "Geist Mono Regular"; tighten if that ever hides a fallback
				if (!have.some((f) => f === low || f.startsWith(`${low} `)))
					missing.add(fam);
			}
			for (const fam of missing)
				add("font", `${fam} not in ${d.text.fonts.join(", ") || "node fonts"}`);
		}
	};

	const walk = (nodes: NodeIR[]) => {
		for (const n of nodes) {
			check(n);
			if (n.kind === "frame") walk(n.children);
		}
	};
	walk(ir.root);
	return { pass: issues.length === 0, issues };
}
