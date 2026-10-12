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

// Loads {family, style}; falls back to the family's Regular, then Inter, and records the substitution.
function __deckFontLoader(warnings) {
	var cache = {};
	return async function (f) {
		var key = f.family + "|" + f.style;
		if (cache[key]) return cache[key];
		var tries = [
			f,
			{ family: f.family, style: "Regular" },
			{ family: "Inter", style: f.style },
			{ family: "Inter", style: "Regular" },
		];
		for (var i = 0; i < tries.length; i++) {
			try {
				await figma.loadFontAsync(tries[i]);
				if (i > 0) warnings.push("font-fallback:" + key + "->" + tries[i].family + " " + tries[i].style);
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
	node.fontName = fonts.length ? fonts[0] : await loadFont({ family: "Inter", style: "Regular" });
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
	node.strokeAlign = "INSIDE";
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
	if (node.type === "TEXT") {
		if (p.w !== undefined) {
			node.textAutoResize = "HEIGHT";
			node.resize(Math.max(p.w, 0.01), node.height);
		}
	} else if (p.w !== undefined || p.h !== undefined) {
		node.resize(
			Math.max(p.w !== undefined ? p.w : node.width, 0.01),
			Math.max(p.h !== undefined ? p.h : node.height, 0.01)
		);
	}
	if (p.x !== undefined) node.x = p.x;
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
		slide.speakerNotes = meta.notes || "";
	} catch (e) {
		warnings.push("slide-meta: " + __deckErr(e));
	}
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
	return { enterSlideId: copy.id };
}

// ---- dump / patch ---------------------------------------------------------------------------------

// ax/ay: the node's absolute (slide-relative) position, accumulated from the parents' x/y.
function __deckDump(node, ax, ay) {
	var out = {
		id: node.id,
		importId: node.getPluginData("importId") || null,
		type: node.type,
		name: node.name,
		box: { x: ax, y: ay, w: node.width, h: node.height },
		visible: node.visible !== false,
		fills: [],
		strokes: Array.isArray(node.strokes) ? node.strokes.length : 0,
		effects: Array.isArray(node.effects) ? node.effects.length : 0,
		clips: !!node.clipsContent,
		children: [],
	};
	if (Array.isArray(node.fills))
		out.fills = node.fills.map(function (f) {
			return { type: f.type, hasImage: f.type === "IMAGE" };
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
