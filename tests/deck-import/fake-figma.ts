import * as vm from "node:vm";
import { RUNTIME_SOURCE } from "../../src/core/deck-import/runtime.plugin.js";

/** A Figma node that just records what the runtime assigns to it. */
export class FNode {
	// biome-ignore lint/suspicious/noExplicitAny: records arbitrary assigned props
	[k: string]: any;
	id: string;
	name = "";
	x = 0;
	y = 0;
	width = 100;
	height = 100;
	opacity = 1;
	visible = true;
	fills: unknown[] = [];
	strokes: unknown[] = [];
	effects: unknown[] = [];
	children: FNode[] = [];
	parent: FNode | null = null;
	removed = false;
	pluginData: Record<string, string> = {};
	rangeFonts: { start: number; end: number; font: unknown }[] = [];
	ranges: { fn: string; args: unknown[] }[] = [];
	transition: unknown = null;
	characters = "";

	constructor(
		readonly type: string,
		private owner: FakeFigma,
	) {
		this.id = `${++owner.seq}:${owner.seq}`;
		owner.nodes.set(this.id, this);
		if (type === "SLIDE") owner.pageSlides.push(this);
	}

	appendChild(c: FNode) {
		c.parent?.children.splice(c.parent.children.indexOf(c), 1);
		this.children.push(c);
		c.parent = this;
	}
	remove() {
		this.parent?.children.splice(this.parent.children.indexOf(this), 1);
		this.parent = null;
		this.removed = true;
	}
	clone(): FNode {
		const c = new FNode(this.type, this.owner);
		for (const k of [
			"name",
			"x",
			"y",
			"width",
			"height",
			"opacity",
			"fills",
			"characters",
			"transition",
			"isSkippedSlide",
			"speakerNotes",
		])
			c[k] = this[k];
		c.pluginData = { ...this.pluginData };
		for (const ch of this.children) c.appendChild(ch.clone());
		this.owner.onClone?.(c);
		return c;
	}
	findAll(cb: (n: FNode) => boolean): FNode[] {
		const out: FNode[] = [];
		const walk = (n: FNode) => {
			for (const ch of n.children) {
				if (cb(ch)) out.push(ch);
				walk(ch);
			}
		};
		walk(this);
		return out;
	}
	getPluginData(k: string) {
		return this.pluginData[k] ?? "";
	}
	setPluginData(k: string, v: string) {
		this.pluginData[k] = v;
	}
	/** Like Figma: resizing a text node freezes it at a fixed size (auto-resize NONE). */
	resize(w: number, h: number) {
		if (this.type === "TEXT") this.textAutoResize = "NONE";
		this.width = w;
		this.height = h;
	}
	rescale(s: number) {
		this.width *= s;
		this.height *= s;
		this.rescaled = s;
	}
	setSlideTransition(t: unknown) {
		this.transition = t;
	}
	getSlideTransition() {
		return this.transition;
	}
	getRangeAllFontNames() {
		const seen = new Map<string, unknown>();
		for (const r of this.rangeFonts) seen.set(JSON.stringify(r.font), r.font);
		return [...seen.values()];
	}
	setRangeFontName(start: number, end: number, font: unknown) {
		this.rangeFonts.push({ start, end, font });
	}
	setRangeFontSize(...args: unknown[]) {
		this.ranges.push({ fn: "fontSize", args });
	}
	setRangeFills(...args: unknown[]) {
		this.ranges.push({ fn: "fills", args });
	}
	setRangeLetterSpacing(...args: unknown[]) {
		this.ranges.push({ fn: "letterSpacing", args });
	}
	setRangeLineHeight(...args: unknown[]) {
		this.ranges.push({ fn: "lineHeight", args });
	}
	setRangeTextDecoration(...args: unknown[]) {
		this.ranges.push({ fn: "textDecoration", args });
	}
}

export class FakeFigma {
	seq = 0;
	nodes = new Map<string, FNode>();
	pageSlides: FNode[] = [];
	rows: FNode[][] = [];
	images: Uint8Array[] = [];
	loadedFonts: { family: string; style: string }[] = [];
	/** `createSlide` succeeds only when true (an empty Slides deck throws). */
	canCreateSlide = false;
	missingFamilies = new Set<string>();
	/** Installed fonts. Styles are spelled the way each family spells them in Figma (Inter: "Semi Bold"). */
	availableFonts: { family: string; style: string }[] = [
		...[
			"Thin",
			"ExtraLight",
			"Light",
			"Regular",
			"Medium",
			"SemiBold",
			"Bold",
			"ExtraBold",
			"Black",
		].map((style) => ({ family: "Geist", style })),
		...[
			"Thin",
			"Extra Light",
			"Light",
			"Regular",
			"Medium",
			"Semi Bold",
			"Bold",
			"Extra Bold",
			"Black",
			"Italic",
			"Bold Italic",
		].map((style) => ({ family: "Inter", style })),
	];
	/** Called with every cloned node, to inject failures. */
	onClone?: (clone: FNode) => void;
	readonly mixed = Symbol("mixed");

	/** Adds a slide the way a user would: appended to the last row. */
	addSlide(name = "Slide"): FNode {
		const s = new FNode("SLIDE", this);
		s.name = name;
		s.width = 1920;
		s.height = 1080;
		if (!this.rows.length) this.rows.push([]);
		this.rows[this.rows.length - 1].push(s);
		return s;
	}
	installedFonts() {
		return this.availableFonts.filter(
			(f) => !this.missingFamilies.has(f.family),
		);
	}
	/** The slides of the grid, in order. */
	gridIds() {
		return this.rows.map((r) => r.filter((s) => !s.removed).map((s) => s.id));
	}

	api() {
		const make = (type: string) => () => new FNode(type, this);
		return {
			mixed: this.mixed,
			currentPage: {
				findAll: (cb: (n: FNode) => boolean) => {
					const out: FNode[] = [];
					for (const s of this.pageSlides) {
						if (s.removed) continue;
						if (cb(s)) out.push(s);
						out.push(...s.findAll(cb));
					}
					return out;
				},
			},
			createFrame: make("FRAME"),
			createText: make("TEXT"),
			createRectangle: make("RECTANGLE"),
			createNodeFromSvg: (svg: string) => {
				if (svg.includes("BAD")) throw new Error("Invalid SVG");
				const f = new FNode("FRAME", this);
				f.width = 24;
				f.height = 24;
				f.svg = svg;
				f.appendChild(new FNode("VECTOR", this));
				return f;
			},
			createImage: (bytes: Uint8Array) => {
				this.images.push(bytes);
				return { hash: `hash${this.images.length}` };
			},
			createSlide: () => {
				if (!this.canCreateSlide)
					throw new Error("Cannot create node with type SLIDE");
				return this.addSlide("New");
			},
			listAvailableFontsAsync: async () =>
				this.installedFonts().map((fontName) => ({ fontName })),
			loadFontAsync: async (f: { family: string; style: string }) => {
				if (
					!this.installedFonts().some(
						(a) => a.family === f.family && a.style === f.style,
					)
				)
					throw new Error(`Font ${f.family} ${f.style} not found`);
				this.loadedFonts.push(f);
			},
			base64Decode: (s: string) => new Uint8Array(Buffer.from(s, "base64")),
			getNodeByIdAsync: async (id: string) => {
				const n = this.nodes.get(id);
				return n && !n.removed ? n : null;
			},
			getSlideGrid: () => this.rows.map((r) => r.filter((s) => !s.removed)),
			setSlideGrid: (rows: FNode[][]) => {
				// Mirror Figma: every live slide must be in the new grid.
				const given = new Set(rows.flat().map((s) => s.id));
				for (const s of this.pageSlides)
					if (!s.removed && this.rows.flat().includes(s) && !given.has(s.id))
						throw new Error("setSlideGrid: slide missing from grid");
				this.rows = rows.map((r) => [...r]);
			},
		};
	}
}

/** A Figma plugin sandbox: runs RUNTIME_SOURCE the way EXECUTE_CODE does, one fresh function scope per call. */
export class Sandbox {
	fake = new FakeFigma();
	private context: vm.Context;

	constructor() {
		this.context = this.newContext();
	}
	private newContext() {
		return vm.createContext({ figma: this.fake.api() });
	}
	/** Simulates the plugin context being torn down between calls (globalThis wiped). */
	reset() {
		this.context = this.newContext();
	}
	/** Runs arbitrary code in the EXECUTE_CODE wrapper. */
	async exec(code: string): Promise<unknown> {
		const out = await vm.runInContext(
			`(async function() {\n${code}\n})()`,
			this.context,
		);
		return out === undefined ? undefined : JSON.parse(JSON.stringify(out));
	}
	/** Runs one runtime command; the result is JSON round-tripped like the real bridge. */
	run(cmd: object) {
		return this.exec(
			`${RUNTIME_SOURCE}\nreturn await __deckImport(${JSON.stringify(cmd)})`,
		);
	}
}
