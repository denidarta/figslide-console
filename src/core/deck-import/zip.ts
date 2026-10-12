import { unzipSync } from 'fflate';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

const STAMP = '.zip-mtime';

/** `<zipDir>/<zipBaseName>.import` */
export function workDirFor(zipPath: string): string {
	const { dir, name } = path.parse(zipPath);
	return path.join(dir, `${name}.import`);
}

/**
 * Per-deck artifacts (`state.json`, `ir/`, `shots/`, `report.html`) live in
 * `<workDir>/decks/<deck file without .dc.html>`, so two decks of one zip never share state.
 * `src/` and `cache/` stay per zip. `deckFile` must be a name listDecks returned.
 */
export function deckDirFor(zipPath: string, deckFile: string): string {
	return path.join(
		workDirFor(zipPath),
		'decks',
		path.basename(deckFile).replace(/\.dc\.html$/i, ''),
	);
}

function isUnsafe(entry: string): boolean {
	const p = entry.split('\\').join('/');
	return p.startsWith('/') || /^[A-Za-z]:/.test(p) || p.split('/').includes('..');
}

/** Extracts the zip to `<workDir>/src` and returns that path. Skips if already extracted from the same zip mtime. */
export async function extractZip(zipPath: string): Promise<string> {
	const workDir = workDirFor(zipPath);
	const srcDir = path.join(workDir, 'src');
	const stampPath = path.join(workDir, STAMP);
	const mtime = String((await fs.stat(zipPath)).mtimeMs);

	const stamp = await fs.readFile(stampPath, 'utf8').catch(() => null);
	if (stamp === mtime) return srcDir;

	const entries = unzipSync(new Uint8Array(await fs.readFile(zipPath)));
	for (const name of Object.keys(entries)) {
		if (isUnsafe(name)) throw new Error(`Unsafe path in zip: ${name}`);
	}

	await fs.rm(srcDir, { recursive: true, force: true });
	await fs.mkdir(srcDir, { recursive: true });
	for (const [name, data] of Object.entries(entries)) {
		if (name.endsWith('/')) continue; // directory entry
		const dest = path.join(srcDir, name);
		await fs.mkdir(path.dirname(dest), { recursive: true });
		await fs.writeFile(dest, data);
	}
	await fs.writeFile(stampPath, mtime);
	return srcDir;
}

const DECK_OPEN = /<deck-stage\b|<x-import\b[^>]*component-from-global-scope="deck-stage"/;

/** Counts top-level `<section` children of the deck container (nested sections are not counted). */
function countSlides(html: string): number {
	const open = DECK_OPEN.exec(html);
	if (!open) return 0;
	const rest = html.slice(open.index);
	const end = rest.search(/<\/deck-stage>|<\/x-import>/);
	const body = end < 0 ? rest : rest.slice(0, end);
	let depth = 0;
	let count = 0;
	for (const m of body.matchAll(/<(\/?)section\b/g)) {
		if (m[1]) depth = Math.max(0, depth - 1);
		else if (depth++ === 0) count++;
	}
	return count;
}

/** Every `*.dc.html` at the zip root (not subfolders), sorted by file name. */
export async function listDecks(srcDir: string): Promise<{ file: string; slideCount: number }[]> {
	const files = (await fs.readdir(srcDir, { withFileTypes: true }))
		.filter((e) => e.isFile() && e.name.endsWith('.dc.html'))
		.map((e) => e.name)
		.sort();
	return Promise.all(
		files.map(async (file) => ({ file, slideCount: countSlides(await fs.readFile(path.join(srcDir, file), 'utf8')) })),
	);
}
