import { mapEasing } from "./css.js";
import type { EntranceIR, RawAnim } from "./types.js";

type Start = EntranceIR["start"][string];

/** Start-state offsets from a CSS transform. `%` and non-px lengths are static layout (centering), not motion. */
function fromTransform(transform: string): Start {
	let dx = 0;
	let dy = 0;
	let scale = 1;
	let hidden = false;
	const len = (s?: string) =>
		s && /^-?(\d+\.?\d*|\.\d+)(px)?$/.test(s) ? Number.parseFloat(s) : 0;
	for (const [, fn, raw] of transform.matchAll(/(\w+)\(([^()]*)\)/g)) {
		const a = raw.split(/[\s,]+/).filter(Boolean);
		const n = a.map(Number.parseFloat);
		switch (fn) {
			case "translate":
			case "translate3d":
				dx += len(a[0]);
				dy += len(a[1]);
				break;
			case "translateX":
				dx += len(a[0]);
				break;
			case "translateY":
				dy += len(a[0]);
				break;
			case "scale":
				if (Number.isFinite(n[0])) scale *= n[0];
				break;
			case "scaleX":
			case "scaleY":
				// A bar growing from zero width/height has no scale equivalent; fade it in instead.
				if (n[0] === 0) hidden = true;
				break;
			case "matrix": {
				if (n.length !== 6 || !n.every(Number.isFinite)) break;
				const [sx, b, c, sy, tx, ty] = n;
				dx += tx;
				dy += ty;
				if (b === 0 && c === 0) {
					if (sx === 0 || sy === 0) hidden = true;
					else if (sx === sy) scale *= sx;
				}
				break;
			}
		}
	}
	const out: Start = {};
	if (hidden) out.opacity = 0;
	if (dx) out.dx = dx;
	if (dy) out.dy = dy;
	if (scale !== 1) out.scale = scale;
	return out;
}

/** Start state of one animation from its first keyframe; empty when it animates nothing we can start from. */
function startOf(firstKeyframe: Record<string, string>): Start {
	const out: Start = {};
	for (const [k, v] of Object.entries(firstKeyframe)) {
		// getKeyframes() yields camelCase; accept kebab-case too.
		const key = k.replace(/-/g, "").toLowerCase();
		if (key === "opacity") {
			const o = Number.parseFloat(v);
			if (Number.isFinite(o)) out.opacity = o;
		} else if (key === "transform") {
			Object.assign(out, fromTransform(v));
		} else if (
			key === "height" ||
			key === "maxheight" ||
			key.startsWith("padding")
		) {
			// A box growing from nothing: approximate with a fade + rise.
			Object.assign(out, { opacity: 0, dy: 24 });
		} else if (key === "strokedashoffset") {
			out.opacity = 0; // a stroke drawing itself on
		}
	}
	return out;
}

/**
 * Collapses a slide's finite CSS entrances into one start state for a Smart Animate step. `emittedIds` must
 * not contain gif nodes; animations whose owner is missing from it (or null) are ignored.
 */
export function buildEntrance(
	anims: RawAnim[],
	emittedIds: Set<string>,
	idOwner: (rawId: string) => string | null,
): EntranceIR | null {
	const start: EntranceIR["start"] = {};
	let longest: RawAnim | null = null;
	for (const a of anims) {
		if (!Number.isFinite(a.iterations) || a.iterations <= 0) continue;
		const owner = idOwner(a.nodeId);
		if (owner === null || !emittedIds.has(owner)) continue;
		const s = startOf(a.firstKeyframe);
		if (Object.keys(s).length === 0) continue;
		start[owner] = { ...start[owner], ...s };
		if (!longest || a.durationMs > longest.durationMs) longest = a;
	}
	if (!longest) return null;
	return {
		durationS: Math.max(0.01, Math.min(1, longest.durationMs / 1000)),
		curve: mapEasing(longest.easing),
		start,
	};
}
