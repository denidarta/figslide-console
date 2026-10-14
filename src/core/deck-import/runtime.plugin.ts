/**
 * Source of the code that builds slides inside the Figma Desktop Bridge plugin. It is sent with every
 * EXECUTE_CODE call (each call is a fresh function scope, wrapped as `(async function(){ <code> })()`),
 * followed by `return await __deckImport(<cmd>)`.
 *
 * Kept as a template string rather than a .js file so it works unchanged under jest (CJS), tsc output
 * (ESM) and tsx. String.raw keeps the backslashes literal: this text must contain no backticks and no
 * dollar-brace sequences. State that must survive between calls (upload chunks) lives on globalThis.
 *
 * Commands: uploadChunk | buildSlide | makeEntrance | dump | patch. Coordinates in ops are relative to
 * the parent, and every node is appended to its parent BEFORE x/y are set (Slides re-bases x/y otherwise).
 */
export const RUNTIME_SOURCE: string = String.raw`
function __deckErr(e) {
	return e && e.message ? e.message : String(e);
}

function __deckHas(o, k) {
	return Object.prototype.hasOwnProperty.call(o, k);
}

// ---- image upload ---------------------------------------------------------------------------------

function __deckUpload(cmd) {
	var store = globalThis.__deckChunks || (globalThis.__deckChunks = {});
	if (cmd.index === 0) store[cmd.key] = { parts: [] };
	var entry = store[cmd.key];
	if (!entry) return { error: "chunks lost" };
	entry.parts[cmd.index] = figma.base64Decode(cmd.b64);
	if (cmd.index < cmd.total - 1) return { received: cmd.index + 1 };
	delete store[cmd.key];
	var size = 0;
	for (var i = 0; i < cmd.total; i++) {
		if (!entry.parts[i]) return { error: "chunks lost" };
		size += entry.parts[i].length;
	}
	var bytes = new Uint8Array(size);
	var at = 0;
	for (var j = 0; j < cmd.total; j++) {
		bytes.set(entry.parts[j], at);
		at += entry.parts[j].length;
	}
	return { hash: figma.createImage(bytes).hash };
}

// ---- fonts ----------------------------------------------------------------------------------------

var __DECK_WEIGHTS = {
	thin: 100,
	hairline: 100,
	extralight: 200,
	ultralight: 200,
	light: 300,
	regular: 400,
	normal: 400,
	book: 400,
	medium: 500,
	semibold: 600,
	demibold: 600,
	bold: 700,
	extrabold: 800,
	ultrabold: 800,
	black: 900,
	heavy: 900,
};

// "Semi Bold", "semi-bold" and "SemiBold" are the same style; families spell them differently.
function __deckStyleKey(style) {
	return String(style).toLowerCase().replace(/[\s_-]+/g, "");
}

// {weight, italic} of a style name, or null when it is not a plain weight name (e.g. "Condensed").
function __deckStyleInfo(style) {
	var key = __deckStyleKey(style);
	var italic = /italic|oblique/.test(key);
	key = key.replace(/italic|oblique/g, "");
	var weight = key === "" ? 400 : __DECK_WEIGHTS[key];
	return weight === undefined ? null : { weight: weight, italic: italic };
}

// The entry of styles that is the same style under another spelling, else the nearest weight
// (same slant preferred, ties go lighter); null when nothing is comparable.
function __deckPickStyle(styles, style) {
	var key = __deckStyleKey(style);
	for (var i = 0; i < styles.length; i++) if (__deckStyleKey(styles[i]) === key) return styles[i];
	var want = __deckStyleInfo(style);
	if (!want) return null;
	var best = null;
	var bestRank = null;
	for (var j = 0; j < styles.length; j++) {
		var info = __deckStyleInfo(styles[j]);
		if (!info) continue;
		var rank = [info.italic === want.italic ? 0 : 1, Math.abs(info.weight - want.weight), info.weight];
		var better =
			!bestRank ||
			rank[0] < bestRank[0] ||
			(rank[0] === bestRank[0] && (rank[1] < bestRank[1] || (rank[1] === bestRank[1] && rank[2] < bestRank[2])));
		if (better) {
			best = styles[j];
			bestRank = rank;
		}
	}
	return best;
}

// Resolves {family, style} to a font Figma has (one listAvailableFontsAsync per loader) and loads it.
// Order: the family's own style (spelling-insensitive, else nearest weight), Inter's, then the plain
// fallbacks. Family names match case-insensitively (the list's spelling is used). A warning is recorded
// only for a real substitution (other family or other weight/slant), not for a respelling such as
// "SemiBold" -> "Semi Bold".
function __deckFontLoader(warnings) {
	var cache = {};
	var listed = false;
	var byFamily = null;
	async function families() {
		if (listed) return byFamily;
		listed = true;
		try {
			var all = await figma.listAvailableFontsAsync();
			byFamily = Object.create(null);
			for (var i = 0; i < all.length; i++) {
				var fn = all[i].fontName;
				var low = fn.family.toLowerCase();
				if (!byFamily[low]) byFamily[low] = { name: fn.family, styles: [] };
				byFamily[low].styles.push(fn.style);
			}
		} catch (e) {
			byFamily = null;
		}
		return byFamily;
	}
	return async function (f) {
		var key = f.family + "|" + f.style;
		if (cache[key]) return cache[key];
		var tries = [];
		var by = await families();
		var names = [f.family, "Inter"];
		for (var n = 0; by && n < names.length; n++) {
			var entry = by[names[n].toLowerCase()];
			var picked = entry ? __deckPickStyle(entry.styles, f.style) : null;
			if (picked) tries.push({ family: entry.name, style: picked });
		}
		tries.push(
			f,
			{ family: f.family, style: "Regular" },
			{ family: "Inter", style: f.style },
			{ family: "Inter", style: "Regular" }
		);
		for (var i = 0; i < tries.length; i++) {
			try {
				await figma.loadFontAsync(tries[i]);
				if (
					tries[i].family.toLowerCase() !== f.family.toLowerCase() ||
					__deckStyleKey(tries[i].style) !== __deckStyleKey(f.style)
				)
					warnings.push("font-fallback:" + key + "->" + tries[i].family + " " + tries[i].style);
				cache[key] = tries[i];
				return tries[i];
			} catch (e) {}
		}
		throw new Error("No usable font for " + f.family + " " + f.style);
	};
}

// ---- prop setters (shared by ops and patch) -------------------------------------------------------

async function __deckApplyText(node, p, loadFont) {
	var runs = p.runs || [];
	if (node.characters.length) {
		var cur = node.getRangeAllFontNames(0, node.characters.length);
		for (var c = 0; c < cur.length; c++) await figma.loadFontAsync(cur[c]);
	}
	var fonts = [];
	for (var i = 0; i < runs.length; i++)
		fonts.push(await loadFont({ family: runs[i].family, style: runs[i].style }));
	// Without runs the node keeps the fonts it has (loaded above); only an empty fresh node needs its default font.
	if (fonts.length) node.fontName = fonts[0];
	else if (!node.characters.length) node.fontName = await loadFont({ family: "Inter", style: "Regular" });
	node.characters = p.text !== undefined ? p.text : node.characters;
	for (var k = 0; k < runs.length; k++) {
		var r = runs[k];
		if (!(r.end > r.start)) continue;
		node.setRangeFontName(r.start, r.end, fonts[k]);
		node.setRangeFontSize(r.start, r.end, r.fontSize);
		node.setRangeFills(r.start, r.end, r.fills);
		node.setRangeLetterSpacing(r.start, r.end, r.letterSpacing);
		node.setRangeLineHeight(r.start, r.end, r.lineHeight);
		node.setRangeTextDecoration(r.start, r.end, r.decoration);
	}
	if (p.lineHeightPx) node.setPluginData("lineHeightPx", String(p.lineHeightPx));
}

function __deckApplyStrokes(node, s) {
	if (!s) {
		node.strokes = [];
		return;
	}
	var w = s.weights;
	node.strokes = s.paints;
	// CSS borders sit inside the box; -webkit-text-stroke is centred on the glyph outline.
	node.strokeAlign = s.align || "INSIDE";
	if (w[0] === w[1] && w[1] === w[2] && w[2] === w[3]) node.strokeWeight = w[0];
	else {
		node.strokeTopWeight = w[0];
		node.strokeRightWeight = w[1];
		node.strokeBottomWeight = w[2];
		node.strokeLeftWeight = w[3];
	}
	var widest = Math.max(w[0], w[1], w[2], w[3]);
	node.dashPattern = s.dashed ? [widest * 2, widest * 2] : [];
}

function __deckApplyRadii(node, r) {
	if (r[0] === r[1] && r[1] === r[2] && r[2] === r[3]) node.cornerRadius = r[0];
	else {
		node.topLeftRadius = r[0];
		node.topRightRadius = r[1];
		node.bottomRightRadius = r[2];
		node.bottomLeftRadius = r[3];
	}
}

// Assigns whichever of the known props are present. Text content/runs first: they decide the height.
async function __deckApply(node, p, loadFont) {
	if (node.type === "TEXT" && (p.runs || p.text !== undefined)) await __deckApplyText(node, p, loadFont);
	if (p.align && node.type === "TEXT") node.textAlignHorizontal = p.align;
	if (p.fills !== undefined) node.fills = p.fills;
	if (p.hash !== undefined)
		node.fills = [{ type: "IMAGE", imageHash: p.hash, scaleMode: p.scaleMode || "FILL" }];
	if (p.strokes !== undefined) __deckApplyStrokes(node, p.strokes);
	if (p.radii) __deckApplyRadii(node, p.radii);
	if (p.effects !== undefined) node.effects = p.effects;
	if (p.clip !== undefined) node.clipsContent = p.clip;
	if (p.opacity !== undefined) node.opacity = p.opacity;
	var shift = 0;
	if (node.type === "TEXT") {
		if (p.w !== undefined) {
			// resize() switches a text node to fixed size, so set auto-size afterwards. Single-line text
			// (autoWidth) is sized by Figma itself and cannot wrap; its box keeps the left edge, so move
			// it to leave the aligned edge or centre where the (slackened) box had it.
			node.resize(Math.max(p.w, 0.01), node.height);
			if (p.autoWidth) {
				node.textAutoResize = "WIDTH_AND_HEIGHT";
				var narrower = Math.max(p.w, 0.01) - node.width;
				shift = node.textAlignHorizontal === "CENTER" ? narrower / 2 : node.textAlignHorizontal === "RIGHT" ? narrower : 0;
			} else node.textAutoResize = "HEIGHT";
		}
		// Vertical text: x/y below then place the turned origin (ops put it where reading starts).
		if (p.rotation !== undefined) {
			node.rotation = p.rotation;
			shift = 0;
		}
	} else if (p.w !== undefined || p.h !== undefined) {
		node.resize(
			Math.max(p.w !== undefined ? p.w : node.width, 0.01),
			Math.max(p.h !== undefined ? p.h : node.height, 0.01)
		);
	}
	if (p.x !== undefined) node.x = p.x + shift;
	if (p.y !== undefined) node.y = p.y;
}

// An SVG import is a frame at the SVG's own size: scale it uniformly into the box and centre it.
function __deckFitVector(node, p) {
	node.fills = [];
	node.clipsContent = false;
	if (node.width > 0 && node.height > 0 && p.w > 0 && p.h > 0) {
		var s = Math.min(p.w / node.width, p.h / node.height);
		if (Math.abs(s - 1) > 1e-6) node.rescale(s);
	}
	node.x = p.x + (p.w - node.width) / 2;
	node.y = p.y + (p.h - node.height) / 2;
	if (p.opacity !== undefined) node.opacity = p.opacity;
}

async function __deckCreate(op, parent, loadFont) {
	var p = op.props;
	var node;
	if (op.op === "text") node = figma.createText();
	else if (op.op === "image") node = figma.createRectangle();
	else if (op.op === "vector") node = figma.createNodeFromSvg(p.svg);
	else node = figma.createFrame();
	try {
		parent.appendChild(node);
		node.name = op.name;
		node.setPluginData("importId", op.id);
		if (op.op === "vector") __deckFitVector(node, p);
		else await __deckApply(node, p, loadFont);
	} catch (e) {
		node.remove();
		throw e;
	}
	return node;
}

// ---- slides ---------------------------------------------------------------------------------------

var __DECK_NO_TRANSITION = {
	style: "NONE",
	duration: 0.01,
	curve: "EASE_OUT",
	timing: { type: "ON_CLICK" },
};

// createSlide() throws in an empty deck and sometimes elsewhere: clone the last slide and strip it.
async function __deckNewSlide() {
	try {
		return { slide: figma.createSlide(), cloned: false };
	} catch (e) {}
	var slides = figma.currentPage.findAll(function (n) {
		return n.type === "SLIDE";
	});
	if (!slides.length) throw new Error("Add one blank slide to the deck, then retry");
	var clone = slides[slides.length - 1].clone();
	while (clone.children.length) clone.children[clone.children.length - 1].remove();
	await __deckPlace(clone, null, 0);
	return { slide: clone, cloned: true };
}

// Moves a slide in the grid (as REORDER_SLIDES does): next to anchorId (offset 0 = before, 1 = after),
// or to the end of the deck when there is no anchor. A fresh clone may not be in the grid yet; it is added.
async function __deckPlace(slide, anchorId, offset) {
	var grid = figma.getSlideGrid();
	var rows = [];
	for (var r = 0; r < grid.length; r++) {
		var row = [];
		for (var c = 0; c < grid[r].length; c++) if (grid[r][c].id !== slide.id) row.push(grid[r][c]);
		rows.push(row);
	}
	var at = null;
	if (anchorId)
		for (var i = 0; i < rows.length; i++)
			for (var j = 0; j < rows[i].length; j++) if (rows[i][j].id === anchorId) at = [i, j];
	if (at) rows[at[0]].splice(at[1] + offset, 0, slide);
	else if (rows.length) rows[rows.length - 1].push(slide);
	else rows.push([slide]);
	figma.setSlideGrid(
		rows.filter(function (row) {
			return row.length > 0;
		})
	);
}

async function __deckBuildSlide(cmd) {
	var warnings = [];
	var loadFont = __deckFontLoader(warnings);
	var made = await __deckNewSlide();
	var slide = made.slide;
	var meta = cmd.slide;
	slide.name = meta.name;
	if (meta.background && (meta.background.length || made.cloned)) {
		try {
			slide.fills = meta.background;
		} catch (e) {
			warnings.push("slide-background: " + __deckErr(e));
		}
	}
	try {
		slide.isSkippedSlide = !!meta.skipped;
	} catch (e) {
		warnings.push("slide-meta: " + __deckErr(e));
	}
	// The live plugin API has no speakerNotes (assigning throws); notes are best effort.
	try {
		slide.speakerNotes = meta.notes || "";
	} catch (e) {}
	if (meta.transition || made.cloned) {
		try {
			slide.setSlideTransition(meta.transition || __DECK_NO_TRANSITION);
		} catch (e) {
			warnings.push("slide-transition: " + __deckErr(e));
		}
	}

	var byId = {};
	var ops = cmd.ops || [];
	for (var i = 0; i < ops.length; i++) {
		var op = ops[i];
		var parent = op.parent === null ? slide : byId[op.parent];
		if (!parent) {
			warnings.push("skipped " + op.id + ": parent " + op.parent + " was not created");
			continue;
		}
		try {
			byId[op.id] = await __deckCreate(op, parent, loadFont);
		} catch (e) {
			warnings.push("op-failed " + op.id + ": " + __deckErr(e));
		}
	}

	var replace = cmd.replaceIds || [];
	if (replace.length) {
		await __deckPlace(slide, replace[0], 0);
		for (var k = 0; k < replace.length; k++) {
			var old = replace[k] === slide.id ? null : await figma.getNodeByIdAsync(replace[k]);
			if (old) old.remove();
		}
	} else if (cmd.afterId) {
		await __deckPlace(slide, cmd.afterId, 1);
	}
	return { slideId: slide.id, warnings: warnings };
}

// Start-state copy A goes before the original B; Smart Animate B animates the copy's start state into the real one.
async function __deckMakeEntrance(cmd) {
	var slide = await figma.getNodeByIdAsync(cmd.slideId);
	if (!slide || slide.type !== "SLIDE") throw new Error("Node " + cmd.slideId + " is not a SLIDE");
	var copy = slide.clone();
	try {
		copy.name = slide.name + " · enter";
		await __deckPlace(copy, slide.id, 0);
		var start = cmd.start || {};
		var targets = copy.findAll(function (n) {
			return __deckHas(start, n.getPluginData("importId"));
		});
		for (var i = 0; i < targets.length; i++) {
			var n = targets[i];
			var s = start[n.getPluginData("importId")];
			if (s.opacity !== undefined) n.opacity = s.opacity;
			if (s.scale !== undefined && s.scale !== 1) {
				var cx = n.x + n.width / 2;
				var cy = n.y + n.height / 2;
				n.rescale(Math.max(0.01, s.scale));
				n.x = cx - n.width / 2;
				n.y = cy - n.height / 2;
			}
			if (s.dx) n.x += s.dx;
			if (s.dy) n.y += s.dy;
		}
		copy.setSlideTransition(__DECK_NO_TRANSITION);
		slide.setSlideTransition({
			style: "SMART_ANIMATE",
			duration: Math.max(0.01, cmd.transition.duration),
			curve: cmd.transition.curve,
			timing: { type: "AFTER_DELAY", delay: 0 },
		});
		// A stale copy (the slide was patched since) goes only once its replacement is complete.
		var stale = cmd.replaceId ? await figma.getNodeByIdAsync(cmd.replaceId) : null;
		if (stale && stale.id !== copy.id) stale.remove();
	} catch (e) {
		// All or nothing: a half-built start copy would play as a stray extra slide.
		copy.remove();
		throw e;
	}
	return { enterSlideId: copy.id };
}

// ---- dump / patch ---------------------------------------------------------------------------------

// ax/ay: the node's absolute (slide-relative) position, accumulated from the parents' x/y.
// On-slide bounds of a node whose origin is at ax, ay; a turned node (Figma rotation is counter-clockwise)
// covers the rotated rectangle. ponytail: children of a turned node are still placed unturned.
function __deckBounds(node, ax, ay) {
	var r = ((node.rotation || 0) * Math.PI) / 180;
	if (!r) return { x: ax, y: ay, w: node.width, h: node.height };
	// rounded so 90deg turns come out exact
	var c = Math.round(Math.cos(r) * 1e9) / 1e9;
	var s = Math.round(Math.sin(r) * 1e9) / 1e9;
	var xs = [0, node.width * c, node.height * s, node.width * c + node.height * s];
	var ys = [0, -node.width * s, node.height * c, -node.width * s + node.height * c];
	var x0 = Math.min.apply(null, xs);
	var y0 = Math.min.apply(null, ys);
	return {
		x: ax + x0,
		y: ay + y0,
		w: Math.max.apply(null, xs) - x0,
		h: Math.max.apply(null, ys) - y0,
	};
}

function __deckDump(node, ax, ay) {
	var out = {
		id: node.id,
		importId: node.getPluginData("importId") || null,
		type: node.type,
		name: node.name,
		box: __deckBounds(node, ax, ay),
		visible: node.visible !== false,
		fills: [],
		strokes: Array.isArray(node.strokes) ? node.strokes.length : 0,
		effects: Array.isArray(node.effects) ? node.effects.length : 0,
		clips: !!node.clipsContent,
		children: [],
	};
	if (Array.isArray(node.fills))
		out.fills = node.fills.map(function (f) {
			var paint = { type: f.type, hasImage: f.type === "IMAGE" };
			if (f.type === "SOLID" && f.color)
				paint.color = { r: f.color.r, g: f.color.g, b: f.color.b, a: f.opacity === undefined ? 1 : f.opacity };
			return paint;
		});
	// Numbers for QA's paint checks. A mixed value (figma.mixed is a symbol) falls back to the per-side ones.
	if (out.strokes) {
		var sw = node.strokeWeight;
		if (typeof sw === "number") out.strokeWeights = [sw, sw, sw, sw];
		else if (typeof node.strokeTopWeight === "number")
			out.strokeWeights = [node.strokeTopWeight, node.strokeRightWeight, node.strokeBottomWeight, node.strokeLeftWeight];
	}
	if (typeof node.cornerRadius === "number")
		out.radii = [node.cornerRadius, node.cornerRadius, node.cornerRadius, node.cornerRadius];
	else if (typeof node.topLeftRadius === "number")
		out.radii = [node.topLeftRadius, node.topRightRadius, node.bottomRightRadius, node.bottomLeftRadius];
	if (Array.isArray(node.effects))
		out.effectList = node.effects.map(function (e) {
			return {
				type: e.type,
				x: e.offset ? e.offset.x : 0,
				y: e.offset ? e.offset.y : 0,
				radius: e.radius || 0,
				spread: e.spread || 0,
			};
		});
	if (node.type === "TEXT") {
		var lh = parseFloat(node.getPluginData("lineHeightPx"));
		var fonts = [];
		if (node.characters.length) {
			var names = node.getRangeAllFontNames(0, node.characters.length);
			for (var f = 0; f < names.length; f++) fonts.push(names[f].family + " " + names[f].style);
		}
		out.text = {
			chars: node.characters,
			lineCount: lh > 0 ? Math.round(node.height / lh) : 1,
			fonts: fonts,
		};
	}
	if (node.children)
		for (var i = 0; i < node.children.length; i++) {
			var ch = node.children[i];
			out.children.push(__deckDump(ch, ax + ch.x, ay + ch.y));
		}
	return out;
}

async function __deckNode(id) {
	var node = await figma.getNodeByIdAsync(id);
	if (!node) throw new Error("Node not found: " + id);
	return node;
}

async function __deckImport(cmd) {
	switch (cmd.cmd) {
		case "uploadChunk":
			return __deckUpload(cmd);
		case "buildSlide":
			return await __deckBuildSlide(cmd);
		case "makeEntrance":
			return await __deckMakeEntrance(cmd);
		case "dump":
			return __deckDump(await __deckNode(cmd.slideId), 0, 0);
		case "patch": {
			var warnings = [];
			await __deckApply(await __deckNode(cmd.nodeId), cmd.props || {}, __deckFontLoader(warnings));
			return { ok: true, warnings: warnings };
		}
		default:
			throw new Error("Unknown deck-import command: " + cmd.cmd);
	}
}
`;
