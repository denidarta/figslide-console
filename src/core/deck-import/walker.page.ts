// Page-side code for capture.ts. Each exported function is passed to page.evaluate(), which
// stringifies it, so each must be fully self-contained: no imports (type imports are erased),
// no shared helpers between functions, no references to module scope. Every closure that runs
// in the page must live in this file: jest.config.cjs excludes it from coverage instrumentation
// (cov_* counters do not exist in the page), and inline arrows elsewhere would be instrumented.
import type { RawAnim, RawNode, TextRun } from "./types.js";

/** JSON has no Infinity: `iterations: null` means infinite. capture.ts maps it back. */
export type PageAnim = Omit<RawAnim, "iterations"> & {
	iterations: number | null;
};
export interface PageWalk {
	nodes: RawNode[];
	anims: PageAnim[];
}

/**
 * Runs before any page script (evaluateOnNewDocument): records live setInterval timers and setTimeout
 * chains (a timeout scheduled from inside a timeout callback) with their delays, so settleSlide can watch
 * long enough to catch a JS loop slower than its default window.
 */
export function trackTimers(): void {
	const w = window as unknown as Record<string, unknown> & {
		__deckTimers?: Map<number, number>;
	};
	if (w.__deckTimers) return;
	const live = new Map<number, number>(); // timer id -> delay ms
	w.__deckTimers = live;
	const native = {
		setInterval: window.setInterval.bind(window),
		clearInterval: window.clearInterval.bind(window),
		setTimeout: window.setTimeout.bind(window),
		clearTimeout: window.clearTimeout.bind(window),
	};
	let inTimeout = false;
	const ms = (d: unknown) => Number(d) || 0;
	w.setInterval = (fn: TimerHandler, delay?: number, ...args: unknown[]) => {
		const id = native.setInterval(fn, delay, ...args);
		live.set(id, ms(delay));
		return id;
	};
	w.setTimeout = (fn: TimerHandler, delay?: number, ...args: unknown[]) => {
		const chained = inTimeout;
		let id = 0;
		const run =
			typeof fn === "function"
				? (...a: unknown[]) => {
						live.delete(id);
						inTimeout = true;
						try {
							return (fn as (...x: unknown[]) => unknown)(...a);
						} finally {
							inTimeout = false;
						}
					}
				: fn;
		id = native.setTimeout(run, delay, ...args);
		if (chained) live.set(id, ms(delay));
		return id;
	};
	// Timer ids share one pool, so either clear works for both kinds.
	const clear = (id?: number) => {
		if (id !== undefined) live.delete(id);
	};
	w.clearInterval = (id?: number) => {
		clear(id);
		native.clearInterval(id);
	};
	w.clearTimeout = (id?: number) => {
		clear(id);
		native.clearTimeout(id);
	};
}

/** True once deck-stage is defined and the runtime has rendered its slides. */
export function deckReady(): boolean {
	return (
		!!customElements.get("deck-stage") &&
		(document.querySelector("deck-stage")?.children.length ?? 0) > 0
	);
}

/** One-time page setup: 1:1 scale, hide deck chrome, wait for fonts. Returns the slide count. */
export async function prepareDeck(): Promise<number> {
	const deck = document.querySelector("deck-stage") as HTMLElement;
	deck.setAttribute("noscale", "");
	// Deck chrome (slide counter, rail) would otherwise appear in screenshots.
	const hide = document.createElement("style");
	hide.textContent =
		".overlay,.rail,.rail-resize,.ctxmenu{display:none!important}";
	deck.shadowRoot?.appendChild(hide);
	await document.fonts.ready;
	return Array.from(deck.children).filter(
		(e) => !/^(TEMPLATE|SCRIPT|STYLE)$/.test(e.tagName),
	).length;
}

/** Slide label / skip flag / speaker notes, resolved the way deck-stage resolves them. */
export function readSlideMeta(slideIndex: number): {
	name: string;
	skipped: boolean;
	notes: string;
} {
	const deck = document.querySelector("deck-stage") as HTMLElement;
	const section = Array.from(deck.children).filter(
		(e) => !/^(TEMPLATE|SCRIPT|STYLE)$/.test(e.tagName),
	)[slideIndex] as HTMLElement;
	if (!section) throw new Error(`No slide ${slideIndex}`);
	// Label precedence mirrors deck-stage: data-label, data-screen-label (number stripped), first heading.
	const screen = section.getAttribute("data-screen-label");
	const heading = (
		section.querySelector("h1, h2, h3, [data-title]")?.textContent || ""
	)
		.trim()
		.slice(0, 40);
	const name =
		section.getAttribute("data-label") ||
		(screen && (screen.replace(/^\s*\d+\s*/, "").trim() || screen)) ||
		heading ||
		"Slide";
	// Per-slide data-speaker-notes wins, then the #speaker-notes JSON array.
	let json: unknown = null;
	try {
		json = JSON.parse(
			document.getElementById("speaker-notes")?.textContent || "[]",
		);
	} catch {}
	const attr = section.getAttribute("data-speaker-notes");
	const fromJson =
		Array.isArray(json) && typeof json[slideIndex] === "string"
			? json[slideIndex]
			: "";
	return {
		name,
		skipped: section.hasAttribute("data-deck-skip"),
		notes: attr !== null ? attr : fromJson,
	};
}

/**
 * Activates the slide, records its animations (before finishing them), drives it to its end
 * state, and watches for JS-driven mutation: 300ms, or one tick of the slowest live JS timer loop
 * (trackTimers) up to 3s. Results are stashed on `window` for walkSlide.
 */
export async function settleSlide(slideIndex: number): Promise<void> {
	const frame = () =>
		new Promise<void>((r) => requestAnimationFrame(() => r()));
	const deck = document.querySelector("deck-stage") as HTMLElement & {
		goTo(i: number): void;
	};
	const section = Array.from(deck.children).filter(
		(e) => !/^(TEMPLATE|SCRIPT|STYLE)$/.test(e.tagName),
	)[slideIndex] as HTMLElement;
	if (!section) throw new Error(`No slide ${slideIndex}`);

	if (section.hasAttribute("data-deck-active")) {
		// Already active (slide 0 after load, or a repeat capture): goTo would be a no-op, so
		// toggle the attribute to restart animations gated on [data-deck-active].
		section.removeAttribute("data-deck-active");
		void section.offsetWidth;
		section.setAttribute("data-deck-active", "");
	} else {
		deck.goTo(slideIndex);
	}
	// Collect animations right away: finite entrances without a fill-mode drop out of
	// getAnimations() once they finish, so the fonts/images waits must come after.
	await frame();
	await frame();

	const up = (n: Node): Node | null =>
		n.parentNode || (n as ShadowRoot).host || null;
	const inSection = (n: Node | null): boolean => {
		for (let c = n; c; c = up(c)) {
			if (c === section) return true;
		}
		return false;
	};
	const live = document
		.getAnimations()
		.filter((a) =>
			inSection((a.effect as KeyframeEffect | null)?.target ?? null),
		);

	const anims: Array<PageAnim & { el: Element }> = [];
	for (const a of live) {
		if (a instanceof CSSTransition) continue;
		const eff = a.effect as KeyframeEffect;
		const timing = eff.getTiming();
		const kfs = eff.getKeyframes() as Array<Record<string, unknown>>;
		const first: Record<string, string> = {};
		for (const [k, v] of Object.entries(kfs[0] || {})) {
			if (!["offset", "computedOffset", "easing", "composite"].includes(k))
				first[k] = String(v);
		}
		// CSS animation-timing-function lands on the keyframes; effect easing stays "linear".
		const kfEasing = kfs[0]?.easing as string | undefined;
		anims.push({
			el: eff.target as Element,
			nodeId: "",
			name: (a as CSSAnimation).animationName ?? a.id ?? "",
			iterations: Number.isFinite(timing.iterations)
				? (timing.iterations as number)
				: null,
			delayMs: Number(timing.delay) || 0,
			durationMs: Number(eff.getComputedTiming().duration) || 0,
			easing:
				kfEasing && kfEasing !== "linear" ? kfEasing : String(timing.easing),
			firstKeyframe: first,
		});
	}

	for (const a of live) {
		try {
			if (Number.isFinite(a.effect?.getTiming().iterations)) {
				a.finish();
			} else {
				// Infinite loops: park at t=0 so captured boxes/styles are deterministic.
				a.pause();
				a.currentTime = 0;
			}
		} catch {}
	}
	await frame();
	await document.fonts.ready; // fonts for this slide are only requested once it is laid out
	// Natural sizes are only known once images have loaded (capped so a dead URL cannot hang capture).
	const pending = Array.from(section.querySelectorAll("img"))
		.filter((im) => !im.complete)
		.map(
			(im) =>
				new Promise<void>((r) => {
					im.addEventListener("load", () => r(), { once: true });
					im.addEventListener("error", () => r(), { once: true });
				}),
		);
	if (pending.length) {
		await Promise.race([
			Promise.all(pending),
			new Promise((r) => setTimeout(r, 5000)),
		]);
	}
	await frame();

	const mutated = new Set<Element>();
	const mo = new MutationObserver((records) => {
		for (const r of records) {
			const el =
				r.target.nodeType === 1
					? (r.target as Element)
					: r.target.parentElement;
			if (el && el !== section && section.contains(el)) mutated.add(el);
		}
	});
	mo.observe(section, {
		attributes: true,
		childList: true,
		characterData: true,
		subtree: true,
	});
	const timers = (window as unknown as { __deckTimers?: Map<number, number> })
		.__deckTimers;
	let watchMs = 300;
	for (const d of timers?.values() ?? [])
		if (d <= 3000) watchMs = Math.max(watchMs, d + 100);
	await new Promise((r) => setTimeout(r, watchMs));
	mo.disconnect();

	(window as unknown as { __deckCapture: unknown }).__deckCapture = {
		anims,
		mutated: Array.from(mutated),
	};
}

/** Snapshots the active slide. Call after settleSlide. */
export function walkSlide(slideIndex: number): PageWalk {
	const stash = (
		window as unknown as {
			__deckCapture?: {
				anims: Array<PageAnim & { el: Element }>;
				mutated: Element[];
			};
		}
	).__deckCapture || { anims: [], mutated: [] };

	const deck = document.querySelector("deck-stage") as HTMLElement;
	const section = Array.from(deck.children).filter(
		(e) => !/^(TEMPLATE|SCRIPT|STYLE)$/.test(e.tagName),
	)[slideIndex] as HTMLElement;
	if (!section) throw new Error(`No slide ${slideIndex}`);

	const secRect = section.getBoundingClientRect();
	const W = secRect.width;
	const H = secRect.height;
	const r3 = (v: number) => Math.round(v * 1000) / 1000;
	const boxOf = (l: number, t: number, w: number, h: number) => ({
		x: r3(l - secRect.left),
		y: r3(t - secRect.top),
		w: r3(w),
		h: r3(h),
	});
	type Box = RawNode["box"];
	const unseen = (b: Box) => b.w < 0.01 || b.h < 0.01;
	const offSlide = (b: Box) =>
		b.x + b.w <= 0 || b.x >= W || b.y + b.h <= 0 || b.y >= H;

	const STYLE_KEYS = [
		"backgroundColor",
		"backgroundImage",
		"backgroundClip",
		"webkitBackgroundClip",
		"borderTopWidth",
		"borderRightWidth",
		"borderBottomWidth",
		"borderLeftWidth",
		"borderTopColor",
		"borderRightColor",
		"borderBottomColor",
		"borderLeftColor",
		"borderStyle",
		"borderTopLeftRadius",
		"borderTopRightRadius",
		"borderBottomRightRadius",
		"borderBottomLeftRadius",
		"boxShadow",
		"opacity",
		"overflow",
		"transform",
		"backdropFilter",
		"filter",
		"clipPath",
		"mixBlendMode",
		"maskImage",
		"textAlign",
		"objectFit",
		"color",
		"fontFamily",
		"fontWeight",
		"fontStyle",
		"fontSize",
		"lineHeight",
		"letterSpacing",
		"textDecorationLine",
		"textTransform",
	];
	const TEXT_KEYS = [
		"textAlign",
		"textTransform",
		"color",
		"fontFamily",
		"fontWeight",
		"fontStyle",
		"fontSize",
		"lineHeight",
		"letterSpacing",
		"textDecorationLine",
	];

	// ---- colors: everything leaves this function as rgb()/rgba() --------------------------
	const ctx = document
		.createElement("canvas")
		.getContext("2d", { willReadFrequently: true });
	if (!ctx) throw new Error("canvas 2d context unavailable");
	const SENTINEL = "#010203";
	const paint = (css: string): Uint8ClampedArray | null => {
		ctx.clearRect(0, 0, 1, 1);
		ctx.fillStyle = SENTINEL;
		ctx.fillStyle = css;
		if (ctx.fillStyle === SENTINEL && css.toLowerCase() !== SENTINEL)
			return null; // unparseable
		ctx.fillRect(0, 0, 1, 1);
		return ctx.getImageData(0, 0, 1, 1).data;
	};
	// Chrome's canvas keeps oklch()/lab()/color() as written, so read pixels instead.
	const toRgb = (css: string): string => {
		let px = paint(css);
		if (!px) return css;
		let a = px[3] / 255;
		if (px[3] !== 255) {
			// Premultiplied pixels lose precision; take alpha from the source and repaint opaque.
			const m = /\/\s*([\d.]+)(%?)\s*\)$/.exec(css);
			if (m) {
				a = Number.parseFloat(m[1]) / (m[2] ? 100 : 1);
				px = paint(`${css.slice(0, m.index)})`) ?? px;
			}
		}
		const rgb = `${px[0]}, ${px[1]}, ${px[2]}`;
		return a >= 1
			? `rgb(${rgb})`
			: `rgba(${rgb}, ${Math.round(a * 1000) / 1000})`;
	};
	// Computed styles already give rgb()/rgba() for sRGB colors; these are the ones left over.
	const MODERN =
		/\b(?:color-mix|oklch|oklab|lab|lch|hwb|hsla?|color|light-dark)\(/g;
	const fixColors = (s: string): string => {
		let out = "";
		let i = 0;
		MODERN.lastIndex = 0;
		for (let m = MODERN.exec(s); m; m = MODERN.exec(s)) {
			let depth = 1;
			let j = MODERN.lastIndex;
			for (; j < s.length && depth; j++) {
				if (s[j] === "(") depth++;
				else if (s[j] === ")") depth--;
			}
			out += s.slice(i, m.index) + toRgb(s.slice(m.index, j));
			i = j;
			MODERN.lastIndex = j;
		}
		return out + s.slice(i);
	};
	// `linear-gradient(in oklch, ...)`: the interpolation space cannot survive the conversion.
	const dropInterpolation = (s: string): string =>
		s
			.replace(
				/\(\s*in\s+[a-z0-9-]+(?:\s+(?:shorter|longer|increasing|decreasing)\s+hue)?\s*,?\s*/g,
				"(",
			)
			.replace(
				/\s+in\s+[a-z0-9-]+(?:\s+(?:shorter|longer|increasing|decreasing)\s+hue)?(?=\s*,)/g,
				"",
			);

	const pick = (
		cs: CSSStyleDeclaration,
		keys: string[],
	): Record<string, string> => {
		const out: Record<string, string> = {};
		for (const k of keys) {
			const v = (cs as unknown as Record<string, unknown>)[k];
			if (typeof v !== "string") continue;
			out[k] = fixColors(v.includes("gradient(") ? dropInterpolation(v) : v);
		}
		return out;
	};

	// ---- traversal helpers -----------------------------------------------------------------
	const kids = (n: Node): Node[] => {
		if (n instanceof Element && n.shadowRoot)
			return Array.from(n.shadowRoot.childNodes);
		return Array.from(n.childNodes);
	};
	// Light DOM, open shadow roots, and <slot> contents are flattened into the rendered tree.
	const children = (n: Node): Node[] =>
		kids(n).flatMap((c) =>
			c instanceof HTMLSlotElement
				? c.assignedNodes({ flatten: true }).length
					? c.assignedNodes({ flatten: true })
					: children(c)
				: [c],
		);
	const SKIP = /^(script|style|link|meta|title|head|template|noscript|br|wbr)$/;
	const up = (n: Node): Node | null =>
		n.parentNode || (n as ShadowRoot).host || null;
	const iconOf = (el: Element) => {
		const c = Array.from(el.classList).find((k) => /^icon-/.test(k));
		return c && /lucide/i.test(getComputedStyle(el).fontFamily) ? c : undefined;
	};
	const isLeaf = (el: Element) =>
		/^(img|svg|image-slot|canvas|video|audio|iframe|object|embed)$/.test(
			el.localName,
		) || !!iconOf(el);
	const hasDirectText = (el: Element) =>
		children(el).some((c) => c.nodeType === 3 && /\S/.test((c as Text).data));
	const paintsBox = (cs: CSSStyleDeclaration) =>
		cs.backgroundImage !== "none" ||
		cs.boxShadow !== "none" ||
		cs.opacity !== "1" ||
		cs.transform !== "none" ||
		(!/^rgba\(.*, 0\)$/.test(cs.backgroundColor) &&
			cs.backgroundColor !== "transparent") ||
		["Top", "Right", "Bottom", "Left"].some(
			(s) =>
				Number.parseFloat(
					(cs as unknown as Record<string, string>)[`border${s}Width`],
				) > 0,
		);

	/** True when ::before or ::after of `el` draws something: content with text, or an empty box with a paint. */
	const pseudoDraws = (el: Element): boolean =>
		["::before", "::after"].some((which) => {
			const ps = getComputedStyle(el, which);
			const content = ps.content;
			if (!content || content === "none" || content === "normal") return false;
			if (
				ps.display === "none" ||
				ps.visibility === "hidden" ||
				ps.opacity === "0"
			)
				return false;
			if (content !== '""' && content !== "''") return true;
			const side = (k: string) =>
				Number.parseFloat((ps as unknown as Record<string, string>)[k]);
			return (
				side("width") !== 0 &&
				side("height") !== 0 &&
				(ps.backgroundImage !== "none" ||
					ps.boxShadow !== "none" ||
					(!/^rgba\(.*, 0\)$/.test(ps.backgroundColor) &&
						ps.backgroundColor !== "transparent") ||
					["Top", "Right", "Bottom", "Left"].some(
						(s) => side(`border${s}Width`) > 0,
					))
			);
		});

	// ---- inline svg: page CSS does not travel with outerHTML -----------------------------------------
	const SVGNS = "http://www.w3.org/2000/svg";
	// Inherited presentation properties with their initial values: written where they differ from the
	// parent's (the copy inherits too), or on the root from the initial value.
	const SVG_INHERITED: Record<string, string> = {
		fill: "#000000",
		"fill-opacity": "1",
		"fill-rule": "nonzero",
		stroke: "none",
		"stroke-width": "1",
		"stroke-opacity": "1",
		"stroke-linecap": "butt",
		"stroke-linejoin": "miter",
		"stroke-dasharray": "none",
		"stroke-dashoffset": "0",
		"stroke-miterlimit": "4",
		"font-family": "",
		"font-size": "",
		"font-weight": "400",
		"font-style": "normal",
		"text-anchor": "start",
		visibility: "visible",
	};
	// Not inherited: written where they differ from the initial value.
	const SVG_OWN: Record<string, string> = {
		opacity: "1",
		"stop-color": "#000000",
		"stop-opacity": "1",
	};
	// A colour's alpha moves into its opacity property, so attributes stay plain #hex.
	const SVG_ALPHA: Record<string, string> = {
		"fill-opacity": "fill",
		"stroke-opacity": "stroke",
		"stop-opacity": "stop-color",
	};
	const SVG_PAINTED =
		/^(svg|g|a|switch|path|rect|circle|ellipse|line|polyline|polygon|text|tspan|textPath|stop|image)$/;
	const SVG_DEFS =
		/^(defs|symbol|clipPath|mask|pattern|marker|linearGradient|radialGradient|filter)$/;
	const splitColor = (css: string) => {
		const m = /^rgba?\(([^)]*)\)$/.exec(css);
		if (!m) return null;
		const p = m[1].split(/[\s,/]+/).filter(Boolean).map(Number.parseFloat);
		return {
			hex: `#${p
				.slice(0, 3)
				.map((v) => Math.round(v).toString(16).padStart(2, "0"))
				.join("")}`,
			a: p.length > 3 ? p[3] : 1,
		};
	};
	/** One property's value as it should be written: colours as #hex, opacities times the colour's alpha. */
	const svgValue = (cs: CSSStyleDeclaration, prop: string): string => {
		const raw = fixColors(cs.getPropertyValue(prop).trim());
		const colorProp = SVG_ALPHA[prop];
		if (colorProp) {
			const c = splitColor(fixColors(cs.getPropertyValue(colorProp).trim()));
			const o = Number.parseFloat(raw);
			const v = (Number.isFinite(o) ? o : 1) * (c ? c.a : 1);
			return String(Math.round(v * 1000) / 1000);
		}
		const c = splitColor(raw);
		if (c) return c.hex;
		const v = raw.replace(/url\("([^"]*)"\)/g, "url($1)");
		return /^(stroke-width|stroke-dasharray|stroke-dashoffset|font-size)$/.test(
			prop,
		)
			? v.replace(/px/g, "")
			: v;
	};
	/** Writes `orig`'s computed presentation onto `out`; `parent` is the element it inherits from (null: the root). */
	const paintSvg = (orig: Element, out: Element, parent: Element | null) => {
		out.removeAttribute("style");
		out.removeAttribute("class");
		if (!SVG_PAINTED.test(orig.localName)) return;
		const cs = getComputedStyle(orig);
		const pcs = parent ? getComputedStyle(parent) : null;
		for (const [p, initial] of Object.entries(SVG_INHERITED)) {
			const v = svgValue(cs, p);
			if (v && v !== (pcs ? svgValue(pcs, p) : initial)) out.setAttribute(p, v);
		}
		// The root's own opacity is the vector node's opacity already.
		if (!parent) return;
		for (const [p, initial] of Object.entries(SVG_OWN)) {
			const v = svgValue(cs, p);
			if (v && v !== initial) out.setAttribute(p, v);
		}
	};
	const inDefs = (el: Element) => {
		for (let e: Element | null = el; e; e = e.parentElement)
			if (SVG_DEFS.test(e.localName)) return true;
		return false;
	};
	/**
	 * A copy of an inline svg element with its computed styling written out as attributes: class rules,
	 * var() and currentColor resolve, <style> and display:none parts drop, and <use> becomes a copy of
	 * what it references (a <symbol> becomes a nested <svg>), so Figma sees what the page draws.
	 */
	const copySvg = (
		orig: Element,
		parent: Element | null,
		depth: number,
	): Element | null => {
		const tag = orig.localName;
		if (tag === "style" || tag === "script") return null;
		if (parent && !inDefs(orig) && getComputedStyle(orig).display === "none")
			return null;
		if (tag === "use" && depth < 4) {
			const href =
				orig.getAttribute("href") || orig.getAttribute("xlink:href") || "";
			const scope = orig.getRootNode() as Document | ShadowRoot;
			const ref = href.startsWith("#")
				? scope.getElementById(href.slice(1))
				: null;
			if (ref) {
				const g = document.createElementNS(SVGNS, "g");
				paintSvg(orig, g, parent);
				const at = (k: string) =>
					Number.parseFloat(orig.getAttribute(k) || "0") || 0;
				const move = [
					orig.getAttribute("transform"),
					at("x") || at("y") ? `translate(${at("x")} ${at("y")})` : "",
				]
					.filter(Boolean)
					.join(" ");
				if (move) g.setAttribute("transform", move);
				if (ref.localName === "symbol") {
					// A symbol is a viewport sized by the use (100% of the nearest svg when unset).
					const vp = (orig as SVGElement).ownerSVGElement;
					const vb = vp?.viewBox?.baseVal;
					const size = (k: "width" | "height") =>
						orig.getAttribute(k) ||
						String(
							vb?.[k] ||
								(vp?.getBoundingClientRect()[k] ?? 0) ||
								ref.getAttribute("viewBox")?.split(/[\s,]+/)[k === "width" ? 2 : 3] ||
								0,
						);
					const sv = document.createElementNS(SVGNS, "svg");
					for (const k of ["viewBox", "preserveAspectRatio"]) {
						const v = ref.getAttribute(k);
						if (v) sv.setAttribute(k, v);
					}
					sv.setAttribute("width", size("width"));
					sv.setAttribute("height", size("height"));
					for (const c of Array.from(ref.children)) {
						const k = copySvg(c, ref, depth + 1);
						if (k) sv.appendChild(k);
					}
					g.appendChild(sv);
				} else {
					const k = copySvg(ref, ref.parentElement, depth + 1);
					if (k) g.appendChild(k);
				}
				return g;
			}
		}
		const out = document.createElementNS(orig.namespaceURI || SVGNS, tag);
		for (const a of Array.from(orig.attributes))
			out.setAttributeNS(a.namespaceURI, a.name, a.value);
		paintSvg(orig, out, parent);
		for (const c of Array.from(orig.childNodes)) {
			if (c.nodeType === 3) out.appendChild(c.cloneNode());
			else if (c instanceof Element) {
				const k = copySvg(c, orig, depth);
				if (k) out.appendChild(k);
			}
		}
		return out;
	};

	const nodes: RawNode[] = [];
	const idOf = new Map<Element, string>();
	let seq = 0;
	const nextId = () => `s${slideIndex}-n${seq++}`;
	const smil =
		'animate[repeatCount="indefinite"],animateTransform[repeatCount="indefinite"],animateMotion[repeatCount="indefinite"],set[repeatCount="indefinite"]';
	const smilLoops = new Set<Element>();

	// ---- text blocks -------------------------------------------------------------------------
	/** Emits a #text-block for an element with direct text; returns the child elements left to walk. */
	const emitText = (
		owner: Element,
		ownerId: string,
		ownerHidden: boolean,
	): Element[] => {
		type Seg = {
			text: string;
			br: boolean;
			run: TextRun;
			keep: boolean;
			pre: boolean;
		};
		const segs: Seg[] = [];
		// Each rendered rect with the line height of its run, in px (CSS `normal` ~ 1.2 x font size, as ops.ts).
		const rects: { r: DOMRect; lh: number }[] = [];
		const lhOf = (cs: CSSStyleDeclaration) =>
			/^-?[\d.]+px$/.test(cs.lineHeight.trim())
				? Number.parseFloat(cs.lineHeight)
				: Number.parseFloat(cs.fontSize) * 1.2;
		const rest: Element[] = [];
		const runStyle = (cs: CSSStyleDeclaration, deco: string): TextRun => ({
			chars: "",
			fontFamily: cs.fontFamily,
			fontWeight: Number.parseInt(cs.fontWeight, 10) || 400,
			fontStyle: cs.fontStyle,
			fontSize: Number.parseFloat(cs.fontSize),
			// What actually paints the glyphs: -webkit-text-fill-color (= color unless set, e.g. transparent
			// for background-clip:text gradient text).
			color: fixColors(cs.webkitTextFillColor || cs.color),
			letterSpacing: cs.letterSpacing,
			lineHeight: cs.lineHeight,
			textDecoration: deco,
			// Outline text: -webkit-text-stroke draws the glyphs, often with a transparent fill.
			...(Number.parseFloat(cs.webkitTextStrokeWidth) > 0
				? {
						strokeWidth: Number.parseFloat(cs.webkitTextStrokeWidth),
						strokeColor: fixColors(cs.webkitTextStrokeColor),
					}
				: {}),
		});
		const decoOf = (cs: CSSStyleDeclaration, outer: string) =>
			Array.from(
				new Set(
					`${outer} ${cs.textDecorationLine}`
						.split(/\s+/)
						.filter((t) => t && t !== "none"),
				),
			).join(" ") || "none";
		const gather = (
			parent: Element,
			parentCs: CSSStyleDeclaration,
			deco: string,
		) => {
			for (const c of children(parent)) {
				if (c.nodeType === 3) {
					const tn = c as Text;
					if (!tn.data) continue;
					const ws = parentCs.whiteSpace;
					segs.push({
						text: tn.data,
						br: false,
						run: runStyle(parentCs, deco),
						keep: ws === "pre" || ws === "pre-wrap" || ws === "break-spaces",
						pre: ws === "pre-line",
					});
					const rg = document.createRange();
					rg.selectNodeContents(tn);
					const lh = lhOf(parentCs);
					for (const r of Array.from(rg.getClientRects())) rects.push({ r, lh });
				} else if (c instanceof Element) {
					if (c.localName === "br") {
						segs.push({
							text: "\n",
							br: true,
							run: runStyle(parentCs, deco),
							keep: false,
							pre: false,
						});
						continue;
					}
					if (SKIP.test(c.localName)) continue;
					const ccs = getComputedStyle(c);
					const flat =
						ccs.display === "inline" &&
						(ccs.position === "static" || ccs.position === "relative") &&
						ccs.cssFloat === "none" &&
						ccs.visibility === parentCs.visibility &&
						!isLeaf(c) &&
						!paintsBox(ccs);
					if (flat) gather(c, ccs, decoOf(ccs, deco));
					else rest.push(c);
				}
			}
		};
		const ocs = getComputedStyle(owner);
		gather(owner, ocs, decoOf(ocs, "none"));

		// Collapse whitespace the way the browser rendered it; &nbsp; (U+00A0) is untouched.
		const runs: TextRun[] = [];
		const sig = (r: TextRun) => JSON.stringify({ ...r, chars: "" });
		const add = (str: string, run: TextRun) => {
			if (!str) return;
			const last = runs[runs.length - 1];
			if (last && sig(last) === sig(run)) last.chars += str;
			else runs.push({ ...run, chars: str });
		};
		const trimEnd = () => {
			const last = runs[runs.length - 1];
			if (last?.chars.endsWith(" ")) {
				last.chars = last.chars.slice(0, -1);
				if (!last.chars) runs.pop();
			}
		};
		let lastSpace = true; // whitespace at the start of a block does not render
		for (const sg of segs) {
			if (sg.br) {
				trimEnd();
				add("\n", sg.run);
				lastSpace = true;
				continue;
			}
			if (sg.keep) {
				add(sg.text, sg.run);
				lastSpace = false;
				continue;
			}
			let out = "";
			for (const ch of sg.text) {
				if (ch === "\n" && sg.pre) {
					add(out, sg.run);
					out = "";
					trimEnd();
					add("\n", sg.run);
					lastSpace = true;
				} else if (/[ \t\n\r\f]/.test(ch)) {
					if (!lastSpace) out += " ";
					lastSpace = true;
				} else {
					out += ch;
					lastSpace = false;
				}
			}
			add(out, sg.run);
		}
		trimEnd();
		const tail = runs[runs.length - 1];
		if (tail?.chars.endsWith("\n")) {
			// A trailing line break (<br>, or pre-line newline) does not render an extra line.
			tail.chars = tail.chars.slice(0, -1);
			if (!tail.chars) runs.pop();
		}
		if (!runs.length) return rest;

		// Vertical writing modes stack lines as columns: everything below runs across x instead of y.
		const vertical = /^(vertical|sideways)/.test(ocs.writingMode);
		const lo = (r: DOMRect) => (vertical ? r.left : r.top);
		const hi = (r: DOMRect) => (vertical ? r.right : r.bottom);
		// Visual lines: group rects that overlap across the line (distinct tops break on mixed fonts).
		const sized = rects
			.filter(({ r }) => r.width > 0.01 && r.height > 0.01)
			.sort(
				(a, b) =>
					lo(a.r) - lo(b.r) || a.r.left + a.r.top - b.r.left - b.r.top,
			);
		const seen = sized.map(({ r }) => r);
		let lineCount = 0;
		let lt = 0;
		let lb = 0;
		let ft = 0; // first visual line, for the half-leading offset below
		let fb = 0;
		// Figma gives each line the tallest line height on it, so a 64px title over a 24px subtitle
		// is 64 x 1.2 + 24 x 1.2 tall, not twice the larger.
		const lineLh: number[] = [];
		for (const { r, lh } of sized) {
			const overlap = Math.min(lb, hi(r)) - Math.max(lt, lo(r));
			if (lineCount && overlap / Math.min(hi(r) - lo(r), lb - lt) > 0.5) {
				lt = Math.min(lt, lo(r));
				lb = Math.max(lb, hi(r));
				lineLh[lineCount - 1] = Math.max(lineLh[lineCount - 1], lh);
			} else {
				lineCount++;
				lt = lo(r);
				lb = hi(r);
				lineLh.push(lh);
			}
			if (lineCount === 1) {
				ft = lt;
				fb = lb;
			}
		}
		const left = Math.min(...seen.map((r) => r.left));
		const right = Math.max(...seen.map((r) => r.right));
		// Range rects are content-area tall; Figma auto-height text is the sum of its line heights (the
		// same px rule as ops.ts textProps). Report that line-box geometry so placement and QA agree.
		const mixed = lineLh.some((h) => Math.abs(h - lineLh[0]) > 0.01);
		const tall = lineLh.reduce((a, b) => a + b, 0);
		const top = Math.min(...seen.map((r) => r.top));
		const bottom = Math.max(...seen.map((r) => r.bottom));
		const across = ft - ((lineLh[0] ?? 0) - (fb - ft)) / 2;
		const box = !seen.length
			? { x: 0, y: 0, w: 0, h: 0 }
			: vertical
				? boxOf(across, top, tall, bottom - top)
				: boxOf(left, across, right - left, tall);
		// Figma has no vertical text: lay it out horizontally and turn it. vertical-* turns glyphs clockwise
		// (Figma -90); CSS rotations on the way up (clockwise positive) add to that.
		let rotation = 0;
		if (vertical) {
			let deg = ocs.writingMode === "sideways-lr" ? 90 : -90;
			for (let e: Element | null = owner; e; e = e.parentElement) {
				const m = /^matrix\(([^,]+), ([^,]+)/.exec(getComputedStyle(e).transform);
				if (m) deg -= (Math.atan2(Number(m[2]), Number(m[1])) * 180) / Math.PI;
			}
			rotation = ((((Math.round(deg) % 360) + 540) % 360) - 180) || 0;
		}
		const tb: RawNode = {
			id: nextId(),
			parentId: ownerId,
			tag: "#text-block",
			box,
			style: pick(ocs, TEXT_KEYS),
			text: {
				runs,
				lineCount,
				...(rotation ? { rotation } : {}),
				...(mixed ? { lineHeights: lineLh.map(r3) } : {}),
			},
		};
		if (ownerHidden || unseen(box) || offSlide(box)) tb.hidden = true;
		nodes.push(tb);
		return rest;
	};

	// ---- elements ------------------------------------------------------------------------------
	/** Emits `el` and its subtree in DOM order; returns whether anything visible resulted. */
	const walkEl = (el: Element, parentId: string | null): boolean => {
		if (SKIP.test(el.localName)) return false;
		const cs = getComputedStyle(el);
		const id = nextId();
		idOf.set(el, id);
		const rect = el.getBoundingClientRect();
		const node: RawNode = {
			id,
			parentId,
			tag: el.localName,
			box:
				cs.display === "none"
					? { x: 0, y: 0, w: 0, h: 0 }
					: boxOf(rect.left, rect.top, rect.width, rect.height),
			style: pick(cs, STYLE_KEYS),
		};
		nodes.push(node);
		if (cs.display === "none") {
			node.hidden = true;
			return false;
		}
		const selfHidden =
			cs.visibility === "hidden" || cs.visibility === "collapse";
		// Icon fonts draw their glyph via ::before; the icon is imported as a vector instead
		if (!iconOf(el) && pseudoDraws(el)) node.pseudo = true;

		let anyVisible = false;
		if (isLeaf(el)) {
			const tag = el.localName;
			// The content (image, vector, glyph) sits inside the padding; normalize insets it.
			Object.assign(
				node.style,
				pick(cs, ["paddingTop", "paddingRight", "paddingBottom", "paddingLeft"]),
			);
			if (tag === "img") {
				const im = el as HTMLImageElement;
				node.img = {
					src: im.currentSrc || im.src,
					naturalW: im.naturalWidth,
					naturalH: im.naturalHeight,
					objectFit: cs.objectFit,
				};
			} else if (tag === "svg") {
				node.svg = (copySvg(el, null, 0) as Element).outerHTML;
				if (el.querySelector(smil)) smilLoops.add(el);
			} else if (tag === "image-slot") {
				const frame = el.shadowRoot?.querySelector(".frame");
				const filled = frame?.querySelector("img") as HTMLImageElement | null;
				node.slot = {
					placeholder: el.getAttribute("placeholder") ?? "Drop an image",
					shape: el.getAttribute("shape") ?? "rounded",
				};
				const src = filled?.getAttribute("src")
					? filled.src
					: el.getAttribute("src");
				if (src) node.slot.src = src;
				if (frame) {
					// The slot's radius/mask lives on the frame inside its shadow root.
					const fcs = getComputedStyle(frame);
					Object.assign(
						node.style,
						pick(fcs, [
							"borderTopLeftRadius",
							"borderTopRightRadius",
							"borderBottomRightRadius",
							"borderBottomLeftRadius",
							"clipPath",
						]),
					);
				}
			} else {
				const icon = iconOf(el);
				if (icon) node.iconClass = icon;
			}
		} else {
			const walkKids = (list: Iterable<Node>) => {
				for (const c of list) {
					if (c instanceof Element && walkEl(c, id)) anyVisible = true;
				}
			};
			if (hasDirectText(el)) {
				const tbIndex = nodes.length;
				const rest = emitText(el, id, selfHidden);
				if (nodes.length > tbIndex && !nodes[tbIndex].hidden) anyVisible = true;
				walkKids(rest);
			} else {
				walkKids(children(el));
			}
		}

		const b = node.box;
		const noBox = cs.display === "contents";
		if (selfHidden || (!noBox && (unseen(b) || offSlide(b)) && !anyVisible)) {
			node.hidden = true;
			return false;
		}
		return true;
	};

	walkEl(section, null);

	// ---- loops: outermost element with an infinite animation or JS-driven mutation ------------
	/** Nearest emitted element at or above `el` (flattened inline spans have no node of their own). */
	const owner = (el: Element): Element | null => {
		for (let c: Node | null = el; c; c = up(c)) {
			if (c instanceof Element && idOf.has(c)) return c;
		}
		return null;
	};
	const looping = new Set<Element>();
	const markLoop = (el: Element) => {
		const o = owner(el);
		if (o && o !== section) looping.add(o); // a whole-slide loop would swallow the slide
	};
	for (const a of stash.anims) if (a.iterations === null) markLoop(a.el);
	for (const el of stash.mutated) markLoop(el);
	for (const el of smilLoops) markLoop(el);
	const hasLoopAncestor = (el: Element) => {
		for (let c = up(el); c; c = up(c)) {
			if (c instanceof Element && looping.has(c)) return true;
		}
		return false;
	};
	const loopIds = new Set<string>();
	for (const el of looping)
		if (!hasLoopAncestor(el)) loopIds.add(idOf.get(el) as string);
	for (const n of nodes) if (loopIds.has(n.id)) n.loop = true;

	const anims: PageAnim[] = stash.anims.map(({ el, ...a }) => ({
		...a,
		nodeId: idOf.get(owner(el) as Element) ?? "",
	}));
	return { nodes, anims };
}

/**
 * Pauses every animation (loop recording drives time itself). Returns the slide's page offset and
 * whether an infinite CSS/Web animation overlaps `box` (slide-relative) and can therefore be
 * seeked; otherwise the region is a JS/SMIL loop that has to be recorded in real time.
 */
export function pauseForRecording(
	slideIndex: number,
	box: { x: number; y: number; w: number; h: number },
): { x: number; y: number; seekable: boolean } {
	const deck = document.querySelector("deck-stage") as HTMLElement;
	const section = Array.from(deck.children).filter(
		(e) => !/^(TEMPLATE|SCRIPT|STYLE)$/.test(e.tagName),
	)[slideIndex] as HTMLElement;
	if (!section) throw new Error(`No slide ${slideIndex}`);
	const { left, top } = section.getBoundingClientRect();

	const anims = document.getAnimations();
	for (const a of anims) a.pause();
	const seekable = anims.some((a) => {
		if (Number.isFinite(a.effect?.getTiming().iterations)) return false;
		const r = (a.effect as KeyframeEffect).target?.getBoundingClientRect();
		return (
			!!r &&
			r.left < left + box.x + box.w &&
			r.right > left + box.x &&
			r.top < top + box.y + box.h &&
			r.bottom > top + box.y
		);
	});
	return { x: left, y: top, seekable };
}

/** Puts every infinite animation `t` ms into its steady-state cycle (a start delay is skipped). */
export function seekLoops(t: number): void {
	for (const a of document.getAnimations()) {
		const timing = a.effect?.getTiming();
		if (timing && !Number.isFinite(timing.iterations)) {
			a.currentTime = Math.max(0, Number(timing.delay) || 0) + t;
		}
	}
}
