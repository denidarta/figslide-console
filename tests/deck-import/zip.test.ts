import { zipSync, strToU8 } from 'fflate';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { deckDirFor, extractZip, listDecks, workDirFor } from '../../src/core/deck-import/zip.js';

const section = (n: number) => '<section data-label="s"></section>'.repeat(n);
const deck = (n: number) => `<deck-stage>${section(n)}</deck-stage>`;

describe('deck-import zip', () => {
	let dir: string;
	let zipPath: string;

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-zip-'));
		zipPath = path.join(dir, 'Deck.zip');
		fs.writeFileSync(
			zipPath,
			zipSync({
				'A.dc.html': strToU8(deck(2)),
				'B.dc.html': strToU8('<x-import component-from-global-scope="deck-stage"><section></section></x-import>'),
				'sub/C.dc.html': strToU8(deck(3)),
				'assets/x.png': new Uint8Array([1, 2, 3]),
			}),
		);
	});
	afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

	it('workDirFor appends .import to the zip base name', () => {
		expect(workDirFor('C:/a/My Deck.zip').split('\\').join('/')).toMatch(/My Deck\.import$/);
	});

	it('deckDirFor keeps one dir per deck under <workDir>/decks', () => {
		const a = deckDirFor('C:/a/My Deck.zip', 'A.dc.html').split('\\').join('/');
		expect(a).toMatch(/My Deck\.import\/decks\/A$/);
		expect(deckDirFor('C:/a/My Deck.zip', 'B.dc.html')).not.toBe(deckDirFor('C:/a/My Deck.zip', 'A.dc.html'));
	});

	it('extractZip writes files and is idempotent', async () => {
		const src = await extractZip(zipPath);
		expect(src).toBe(path.join(workDirFor(zipPath), 'src'));
		expect(fs.existsSync(path.join(src, 'A.dc.html'))).toBe(true);
		expect(fs.readFileSync(path.join(src, 'assets/x.png'))).toEqual(Buffer.from([1, 2, 3]));

		const f = path.join(src, 'A.dc.html');
		const old = new Date(2000, 0, 1);
		fs.utimesSync(f, old, old);
		await extractZip(zipPath);
		expect(fs.statSync(f).mtimeMs).toBe(old.getTime());
	});

	it('extractZip re-extracts when the zip changes', async () => {
		const src = await extractZip(zipPath);
		fs.writeFileSync(zipPath, zipSync({ 'A.dc.html': strToU8(deck(5)) }));
		const t = new Date(Date.now() + 5000);
		fs.utimesSync(zipPath, t, t);
		await extractZip(zipPath);
		expect(fs.readFileSync(path.join(src, 'A.dc.html'), 'utf8')).toBe(deck(5));
	});

	it('extractZip rejects traversal and absolute entries', async () => {
		fs.writeFileSync(zipPath, zipSync({ '../evil.txt': strToU8('x') }));
		await expect(extractZip(zipPath)).rejects.toThrow(/unsafe/i);
		fs.writeFileSync(zipPath, zipSync({ '/abs.txt': strToU8('x') }));
		await expect(extractZip(zipPath)).rejects.toThrow(/unsafe/i);
	});

	it('listDecks lists root *.dc.html sorted, ignoring subfolders', async () => {
		const src = await extractZip(zipPath);
		expect(await listDecks(src)).toEqual([
			{ file: 'A.dc.html', slideCount: 2 },
			{ file: 'B.dc.html', slideCount: 1 },
		]);
	});
});
