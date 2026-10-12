import * as fs from "node:fs";
import * as path from "node:path";
import type { ImportState } from "./types.js";

const STATE = "state.json";
const OVER_LIMIT = 10; // percent of flagged slides the spec accepts

/** Resumes <workDir>/state.json; a state written for another target deck is stale, so it starts fresh. */
export function loadState(
	workDir: string,
	zip: string,
	deck: string,
): ImportState {
	try {
		const s = JSON.parse(
			fs.readFileSync(path.join(workDir, STATE), "utf8"),
		) as ImportState;
		if (s.deck === deck) return { ...s, zip };
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
	}
	return { zip, deck, slides: {} };
}

/** Temp file + rename, so a crash mid-write never leaves a truncated state.json. */
export function saveState(workDir: string, s: ImportState): void {
	fs.mkdirSync(workDir, { recursive: true });
	const file = path.join(workDir, STATE);
	const tmp = `${file}.tmp`;
	fs.writeFileSync(tmp, JSON.stringify(s, null, 2));
	fs.renameSync(tmp, file);
}

/** 1-based slide numbers still to do: everything not yet passed or flagged. */
export function pendingSlides(s: ImportState, total: number): number[] {
	const out: number[] = [];
	for (let n = 1; n <= total; n++) {
		const st = s.slides[n]?.status;
		if (st !== "passed" && st !== "flagged") out.push(n);
	}
	return out;
}

const esc = (v: unknown) =>
	String(v)
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");

/** Writes <workDir>/report.html and returns its path. */
export function writeReport(workDir: string, s: ImportState): string {
	const nums = Object.keys(s.slides)
		.map(Number)
		.sort((a, b) => a - b);
	const rows = nums.map((n) => ({ n, ...s.slides[n] }));
	const passed = rows.filter((r) => r.status === "passed").length;
	const flagged = rows.filter((r) => r.status === "flagged").length;
	const pct = rows.length ? Math.round((flagged * 100) / rows.length) : 0;
	const over = flagged * 100 > OVER_LIMIT * rows.length;

	// A flag reads `kind:detail` or just `kind`; the kind is what recurs across slides.
	const kinds = new Map<string, number>();
	for (const r of rows)
		for (const f of r.flags) {
			const k = f.split(/[:\s]/)[0];
			kinds.set(k, (kinds.get(k) ?? 0) + 1);
		}
	const kindRows = [...kinds]
		.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
		.map(([k, c]) => `<tr><td>${esc(k)}</td><td>${c}</td></tr>`)
		.join("");

	const slideRows = rows
		.map(
			(r) => `<section class="${esc(r.status)}">
<h3>Slide ${r.n}: ${esc(r.status)} (rounds: ${esc(r.rounds)})</h3>
${r.reason ? `<p><b>Reason:</b> ${esc(r.reason)}</p>` : ""}${
	r.flags.length
		? `<ul>${r.flags.map((f) => `<li>${esc(f)}</li>`).join("")}</ul>`
		: ""
}
<img src="shots/${r.n}-html.png" alt="HTML slide ${r.n}"> <img src="shots/${r.n}-figma.png" alt="Figma slide ${r.n}">
</section>`,
		)
		.join("\n");

	const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Deck import report</title>
<style>body{font:14px system-ui,sans-serif;margin:24px}img{max-width:48%;border:1px solid #ccc}section{margin:16px 0}.flagged h3{color:#b45309}.over{color:#c00;font-weight:700}</style>
</head><body>
<h1>Deck import report</h1>
<p>${esc(s.zip)} &rarr; ${esc(s.deck)}</p>
<p><b>${passed} passed</b>, <b>${flagged} flagged</b> of ${rows.length}. Flagged: ${pct}%${
		over
			? ` <span class="over" data-over-limit>OVER ${OVER_LIMIT}% LIMIT</span>`
			: ""
	}</p>
${kindRows ? `<table><caption>Issue kinds</caption>${kindRows}</table>` : ""}
${slideRows}
</body></html>
`;
	fs.mkdirSync(workDir, { recursive: true });
	const file = path.join(workDir, "report.html");
	fs.writeFileSync(file, html);
	return file;
}
