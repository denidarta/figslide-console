import * as fs from "node:fs";
import * as path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createChildLogger } from "../logger.js";
import { DeckSession } from "./capture.js";
import { FigmaDeck } from "./figma.js";
import {
	findByImportId,
	fixedFlags,
	importSlide,
	irSummary,
	recheck,
} from "./pipeline.js";
import { loadState, pendingSlides, saveState, writeReport } from "./state.js";
import type { ImportState } from "./types.js";
import { extractZip, listDecks, workDirFor } from "./zip.js";

const logger = createChildLogger({ component: "deck-import-tools" });

const MAX_ISSUES = 10;
const ROUND_LIMIT = 3;
const OVER_LIMIT_PERCENT = 10;

const BRIDGE_HINT =
	"Make sure the Figma Desktop Bridge plugin is running in the open Figma Slides file, then retry.";
const CHROME_HINT =
	"Headless Chrome failed to start. Install Google Chrome, or set DECK_IMPORT_CHROME_PATH to a Chrome executable.";
const ZIP_HINT =
	"Check zipPath (absolute path to the design-artifact .zip) and that deck is a file name returned by deck_list.";
const IMPORT_FIRST_HINT =
	"Run deck_import for this slide first (slide numbers are 1-based).";

const LOOP = `Loop: deck_list -> deck_import -> deck_slide_view -> deck_patch (or re-run deck_import with slides) for at most ${ROUND_LIMIT} rounds per slide -> deck_mark passed or flagged -> deck_report. QA only checks numbers, so look at the two screenshots from deck_slide_view yourself. Never rasterize as a fix: do not replace text, shapes or icons with images; patch the native layers or flag the slide. Needs the Figma Desktop Bridge plugin running in a Slides file, Chrome (or DECK_IMPORT_CHROME_PATH) and network access.`;

const ok = (body: unknown) => ({
	content: [{ type: "text" as const, text: JSON.stringify(body) }],
});

const fail = (error: unknown, hint: string, extra: object = {}) => ({
	content: [
		{
			type: "text" as const,
			text: JSON.stringify({
				error: error instanceof Error ? error.message : String(error),
				hint,
				...extra,
			}),
		},
	],
	isError: true as const,
});

const blank = (): ImportState["slides"][number] => ({
	status: "pending",
	figmaIds: [],
	rounds: 0,
	flags: [],
});

const dedupe = (flags: string[]) => [...new Set(flags)];

/** `"7"`, `"1-10"` or a comma list of those; 1-based. */
function parseSlides(spec: string, total: number): number[] {
	const out = new Set<number>();
	for (const part of spec.split(",")) {
		const m = /^\s*(\d+)\s*(?:-\s*(\d+))?\s*$/.exec(part);
		if (!m)
			throw new Error(`Bad slides "${spec}": use "7", "1-10" or "1,3,5-7"`);
		const from = Number(m[1]);
		const to = m[2] ? Number(m[2]) : from;
		if (from < 1 || to < from || to > total)
			throw new Error(`Slides "${part.trim()}" is outside 1-${total}`);
		for (let n = from; n <= to; n++) out.add(n);
	}
	return [...out].sort((a, b) => a - b);
}

/** The slide that holds the final content: figmaIds is `[enterSlideId?, slideId]`. */
const slideIdOf = (s: ImportState["slides"][number] | undefined) =>
	s?.figmaIds[s.figmaIds.length - 1];

export function registerDeckImportTools(
	server: McpServer,
	getDesktopConnector: () => Promise<any>,
): void {
	const zipPath = z
		.string()
		.describe("Absolute path to the design-artifact .zip");
	const deck = z
		.string()
		.describe('Deck file name from deck_list, e.g. "Deck.dc.html"');
	const slide = z.number().int().min(1).describe("1-based slide number");

	server.tool(
		"deck_list",
		`List the decks (*.dc.html) in a Claude design-artifact zip with their slide counts. Extracts the zip into <zip dir>/<zip name>.import/src and returns that work dir. ${LOOP}`,
		{ zipPath },
		async ({ zipPath }) => {
			try {
				const decks = await listDecks(await extractZip(zipPath));
				return ok({ workDir: workDirFor(zipPath), decks });
			} catch (error) {
				logger.error({ error }, "deck_list failed");
				return fail(error, ZIP_HINT);
			}
		},
	);

	server.tool(
		"deck_import",
		`Import slides of a deck into the open Figma Slides file as native layers (text stays text; only bitmap images and looping regions become images). Per slide: capture the HTML in headless Chrome, build the layers, screenshot both sides into <work dir>/shots, and run QA. Returns per slide { n, status passed|imported, figmaIds, issues (max ${MAX_ISSUES}), flags }. With slides omitted it does every slide not yet passed or flagged (resumable); force re-does all; slides ("7" or "1-10", 1-based) always re-does the named slides, replacing their earlier import. ${LOOP}`,
		{
			zipPath,
			deck,
			slides: z
				.string()
				.optional()
				.describe(
					'Slides to (re)import: "7", "1-10" or "1,3,5-7". Default: all not yet passed or flagged',
				),
			force: z
				.boolean()
				.optional()
				.describe("Re-import every slide, including passed ones"),
		},
		async ({ zipPath, deck: deckFile, slides, force }) => {
			let hint = ZIP_HINT;
			let session: DeckSession | undefined;
			let current: number | undefined;
			const results: object[] = [];
			try {
				const srcDir = await extractZip(zipPath);
				const decks = await listDecks(srcDir);
				const found = decks.find((d) => d.file === deckFile);
				if (!found)
					throw new Error(
						`No deck "${deckFile}" in the zip. Decks: ${decks.map((d) => d.file).join(", ") || "none"}`,
					);
				const total = found.slideCount;
				const workDir = workDirFor(zipPath);
				const state = loadState(workDir, zipPath, deckFile);
				// Every slide is known from the start, so the report's flagged % uses the deck size.
				for (let n = 1; n <= total; n++) state.slides[n] ??= blank();
				const todo = slides
					? parseSlides(slides, total)
					: force
						? Array.from({ length: total }, (_, i) => i + 1)
						: pendingSlides(state, total);
				saveState(workDir, state);
				if (!todo.length)
					return ok({
						workDir,
						slides: [],
						note: "Every slide is already passed or flagged. Use slides or force to redo some.",
					});

				hint = BRIDGE_HINT;
				const figma = new FigmaDeck(await getDesktopConnector());
				hint = CHROME_HINT;
				session = await DeckSession.open(srcDir, deckFile);
				hint = BRIDGE_HINT;

				for (const n of todo) {
					current = n;
					const entry = state.slides[n];
					const out = await importSlide(
						{
							session,
							figma,
							srcDir,
							workDir,
							// Record the new ids at once: a failure after the build must not orphan the slide.
							onBuilt: (ids) => {
								entry.figmaIds = ids;
								entry.status = "imported";
								saveState(workDir, state);
							},
						},
						n,
						entry.figmaIds.length ? entry.figmaIds : undefined,
					);
					entry.figmaIds = out.figmaIds;
					entry.rounds += 1;
					entry.status = out.qa.pass ? "passed" : "imported";
					entry.reason = undefined;
					entry.flags = dedupe([
						...entry.flags.filter((f) => f.startsWith("fixed:")),
						...out.flags,
					]);
					saveState(workDir, state);
					results.push({
						n,
						status: entry.status,
						figmaIds: entry.figmaIds,
						issueCount: out.qa.issues.length,
						issues: out.qa.issues.slice(0, MAX_ISSUES),
						flags: entry.flags,
					});
				}
				return ok({ workDir, slides: results });
			} catch (error) {
				logger.error({ error }, "deck_import failed");
				return fail(error, hint, {
					...(results.length ? { slides: results } : {}),
					...(current ? { failedSlide: current } : {}),
				});
			} finally {
				await session?.close().catch(() => {});
			}
		},
	);

	server.tool(
		"deck_slide_view",
		`Look at one imported slide: returns two PNGs (1: the HTML render, the reference, 1920x1080; 2: the Figma import, at most 1568px wide) and a JSON text with the current QA result and every import node as { id, kind, parent, box [x,y,w,h] in 1920x1080 slide px } so a region you see maps to an importId for deck_patch. ${LOOP}`,
		{ zipPath, deck, slide },
		async ({ zipPath, deck: deckFile, slide }) => {
			let hint = BRIDGE_HINT;
			try {
				const workDir = workDirFor(zipPath);
				const state = loadState(workDir, zipPath, deckFile);
				const entry = state.slides[slide];
				const slideId = slideIdOf(entry);
				if (!slideId)
					return fail(
						`Slide ${slide} has not been imported`,
						IMPORT_FIRST_HINT,
					);

				const figma = new FigmaDeck(await getDesktopConnector());
				const shots = path.join(workDir, "shots");
				const htmlPath = path.join(shots, `${slide}-html.png`);
				const figmaPath = path.join(shots, `${slide}-figma.png`);
				// The HTML side never changes after import, so reuse its shot and skip launching Chrome.
				if (!fs.existsSync(htmlPath)) {
					hint = CHROME_HINT;
					const session = await DeckSession.open(
						await extractZip(zipPath),
						deckFile,
					);
					try {
						fs.mkdirSync(shots, { recursive: true });
						await session.screenshot(slide - 1, htmlPath);
					} finally {
						await session.close().catch(() => {});
					}
					hint = BRIDGE_HINT;
				}
				await figma.screenshot(slideId, figmaPath);
				const { built, qa } = await recheck(figma, workDir, slide, slideId);

				const image = (file: string) => ({
					type: "image" as const,
					data: fs.readFileSync(file).toString("base64"),
					mimeType: "image/png",
				});
				return {
					content: [
						image(htmlPath),
						image(figmaPath),
						{
							type: "text" as const,
							text: JSON.stringify({
								slide,
								status: entry.status,
								rounds: entry.rounds,
								flags: entry.flags,
								reason: entry.reason,
								qa,
								nodes: irSummary(built.ir),
							}),
						},
					],
				};
			} catch (error) {
				logger.error({ error }, "deck_slide_view failed");
				return fail(error, hint);
			}
		},
	);

	server.tool(
		"deck_patch",
		`Fix one node of an imported slide in place, without re-importing. importId is the id from deck_slide_view or an issue (the Figma node is found by it). props are Figma-API-form values, all optional: x, y (relative to the node's parent frame, not the slide), w, h, opacity, fills (Figma Paint[]), strokes { paints, weights [t,r,b,l], dashed }, radii [tl,tr,br,bl], effects, clip, text, runs, align. Re-dumps and re-checks the slide, counts one round, marks it passed when clean, and returns the new QA result. ${LOOP}`,
		{
			zipPath,
			deck,
			slide,
			importId: z.string().describe("Import id of the node, e.g. s3-n42"),
			props: z
				.record(z.string(), z.unknown())
				.describe("Properties to set, in Figma API form"),
		},
		async ({ zipPath, deck: deckFile, slide, importId, props }) => {
			try {
				const workDir = workDirFor(zipPath);
				const state = loadState(workDir, zipPath, deckFile);
				const entry = state.slides[slide];
				const slideId = slideIdOf(entry);
				if (!slideId)
					return fail(
						`Slide ${slide} has not been imported`,
						IMPORT_FIRST_HINT,
					);

				const figma = new FigmaDeck(await getDesktopConnector());
				const { dump, qa: before } = await recheck(
					figma,
					workDir,
					slide,
					slideId,
				);
				const target = findByImportId(dump, importId);
				if (!target)
					return fail(
						`No node with importId ${importId} in slide ${slide}`,
						"Use ids from deck_slide_view's nodes list. A dropped node (image-unsupported, missing-icon) has none.",
					);
				const { warnings } = await figma.patch(target.id, props);
				const { qa } = await recheck(figma, workDir, slide, slideId);

				entry.rounds += 1;
				entry.status = qa.pass
					? "passed"
					: entry.status === "flagged"
						? "flagged"
						: "imported";
				if (qa.pass) entry.reason = undefined;
				entry.flags = dedupe([
					...entry.flags,
					...warnings,
					...fixedFlags(before, qa),
				]);
				saveState(workDir, state);
				// Keep the report's Figma shot current; the patch itself already succeeded.
				await figma
					.screenshot(
						slideId,
						path.join(workDir, "shots", `${slide}-figma.png`),
					)
					.catch(() => {});
				return ok({
					...qa,
					status: entry.status,
					rounds: entry.rounds,
					warnings,
					...(entry.rounds >= ROUND_LIMIT && !qa.pass
						? {
								note: `${ROUND_LIMIT} rounds used: deck_mark this slide flagged (with a reason) or passed.`,
							}
						: {}),
				});
			} catch (error) {
				logger.error({ error }, "deck_patch failed");
				return fail(error, BRIDGE_HINT);
			}
		},
	);

	server.tool(
		"deck_mark",
		`Record your visual verdict for a slide after comparing the screenshots: passed, or flagged with a reason (what differs and why it was not fixed). Flagged slides are kept out of later default deck_import runs and listed in the report. ${LOOP}`,
		{
			zipPath,
			deck,
			slide,
			status: z.enum(["passed", "flagged"]),
			reason: z.string().optional().describe("Why the slide is flagged"),
		},
		async ({ zipPath, deck: deckFile, slide, status, reason }) => {
			try {
				const workDir = workDirFor(zipPath);
				const state = loadState(workDir, zipPath, deckFile);
				const entry = state.slides[slide] ?? blank();
				state.slides[slide] = entry;
				entry.status = status;
				entry.reason = reason || undefined;
				saveState(workDir, state);
				return ok({ slide, status, reason: entry.reason });
			} catch (error) {
				logger.error({ error }, "deck_mark failed");
				return fail(error, ZIP_HINT);
			}
		},
	);

	server.tool(
		"deck_report",
		`Write <work dir>/report.html (counts, flagged slides with reasons, recurring flag kinds, both screenshots per slide) and return its path with the counts. The import is accepted when at most ${OVER_LIMIT_PERCENT}% of slides are flagged. ${LOOP}`,
		{ zipPath, deck },
		async ({ zipPath, deck: deckFile }) => {
			try {
				const workDir = workDirFor(zipPath);
				const state = loadState(workDir, zipPath, deckFile);
				const rows = Object.values(state.slides);
				if (!rows.length)
					return fail("Nothing has been imported yet", IMPORT_FIRST_HINT);
				const count = (s: string) => rows.filter((r) => r.status === s).length;
				const flagged = count("flagged");
				return ok({
					path: writeReport(workDir, state),
					total: rows.length,
					passed: count("passed"),
					flagged,
					pending: rows.length - count("passed") - flagged,
					flaggedPercent: Math.round((flagged * 100) / rows.length),
					overLimit: flagged * 100 > OVER_LIMIT_PERCENT * rows.length,
				});
			} catch (error) {
				logger.error({ error }, "deck_report failed");
				return fail(error, ZIP_HINT);
			}
		},
	);
}
