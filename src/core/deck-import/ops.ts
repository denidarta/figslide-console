import { letterSpacingPercent, mapFontWeight, parseColorRaw } from "./css.js";
import type { Effect, NodeIR, Paint, RGBA, SlideIR, TextRun } from "./types.js";

/**
 * One node to create in the plugin. `id` is the importId; `parent` is another op's `id` (null = the
 * slide). Props are already in Figma API form, positions relative to the parent, so the runtime only
 * assigns them (and `patch` reuses the same setters).
 */
export type Op = {
	op: "frame" | "text" | "image" | "vector" | "slot";
	id: string;
	parent: string | null;
	name: string;
	props: Record<string, unknown>;
};

type FigmaPaint = Record<string, unknown>;

const rgb = ({ r, g, b }: RGBA) => ({ r, g, b });
const solid = (c: RGBA): FigmaPaint => ({
	type: "SOLID",
	color: rgb(c),
	opacity: c.a,
});

/** Slide size, for slide-background gradients. */
export const SLIDE_SIZE = { w: 1920, h: 1080 };

/**
 * Text boxes are measured to the widest line, to 1/64px; Figma's glyph advances can come out wider
 * (live run: Geist Bold 104px, 740 vs 734.9px, ~0.7%) and wrap the last word. Ops widen every text box
 * by this much (QA tolerates it) and shift x so the aligned edge stays put.
 */
export const textSlack = (w: number) => Math.max(2, w * 0.015);
const SLACK_SHIFT = { LEFT: 0, JUSTIFIED: 0, CENTER: 0.5, RIGHT: 1 } as const;

/**
 * Figma's gradientTransform maps node space (0..1) into gradient space where t = x'. Solve it so the
 * CSS gradient line (length |w sin| + |h cos|, through the centre, at `angleDeg` clockwise from "up")
 * runs t = 0 -> 1; the second row is the perpendicular so the handle stays orthonormal in pixels.
 */
function linearTransform(angleDeg: number, w: number, h: number): number[][] {
	const rad = (angleDeg * Math.PI) / 180;
	const dx = Math.sin(rad);
	const dy = -Math.cos(rad);
	const len = Math.abs(w * dx) + Math.abs(h * dy);
	if (!(len > 0))
		return [
			[1, 0, 0],
			[0, 1, 0],
		];
	const p0x = w / 2 - (dx * len) / 2;
	const p0y = h / 2 - (dy * len) / 2;
	const [nx, ny] = [-dy, dx];
	return [
		[(w * dx) / len, (h * dy) / len, -(p0x * dx + p0y * dy) / len],
		[(w * nx) / len, (h * ny) / len, 0.5 - ((w / 2) * nx + (h / 2) * ny) / len],
	];
}

// ponytail: the IR keeps no radial shape/centre, so assume CSS's default (ellipse, farthest-corner, centred).
const RADIAL = (() => {
	const s = Math.SQRT1_2;
	return [
		[s, 0, 0.5 - 0.5 * s],
		[0, s, 0.5 - 0.5 * s],
	];
})();

/** IR paints -> Figma paints (the IR is already bottom-to-top). */
export function figmaPaints(
	paints: Paint[],
	size: { w: number; h: number },
): FigmaPaint[] {
	return paints.map((p) =>
		p.type === "SOLID"
			? solid(p.color)
			: {
					type: p.type,
					gradientStops: p.stops.map((s) => ({
						position: s.pos,
						color: s.color,
					})),
					gradientTransform:
						p.type === "GRADIENT_LINEAR"
							? linearTransform(p.angleDeg, size.w, size.h)
							: RADIAL,
				},
	);
}

function figmaEffect(e: Effect): Record<string, unknown> {
	if ("radius" in e) return { type: e.type, radius: e.radius, visible: true };
	return {
		type: e.type,
		color: e.color,
		offset: { x: e.x, y: e.y },
		radius: e.blur,
		spread: e.spread,
		visible: true,
		blendMode: "NORMAL",
	};
}

export const firstFamily = (css: string) =>
	css
		.split(",")[0]
		.trim()
		.replace(/^["']|["']$/g, "");

/** Transparent text paints nothing; a colour we cannot parse falls back to black rather than vanishing. */
function runFills(css: string): FigmaPaint[] {
	const c = parseColorRaw(css) ?? { r: 0, g: 0, b: 0, a: 1 };
	return c.a > 0 ? [solid(c)] : [];
}

function textProps(runs: TextRun[]) {
	let at = 0;
	let lineHeightPx = 0;
	const out = runs
		.filter((r) => r.chars.length > 0)
		.map((r) => {
			const family = firstFamily(r.fontFamily);
			const px = /^-?[\d.]+px$/.test(r.lineHeight.trim())
				? Number.parseFloat(r.lineHeight)
				: r.fontSize * 1.2; // ponytail: CSS `normal` ~ 1.2 x font size; set explicitly so dump's line count matches
			lineHeightPx = Math.max(lineHeightPx, px);
			const start = at;
			at += r.chars.length;
			return {
				start,
				end: at,
				family,
				style: mapFontWeight(
					family,
					r.fontWeight,
					[],
					/italic|oblique/.test(r.fontStyle),
				).style,
				fontSize: r.fontSize,
				fills: runFills(r.color),
				letterSpacing: {
					unit: "PERCENT",
					value: letterSpacingPercent(r.letterSpacing, r.fontSize),
				},
				lineHeight: { unit: "PIXELS", value: px },
				decoration: /underline/.test(r.textDecoration)
					? "UNDERLINE"
					: /line-through/.test(r.textDecoration)
						? "STRIKETHROUGH"
						: "NONE",
			};
		});
	return { runs: out, text: runs.map((r) => r.chars).join(""), lineHeightPx };
}

/**
 * Flattens a slide's IR into creation ops, parents before children. Nodes that cannot be built are
 * skipped: vectors whose `svg` is still empty (unresolved icons) and images/gifs without an uploaded hash.
 */
export function buildOps(slide: SlideIR, hashes: Map<string, string>): Op[] {
	const ops: Op[] = [];
	const walk = (
		nodes: NodeIR[],
		parent: { id: string; x: number; y: number } | null,
	) => {
		for (const n of nodes) {
			const geo = {
				x: n.box.x - (parent?.x ?? 0),
				y: n.box.y - (parent?.y ?? 0),
				w: n.box.w,
				h: n.box.h,
			};
			const pid = parent?.id ?? null;
			const push = (
				op: Op["op"],
				name: string,
				props: Record<string, unknown>,
			) =>
				ops.push({
					op,
					id: n.id,
					parent: pid,
					name: `${name} #${n.id}`,
					props: { ...geo, ...props },
				});

			switch (n.kind) {
				case "frame":
					push("frame", "Frame", {
						fills: figmaPaints(n.fills, n.box),
						strokes: n.strokes && {
							paints: [solid(n.strokes.color)],
							weights: n.strokes.weights,
							dashed: n.strokes.dashed,
						},
						radii: n.radii,
						effects: n.effects.map(figmaEffect),
						clip: n.clip,
						opacity: n.opacity,
					});
					walk(n.children, { id: n.id, x: n.box.x, y: n.box.y });
					break;
				case "text": {
					const t = textProps(n.runs);
					if (!t.text) break;
					const label = t.text.replace(/\s+/g, " ").trim().slice(0, 40);
					// Vertical text: lay out along the column (w = box height), then turn about the origin,
					// which sits where reading starts. ponytail: only ±90; slack shift ignored (no centred columns yet).
					const turned =
						n.rotation === 90 || n.rotation === -90
							? {
									x: n.rotation === 90 ? geo.x : geo.x + geo.w,
									y: n.rotation === 90 ? geo.y + geo.h : geo.y,
									w: geo.h + textSlack(geo.h),
									h: geo.w,
									rotation: n.rotation,
								}
							: null;
					push("text", label || "Text", {
						...t,
						x: geo.x - textSlack(geo.w) * SLACK_SHIFT[n.align],
						w: geo.w + textSlack(geo.w),
						...turned,
						align: n.align,
						opacity: n.opacity,
						...(n.stroke
							? {
									strokes: {
										paints: [solid(n.stroke.color)],
										weights: Array(4).fill(n.stroke.weight),
										dashed: false,
										align: "CENTER",
									},
								}
							: {}),
						// one line cannot wrap: let Figma size it, whatever its own measuring says
						autoWidth: n.lineCount === 1,
					});
					break;
				}
				case "image": {
					const hash = hashes.get(n.src);
					if (hash)
						push("image", "Image", {
							hash,
							scaleMode: n.scaleMode,
							radii: n.radii,
							opacity: n.opacity,
						});
					break;
				}
				case "gif": {
					const hash = hashes.get(n.gifKey);
					if (hash)
						push("image", "Loop", {
							hash,
							scaleMode: "FILL",
							radii: n.radii,
							opacity: 1,
						});
					break;
				}
				case "vector":
					if (n.svg)
						push("vector", "Vector", { svg: n.svg, opacity: n.opacity });
					break;
				case "slot":
					push("slot", n.name, { fills: [], radii: n.radii });
					break;
			}
		}
	};
	walk(slide.root, null);
	return ops;
}
