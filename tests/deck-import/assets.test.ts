import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	loadImageBytes,
	lucideSvg,
} from "../../src/core/deck-import/assets.js";

const MINI = path.join(__dirname, "..", "fixtures", "deck-import", "mini");
const DOT = fs.readFileSync(path.join(MINI, "assets", "dot.png"));
const sha1 = (b: Uint8Array) => createHash("sha1").update(b).digest("hex");

describe("loadImageBytes", () => {
	let tmp: string;
	let cacheDir: string;

	beforeEach(() => {
		tmp = fs.mkdtempSync(path.join(os.tmpdir(), "deck-assets-"));
		cacheDir = path.join(tmp, "cache");
	});
	afterEach(() => {
		jest.restoreAllMocks();
		fs.rmSync(tmp, { recursive: true, force: true });
	});

	it("loads a srcDir-relative path (with or without ./)", async () => {
		for (const src of ["assets/dot.png", "./assets/dot.png"]) {
			const r = await loadImageBytes(src, MINI, cacheDir);
			expect(Buffer.from(r.bytes).equals(DOT)).toBe(true);
			expect(r.sha1).toBe(sha1(DOT));
			expect(r.mime).toBe("image/png");
		}
	});

	it("rejects paths that escape srcDir", async () => {
		await expect(
			loadImageBytes("../../etc/passwd", MINI, cacheDir),
		).rejects.toThrow(/outside/);
		await expect(
			loadImageBytes("assets/../../x.png", MINI, cacheDir),
		).rejects.toThrow(/outside/);
		await expect(loadImageBytes("/etc/passwd", MINI, cacheDir)).rejects.toThrow(
			/outside/,
		);
		await expect(
			loadImageBytes("C:/Windows/x.png", MINI, cacheDir),
		).rejects.toThrow(/outside/);
		await expect(
			loadImageBytes("\\\\host\\share\\x.png", MINI, cacheDir),
		).rejects.toThrow(/outside/);
	});

	it("decodes base64 and percent-encoded data URIs", async () => {
		const b64 = await loadImageBytes(
			`data:image/png;base64,${DOT.toString("base64")}`,
			MINI,
			cacheDir,
		);
		expect(Buffer.from(b64.bytes).equals(DOT)).toBe(true);
		expect(b64.mime).toBe("image/png");
		expect(b64.sha1).toBe(sha1(DOT));

		const gif = Buffer.from("GIF89a\x01\x00\x01\x00", "latin1");
		const pct = await loadImageBytes(
			`data:image/gif,${[...gif].map((b) => `%${b.toString(16).padStart(2, "0")}`).join("")}`,
			MINI,
			cacheDir,
		);
		expect(Buffer.from(pct.bytes).equals(gif)).toBe(true);
		expect(pct.mime).toBe("image/gif");
	});

	it("detects mime from magic bytes, not the extension", async () => {
		const dir = path.join(tmp, "src");
		fs.mkdirSync(dir);
		fs.writeFileSync(
			path.join(dir, "photo.png"),
			Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]),
		);
		const r = await loadImageBytes("photo.png", dir, cacheDir);
		expect(r.mime).toBe("image/jpeg");
	});

	it("uses a .png sibling for a .webp path", async () => {
		const dir = path.join(tmp, "src");
		fs.mkdirSync(dir);
		fs.writeFileSync(path.join(dir, "x.webp"), "RIFF\0\0\0\0WEBP");
		fs.writeFileSync(path.join(dir, "x.png"), DOT);
		const r = await loadImageBytes("x.webp", dir, cacheDir);
		expect(Buffer.from(r.bytes).equals(DOT)).toBe(true);
		expect(r.mime).toBe("image/png");
	});

	it("throws for a lone .webp", async () => {
		const dir = path.join(tmp, "src");
		fs.mkdirSync(dir);
		fs.writeFileSync(path.join(dir, "y.webp"), "RIFF\0\0\0\0WEBP");
		await expect(loadImageBytes("y.webp", dir, cacheDir)).rejects.toThrow(
			"unsupported image type webp",
		);
	});

	it("throws for webp bytes arriving by data URI", async () => {
		const webp = Buffer.from("RIFF\0\0\0\0WEBP", "latin1").toString("base64");
		await expect(
			loadImageBytes(`data:image/webp;base64,${webp}`, MINI, cacheDir),
		).rejects.toThrow("unsupported image type webp");
	});

	it("fetches a URL once and serves repeats from cacheDir", async () => {
		const url = "https://images.example.com/a.png";
		const fetchMock = jest
			.spyOn(global, "fetch")
			.mockResolvedValue(new Response(new Uint8Array(DOT), { status: 200 }));

		const a = await loadImageBytes(url, MINI, cacheDir);
		const b = await loadImageBytes(url, MINI, cacheDir);

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(Buffer.from(a.bytes).equals(DOT)).toBe(true);
		expect(b.sha1).toBe(sha1(DOT));
		expect(b.mime).toBe("image/png");
		expect(fs.existsSync(path.join(cacheDir, sha1(Buffer.from(url))))).toBe(
			true,
		);
	});

	it("throws with the status on a non-2xx response and caches nothing", async () => {
		const url = "https://images.example.com/missing.png";
		jest
			.spyOn(global, "fetch")
			.mockResolvedValue(new Response("nope", { status: 404 }));
		await expect(loadImageBytes(url, MINI, cacheDir)).rejects.toThrow(/404/);
		expect(fs.existsSync(path.join(cacheDir, sha1(Buffer.from(url))))).toBe(
			false,
		);
	});
});

describe("lucideSvg", () => {
	it("returns the svg markup for icon-<name>", () => {
		const svg = lucideSvg("icon-phone");
		expect(svg?.startsWith("<svg")).toBe(true);
		expect(svg).toContain("<path");
	});

	it("returns null for unknown or unsafe names", () => {
		expect(lucideSvg("icon-nope")).toBeNull();
		expect(lucideSvg("icon-../package")).toBeNull();
		expect(lucideSvg("")).toBeNull();
	});
});
