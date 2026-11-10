import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('obsidian', () => {
	class Base {}
	return {
		Plugin: Base, Modal: Base, FileView: Base, PluginSettingTab: Base, Setting: Base,
		Scope: Base, TFile: Base, Notice: vi.fn(), Platform: {}, setIcon: vi.fn(), setTooltip: vi.fn(),
	};
});
vi.mock('../src/pdf-highlights', () => ({
	collectHighlights: vi.fn(async () => [{
		pageNumber: 1, top: 100, colorCss: 'rgb(255, 255, 0)',
		quote: 'Original quotation', note: 'Updated question', annotationId: '12R',
	}]),
}));
vi.mock('../src/obsidian-pdf-internals', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../src/obsidian-pdf-internals')>();
	return {
		...actual,
		createPdfJsDocumentSnapshot: vi.fn(() => ({
			document: Promise.resolve({}), cancel: vi.fn(), dispose: vi.fn(async () => {}),
		})),
	};
});

import { TFile, Notice } from 'obsidian';
import StudyPdf from '../src/main';
import { makeFixturePdfBytes } from './helpers/pdf-fixture';
import { buildFlashcardBlocks, mergeFlashcardNote } from '../src/flashcards';

async function setup(existingText: string | null) {
	const plugin = new StudyPdf() as any;
	const bytes = await makeFixturePdfBytes();
	const existingFile = existingText === null ? null : new TFile();
	let stored = existingText;
	const process = vi.fn(async (_file, merge: (latest: string) => string) => {
		stored = merge(stored!);
		return stored;
	});
	const create = vi.fn(async (_path, content: string) => { stored = content; return new TFile(); });
	const read = vi.fn(async () => existingText);
	const modify = vi.fn();
	plugin.app = {
		vault: {
			readBinary: vi.fn(async () => bytes.slice().buffer), getAbstractFileByPath: () => existingFile,
			process, read, modify, create,
		},
		fileManager: { generateMarkdownLink: (_file, _path, subpath = '', alias = '') => `[[article.pdf${subpath}|${alias}]]` },
		workspace: { getLeaf: () => ({ openFile: vi.fn(async () => {}) }) },
	};
	plugin.settings = { colors: [] };
	plugin.assertCapturedPdfCurrent = vi.fn();
	const view = { file: { path: 'article.pdf', basename: 'article', parent: { path: '/' } }, containerEl: {}, getPdfJsDocument: () => ({}) };
	return { plugin, view, process, read, modify, create, content: () => stored, concurrentEdit: (text: string) => { stored = text; } };
}

afterEach(() => vi.clearAllMocks());

describe('atomic generated note writes', () => {
	it('exports into the latest note rather than overwriting a concurrent paragraph', async () => {
		const f = await setup('Initial paragraph.\n');
		f.concurrentEdit('Initial paragraph.\n\nA paragraph saved during export.\n');
		await f.plugin.exportHighlightsToNote(f.view);
		expect(f.process).toHaveBeenCalledOnce();
		expect(f.read).not.toHaveBeenCalled();
		expect(f.modify).not.toHaveBeenCalled();
		expect(f.content()).toContain('A paragraph saved during export.');
		expect(f.content()).toContain('Original quotation');
	});

	it('merges against the latest schedule and reports counts from that atomic merge', async () => {
		const old = '#flashcards\n\n## Page 1\n\nOld question :: Original quotation — [[article.pdf#page=1&annotation=12R|p. 1]]\n<!--SR:!2026-10-20,7,250-->\n';
		const f = await setup(old);
		const latest = old.replace('2026-10-20,7,250', '2026-11-30,21,280') + '\nNew handwritten review plan.\n';
		f.concurrentEdit(latest);
		await f.plugin.syncFlashcards(f.view);
		expect(f.process).toHaveBeenCalledOnce();
		expect(f.read).not.toHaveBeenCalled();
		expect(f.modify).not.toHaveBeenCalled();
		expect(f.content()).toContain('Updated question');
		expect(f.content()).toContain('<!--SR:!2026-11-30,21,280-->');
		expect(f.content()).toContain('New handwritten review plan.');
		expect(vi.mocked(Notice).mock.calls.at(-1)?.[0]).toContain('1 updated');
	});

	it('counts an independently added card as kept when it appears before the atomic merge', async () => {
		const f = await setup('#flashcards\n');
		const blocks = buildFlashcardBlocks([{
			pageNumber: 1, quote: 'Original quotation', note: 'Updated question',
			key: 'annotation=12R', link: '[[article.pdf#page=1&annotation=12R|p. 1]]',
		}]);
		f.concurrentEdit(mergeFlashcardNote(null, blocks).content);
		await f.plugin.syncFlashcards(f.view);
		expect(f.process).toHaveBeenCalledOnce();
		expect(vi.mocked(Notice).mock.calls.at(-1)?.[0]).toContain('0 new cards, 1 already there');
	});

	it.each(['exportHighlightsToNote', 'syncFlashcards'])('retains the create path for a missing note (%s)', async (method) => {
		const f = await setup(null);
		await f.plugin[method](f.view);
		expect(f.process).not.toHaveBeenCalled();
		expect(f.create).toHaveBeenCalledOnce();
		expect(f.content()).toContain('Original quotation');
	});
});
