import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DeckSession } from "../../src/core/deck-import/capture.js";
import { FigmaDeck } from "../../src/core/deck-import/figma.js";
import { registerDeckImportTools } from "../../src/core/deck-import/tools.js";
import type {
	FigmaDumpNode,
	ImportState,
	RawNode,
} from "../../src/core/deck-import/types.js";
import { workDirFor } from "../../src/core/deck-import/zip.js";

jest.mock("../../src/core/deck-import/capture.js", () => ({
	DeckSession: { open: jest.fn() },
}));
jest.mock("../../src/core/deck-import/figma.js", () => ({
	FigmaDeck: jest.fn(),
}));
jest.mock("../../src/core/deck-import/zip.js", () => ({
	...jest.requireActual("../../src/core/deck-import/zip.js"),
	extractZip: jest.fn(),
	listDecks: jest.fn(),
}));

import { extractZip, listDecks } from "../../src/core/deck-import/zip.js";

const DECK = "Deck.dc.html";
const PNG = Buffer.from("fake-png");

interface RegisteredTool {
	handler: (args: any) => Promise<any>;
	description: string;
}

function createMockServer() {
	const tools: Record<string, RegisteredTool> = {};
	return {
		tool: jest.fn(
			(name: string, description: string, _schema: any, handler: any) => {
				tools[name] = { handler, description };
			},
		),
		tools,
	};
}

/** A bare slide: just the section, so the IR has no nodes and QA passes against an empty dump. */
const rootOnly = (i: number): RawNode[] => [
	{
		id: `s${i}-n0`,
		parentId: null,
		tag: "section",
		box: { x: 0, y: 0, w: 1920, h: 1080 },
		style: { backgroundColor: "rgb(0, 0, 0)" },
	},
];

const dumpOf = (id: string, children: FigmaDumpNode[] = []): FigmaDumpNode => ({
	id,
	importId: null,
	type: "SLIDE",
	name: "Slide",
	box: { x: 0, y: 0, w: 1920, h: 1080 },
	visible: true,
	fills: [],
	strokes: 0,
	effects: 0,
	clips: false,
	children,
});

describe("deck-import tools", () => {
	let tmp: string;
	let zipPath: string;
	let workDir: string;
	let server: ReturnType<typeof createMockServer>;
	let session: any;
	let deck: any;
	let getConnector: jest.Mock;
	let captureNodes: (i: number) => RawNode[];
	let dumpChildren: () => FigmaDumpNode[];

	const call = (name: string, args: object) => server.tools[name].handler(args);
	const json = (res: any) => JSON.parse(res.content[0].text);
	const stateFile = () => path.join(workDir, "state.json");
	const readState = (): ImportState =>
		JSON.parse(fs.readFileSync(stateFile(), "utf8"));
	const writeState = (slides: ImportState["slides"]) => {
		fs.mkdirSync(workDir, { recursive: true });
		fs.writeFileSync(
			stateFile(),
			JSON.stringify({ zip: zipPath, deck: DECK, slides }),
		);
	};
	const slideState = (
		status: "pending" | "imported" | "passed" | "flagged",
		figmaIds: string[] = [],
	) => ({ status, figmaIds, rounds: figmaIds.length ? 1 : 0, flags: [] });

	beforeEach(() => {
		tmp = fs.mkdtempSync(path.join(os.tmpdir(), "deck-tools-"));
		zipPath = path.join(tmp, "deck.zip");
		workDir = workDirFor(zipPath);
		captureNodes = (i) => rootOnly(i);
		dumpChildren = () => [];

		session = {
			slideCount: () => 3,
			slideMeta: jest.fn(async (i: number) => ({
				name: `Slide ${i + 1}`,
				skipped: false,
				notes: "",
			})),
			capture: jest.fn(async (i: number) => ({
				nodes: captureNodes(i),
				anims: [],
			})),
			screenshot: jest.fn(async (_i: number, out: string) => {
				fs.writeFileSync(out, PNG);
			}),
			close: jest.fn(async () => {}),
			page: { evaluate: jest.fn() },
		};
		deck = {
			uploadImage: jest.fn(async () => "hash1"),
			buildSlide: jest.fn(async (slide: { index: number }) => ({
				slideId: `9:${slide.index + 1}`,
				warnings: [],
			})),
			dump: jest.fn(async (id: string) => dumpOf(id, dumpChildren())),
			screenshot: jest.fn(async (_id: string, out: string) => {
				fs.mkdirSync(path.dirname(out), { recursive: true });
				fs.writeFileSync(out, PNG);
			}),
			patch: jest.fn(async () => ({ warnings: [] })),
		};
		(DeckSession.open as jest.Mock).mockReset().mockResolvedValue(session);
		(FigmaDeck as unknown as jest.Mock)
			.mockReset()
			.mockImplementation(() => deck);
		(extractZip as jest.Mock)
			.mockReset()
			.mockImplementation(async (z: string) => path.join(workDirFor(z), "src"));
		(listDecks as jest.Mock)
			.mockReset()
			.mockResolvedValue([{ file: DECK, slideCount: 3 }]);

		server = createMockServer();
		getConnector = jest.fn().mockResolvedValue({ fake: "connector" });
		registerDeckImportTools(server as any, getConnector);
	});

	afterEach(() => {
		fs.rmSync(tmp, { recursive: true, force: true });
	});

	it("registers the five tools, each describing the loop and banning rasterizing", () => {
		const names = server.tool.mock.calls.map((c: any[]) => c[0]).sort();
		expect(names).toEqual(
			[
				"deck_import",
				"deck_list",
				"deck_mark",
				"deck_patch",
				"deck_report",
				"deck_slide_view",
			].sort(),
		);
		for (const t of Object.values(server.tools)) {
			expect(t.description).toMatch(/deck_import/);
			expect(t.description).toMatch(/3 rounds/);
			expect(t.description).toMatch(/never.*rasteriz/i);
		}
	});

	describe("deck_list", () => {
		it("returns the work dir and the decks", async () => {
			const out = json(await call("deck_list", { zipPath }));
			expect(out).toEqual({
				workDir,
				decks: [{ file: DECK, slideCount: 3 }],
			});
		});
	});

	describe("deck_import", () => {
		it("seeds every slide and imports all of them on a first run", async () => {
			const res = await call("deck_import", { zipPath, deck: DECK });
			const out = json(res);
			expect(res.isError).toBeUndefined();
			expect(out.slides.map((s: any) => s.n)).toEqual([1, 2, 3]);
			expect(out.slides[0]).toMatchObject({
				n: 1,
				status: "passed",
				figmaIds: ["9:1"],
				issues: [],
			});
			expect(readState().slides[3]).toMatchObject({
				status: "passed",
				rounds: 1,
			});
			expect(fs.existsSync(path.join(workDir, "shots", "1-html.png"))).toBe(
				true,
			);
			expect(fs.existsSync(path.join(workDir, "shots", "1-figma.png"))).toBe(
				true,
			);
		});

		it("with slide 1 passed and slides omitted, processes only slides 2..N", async () => {
			writeState({ 1: slideState("passed", ["5:1"]) });
			const out = json(await call("deck_import", { zipPath, deck: DECK }));

			expect(out.slides.map((s: any) => s.n)).toEqual([2, 3]);
			expect(session.capture.mock.calls.map((c: any[]) => c[0])).toEqual([
				1, 2,
			]); // 0-based
			expect(deck.buildSlide).toHaveBeenCalledTimes(2);
			const st = readState();
			expect(st.slides[1]).toMatchObject({
				status: "passed",
				figmaIds: ["5:1"],
			});
			expect(st.slides[2]).toMatchObject({
				status: "passed",
				figmaIds: ["9:2"],
			});
		});

		it('with slides: "1" re-processes slide 1 and passes its stored figmaIds as replaceIds', async () => {
			writeState({ 1: slideState("passed", ["5:1", "5:2"]) });
			const out = json(
				await call("deck_import", { zipPath, deck: DECK, slides: "1" }),
			);

			expect(out.slides.map((s: any) => s.n)).toEqual([1]);
			expect(deck.buildSlide).toHaveBeenCalledTimes(1);
			expect(deck.buildSlide.mock.calls[0][2]).toEqual(["5:1", "5:2"]);
			expect(readState().slides[1]).toMatchObject({
				status: "passed",
				figmaIds: ["9:1"],
				rounds: 2,
			});
		});

		it("force re-processes passed slides, but leaves first-time slides without replaceIds", async () => {
			writeState({ 1: slideState("passed", ["5:1"]) });
			await call("deck_import", { zipPath, deck: DECK, force: true });
			expect(deck.buildSlide).toHaveBeenCalledTimes(3);
			expect(deck.buildSlide.mock.calls[0][2]).toEqual(["5:1"]);
			expect(deck.buildSlide.mock.calls[1][2]).toBeUndefined();
		});

		it("accepts ranges and lists, 1-based", async () => {
			await call("deck_import", { zipPath, deck: DECK, slides: "2-3" });
			expect(session.capture.mock.calls.map((c: any[]) => c[0])).toEqual([
				1, 2,
			]);
		});

		it("status is imported with issues listed (max 10) when QA fails", async () => {
			captureNodes = (i) => [
				...rootOnly(i),
				{
					id: `s${i}-n1`,
					parentId: `s${i}-n0`,
					tag: "div",
					box: { x: 10, y: 20, w: 100, h: 50 },
					style: { backgroundColor: "rgb(255, 0, 0)" },
				},
			];
			const out = json(
				await call("deck_import", { zipPath, deck: DECK, slides: "1" }),
			);
			expect(out.slides[0].status).toBe("imported");
			expect(out.slides[0].issues[0]).toMatchObject({
				kind: "missing",
				importId: "s0-n1",
			});
			expect(readState().slides[1].status).toBe("imported");
		});

		it("returns isError with a Desktop Bridge hint when the connector fails", async () => {
			getConnector.mockRejectedValue(new Error("No Figma Desktop connection"));
			const res = await call("deck_import", { zipPath, deck: DECK });
			expect(res.isError).toBe(true);
			const out = json(res);
			expect(out.error).toContain("No Figma Desktop connection");
			expect(out.hint).toMatch(/Desktop Bridge/);
			expect(DeckSession.open).not.toHaveBeenCalled();
		});

		it("returns a DECK_IMPORT_CHROME_PATH hint when Chrome cannot launch", async () => {
			(DeckSession.open as jest.Mock).mockRejectedValue(
				new Error("Could not find Chrome"),
			);
			const res = await call("deck_import", { zipPath, deck: DECK });
			expect(res.isError).toBe(true);
			expect(json(res).hint).toMatch(/DECK_IMPORT_CHROME_PATH/);
		});

		it("closes the session and keeps finished slides when a later slide fails", async () => {
			deck.buildSlide
				.mockResolvedValueOnce({ slideId: "9:1", warnings: [] })
				.mockRejectedValueOnce(new Error("Plugin timed out"));
			const res = await call("deck_import", { zipPath, deck: DECK });
			expect(res.isError).toBe(true);
			const out = json(res);
			expect(out.error).toContain("Plugin timed out");
			expect(out.hint).toMatch(/Desktop Bridge/);
			expect(out.slides.map((s: any) => s.n)).toEqual([1]);
			expect(out.failedSlide).toBe(2);
			expect(session.close).toHaveBeenCalledTimes(1);
			expect(readState().slides[1].status).toBe("passed");
		});

		it("rejects an unknown deck and a slide outside the deck without opening Chrome", async () => {
			const unknown = await call("deck_import", {
				zipPath,
				deck: "Nope.dc.html",
			});
			expect(unknown.isError).toBe(true);
			expect(json(unknown).error).toContain(DECK);
			const range = await call("deck_import", {
				zipPath,
				deck: DECK,
				slides: "9",
			});
			expect(range.isError).toBe(true);
			expect(DeckSession.open).not.toHaveBeenCalled();
		});
	});

	describe("deck_mark", () => {
		it("persists a flagged verdict with its reason", async () => {
			writeState({ 1: slideState("imported", ["5:1"]) });
			const res = await call("deck_mark", {
				zipPath,
				deck: DECK,
				slide: 1,
				status: "flagged",
				reason: "gradient text",
			});
			expect(json(res)).toMatchObject({ slide: 1, status: "flagged" });
			expect(readState().slides[1]).toMatchObject({
				status: "flagged",
				reason: "gradient text",
				figmaIds: ["5:1"],
			});
		});

		it("passed drops a stale reason", async () => {
			writeState({
				1: { ...slideState("flagged", ["5:1"]), reason: "old" },
			});
			await call("deck_mark", {
				zipPath,
				deck: DECK,
				slide: 1,
				status: "passed",
			});
			const s = readState().slides[1];
			expect(s.status).toBe("passed");
			expect(s.reason).toBeUndefined();
		});
	});

	describe("deck_report", () => {
		it("writes report.html and returns counts", async () => {
			writeState({
				1: slideState("passed", ["5:1"]),
				2: { ...slideState("flagged", ["5:2"]), reason: "x" },
				3: slideState("imported", ["5:3"]),
			});
			const out = json(await call("deck_report", { zipPath, deck: DECK }));
			expect(out.path).toBe(path.join(workDir, "report.html"));
			expect(fs.existsSync(out.path)).toBe(true);
			expect(out).toMatchObject({
				total: 3,
				passed: 1,
				flagged: 1,
				pending: 1,
			});
		});
	});

	describe("review loop on an imported slide", () => {
		beforeEach(() => {
			captureNodes = (i) => [
				...rootOnly(i),
				{
					id: `s${i}-n1`,
					parentId: `s${i}-n0`,
					tag: "div",
					box: { x: 10, y: 20, w: 100, h: 50 },
					style: { backgroundColor: "rgb(255, 0, 0)" },
				},
			];
			let x = 14; // imported 4px off
			dumpChildren = () => [
				{
					...dumpOf("7:2"),
					type: "FRAME",
					importId: "s0-n1",
					name: "Frame #s0-n1",
					box: { x, y: 20, w: 100, h: 50 },
					fills: [{ type: "SOLID", hasImage: false }],
				},
			];
			deck.patch.mockImplementation(
				async (_id: string, props: { x?: number }) => {
					if (props.x !== undefined) x = props.x;
					return { warnings: [] };
				},
			);
		});

		it("deck_slide_view returns both screenshots plus QA and an id map", async () => {
			await call("deck_import", { zipPath, deck: DECK, slides: "1" });
			session.screenshot.mockClear();

			const res = await call("deck_slide_view", {
				zipPath,
				deck: DECK,
				slide: 1,
			});
			const images = res.content.filter((c: any) => c.type === "image");
			expect(images).toHaveLength(2);
			expect(images[0]).toMatchObject({
				mimeType: "image/png",
				data: PNG.toString("base64"),
			});
			const info = JSON.parse(
				res.content.find((c: any) => c.type === "text").text,
			);
			expect(info.qa.pass).toBe(false);
			expect(info.qa.issues[0]).toMatchObject({
				kind: "box",
				importId: "s0-n1",
			});
			expect(info.nodes).toContainEqual(
				expect.objectContaining({
					id: "s0-n1",
					kind: "frame",
					box: [10, 20, 100, 50],
				}),
			);
			// the HTML shot taken at import is reused, so no browser is launched
			expect(session.screenshot).not.toHaveBeenCalled();
		});

		it("deck_patch patches the node found by importId, re-checks and passes the slide", async () => {
			const first = json(
				await call("deck_import", { zipPath, deck: DECK, slides: "1" }),
			);
			expect(first.slides[0].status).toBe("imported");

			const res = await call("deck_patch", {
				zipPath,
				deck: DECK,
				slide: 1,
				importId: "s0-n1",
				props: { x: 10 },
			});
			expect(deck.patch).toHaveBeenCalledWith("7:2", { x: 10 });
			expect(json(res)).toMatchObject({
				pass: true,
				issues: [],
				status: "passed",
			});
			const s = readState().slides[1];
			expect(s.status).toBe("passed");
			expect(s.rounds).toBe(2);
			expect(s.flags).toContain("fixed:box");
		});

		it("deck_patch reports an unknown importId", async () => {
			await call("deck_import", { zipPath, deck: DECK, slides: "1" });
			const res = await call("deck_patch", {
				zipPath,
				deck: DECK,
				slide: 1,
				importId: "s0-n99",
				props: { x: 1 },
			});
			expect(res.isError).toBe(true);
			expect(json(res).error).toContain("s0-n99");
			expect(deck.patch).not.toHaveBeenCalled();
		});

		it("deck_patch on a slide that was never imported says so", async () => {
			const res = await call("deck_patch", {
				zipPath,
				deck: DECK,
				slide: 2,
				importId: "s1-n1",
				props: {},
			});
			expect(res.isError).toBe(true);
			expect(json(res).hint).toMatch(/deck_import/);
		});
	});
});
