import { firstFamily, TEXT_SLACK } from "./ops.js";
import type {
	Box,
	FigmaDumpNode,
	NodeIR,
	QaIssue,
	QaResult,
	SlideIR,
} from "./types.js";

const TOL = 2; // px per box edge
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
 * Largest edge difference, less `slackX` on the left and right edges (text boxes are widened on purpose,
 * see ops TEXT_SLACK); a vector is fitted into its box, so it only has to be centred with one axis filled.
 */
function boxOff(ir: Box, d: Box, fitted: boolean, slackX: number): number {
	if (!fitted) {
		const [a, b] = [edges(ir), edges(d)];
		return Math.max(
			...a.map((v, i) => Math.abs(v - b[i]) - (i % 2 === 0 ? slackX : 0)),
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

		const slackX = n.kind === "text" ? TEXT_SLACK : 0;
		if (boxOff(n.box, d.box, n.kind === "vector", slackX) > TOL)
			add("box", `expected ${fmt(n.box)} got ${fmt(d.box)} (x,y,w,h)`);

		if (n.kind === "text" && d.text) {
			if (d.text.lineCount !== n.lineCount)
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
