import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	loadState,
	pendingSlides,
	saveState,
	writeReport,
} from "../../src/core/deck-import/state.js";
import type { ImportState } from "../../src/core/deck-import/types.js";

let dir: string;
beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "deck-state-"));
});
afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

const entry = (
	status: ImportState["slides"][number]["status"],
	over: Partial<ImportState["slides"][number]> = {},
) => ({ status, figmaIds: [], rounds: 0, flags: [], ...over });

describe("state", () => {
	it("loadState starts empty when there is no state.json", () => {
		expect(loadState(dir, "a.zip", "deck1")).toEqual({
			zip: "a.zip",
			deck: "deck1",
			slides: {},
		});
	});

	it("saveState then loadState round-trips, leaving no temp file behind", () => {
		const s: ImportState = {
			zip: "a.zip",
			deck: "deck1",
			slides: {
				1: entry("passed", { figmaIds: ["1:2"], rounds: 1 }),
				2: entry("flagged", { flags: ["box:s1-n3"], reason: "wraps" }),
			},
		};
		saveState(dir, s);
		saveState(dir, s); // overwrite goes through the same rename
		expect(loadState(dir, "a.zip", "deck1")).toEqual(s);
		expect(fs.readdirSync(dir)).toEqual(["state.json"]);
	});

	it("loadState ignores a state written for another deck", () => {
		saveState(dir, {
			zip: "a.zip",
			deck: "old",
			slides: { 1: entry("passed") },
		});
		expect(loadState(dir, "a.zip", "new").slides).toEqual({});
	});

	it("saveState creates the work dir", () => {
		const nested = path.join(dir, "x.import");
		saveState(nested, { zip: "z", deck: "d", slides: {} });
		expect(fs.existsSync(path.join(nested, "state.json"))).toBe(true);
	});

	it("pendingSlides: what resume reads (1-based, passed is skipped)", () => {
		const s: ImportState = {
			zip: "z",
			deck: "d",
			slides: { 1: entry("passed"), 2: entry("imported") },
		};
		expect(pendingSlides(s, 5)).toEqual([2, 3, 4, 5]);
		s.slides[3] = entry("flagged");
		s.slides[4] = entry("pending");
		expect(pendingSlides(s, 5)).toEqual([2, 4, 5]);
		expect(pendingSlides({ zip: "z", deck: "d", slides: {} }, 3)).toEqual([
			1, 2, 3,
		]);
		expect(pendingSlides(s, 0)).toEqual([]);
	});
});

describe("writeReport", () => {
	const deck = (flagged: number[], total = 10): ImportState => {
		const slides: ImportState["slides"] = {};
		for (let n = 1; n <= total; n++)
			slides[n] = flagged.includes(n)
				? entry("flagged", { rounds: 3, flags: ["box:s1-n1 off by 9px"] })
				: entry("passed", { rounds: 1 });
		return { zip: "a.zip", deck: "d", slides };
	};

	it("10 slides with 2 flagged: 20% and the over-limit marker", () => {
		const file = writeReport(dir, deck([3, 7]));
		expect(file).toBe(path.join(dir, "report.html"));
		const html = fs.readFileSync(file, "utf8");
		expect(html).toContain("20%");
		expect(html).toContain("data-over-limit");
		expect(html).toContain("8 passed");
		expect(html).toContain("2 flagged");
	});

	it("exactly 10% flagged has no marker", () => {
		const html = fs.readFileSync(writeReport(dir, deck([4])), "utf8");
		expect(html).toContain("10%");
		expect(html).not.toContain("data-over-limit");
		expect(fs.readFileSync(writeReport(dir, deck([])), "utf8")).toContain("0%");
	});

	it("lists each slide with status, rounds, flags, reason and both screenshots", () => {
		const s = deck([2], 3);
		s.slides[2].reason = "font missing";
		const html = fs.readFileSync(writeReport(dir, s), "utf8");
		for (const n of [1, 2, 3]) {
			expect(html).toContain(`src="shots/${n}-html.png"`);
			expect(html).toContain(`src="shots/${n}-figma.png"`);
		}
		expect(html).toContain("font missing");
		expect(html).toContain("box:s1-n1 off by 9px");
		expect(html).toContain("flagged");
	});

	it("counts flag kinds across the run", () => {
		const s = deck([], 3);
		s.slides[1].flags = ["box:s1-n1 off", "box:s1-n2 off", "font:Geist"];
		s.slides[3].flags = ["box:s3-n1 off", "icon-missing"];
		const html = fs.readFileSync(writeReport(dir, s), "utf8");
		expect(html).toMatch(/box<\/td>\s*<td[^>]*>3</);
		expect(html).toMatch(/font<\/td>\s*<td[^>]*>1</);
		expect(html).toMatch(/icon-missing<\/td>\s*<td[^>]*>1</);
	});

	it("escapes every text value", () => {
		const s = deck([1], 2);
		s.zip = "<b>z</b>.zip";
		s.slides[1].flags = ["box:<script>alert(1)</script>"];
		s.slides[1].reason = '"><img src=x onerror=alert(2)>';
		const html = fs.readFileSync(writeReport(dir, s), "utf8");
		expect(html).not.toContain("<script>");
		expect(html).not.toContain("<b>z</b>");
		expect(html).not.toContain("onerror=alert(2)>");
		expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
		expect(html).toContain("&lt;b&gt;z&lt;/b&gt;.zip");
	});
});
