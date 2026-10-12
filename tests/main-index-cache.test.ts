import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('obsidian', () => {
	class Base {}
	return {
		Plugin: Base, Modal: Base, FileView: Base, PluginSettingTab: Base, Setting: Base,
		Scope: Base, TFile: Base, Notice: Base, Platform: {}, setIcon: vi.fn(), setTooltip: vi.fn(),
	};
});

import StudyPdf from '../src/main';
import { makeFixturePdfBytes } from './helpers/pdf-fixture';

function asArrayBuffer(bytes: Uint8Array): ArrayBuffer {
	return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function setupPlugin(readBinary: (file: object) => Promise<ArrayBuffer>, file = {
	path: 'papers/article.pdf', stat: { mtime: 10, size: 100 },
}) {
	const plugin = new StudyPdf() as any;
	plugin.app = { vault: { readBinary } };
	plugin.isCapturedPdfCurrent = vi.fn(() => true);
	const view = { file, containerEl: {} };
	const capture = { file, path: file.path, pdfView: view };
	return { plugin, file, capture };
}

afterEach(() => vi.restoreAllMocks());

describe('verified highlight index cache', () => {
	it('reuses the parsed index for one file revision and rebuilds after its revision changes', async () => {
		const bytes = await makeFixturePdfBytes();
		const readBinary = vi.fn(async () => asArrayBuffer(bytes));
		const { plugin, file, capture } = setupPlugin(readBinary);

		const first = await plugin.getHighlightIndexForCapture(capture);
		const cached = await plugin.getHighlightIndexForCapture(capture);
		expect(cached).toBe(first);
		expect(readBinary).toHaveBeenCalledOnce();

		file.stat.mtime++;
		const refreshed = await plugin.getHighlightIndexForCapture(capture);
		expect(refreshed).not.toBe(first);
		expect(readBinary).toHaveBeenCalledTimes(2);
	});

	it('deduplicates simultaneous cold reads and index builds', async () => {
		const bytes = await makeFixturePdfBytes();
		let release!: (bytes: ArrayBuffer) => void;
		let markStarted!: () => void;
		const gate = new Promise<ArrayBuffer>((resolve) => { release = resolve; });
		const started = new Promise<void>((resolve) => { markStarted = resolve; });
		const readBinary = vi.fn(() => { markStarted(); return gate; });
		const { plugin, capture } = setupPlugin(readBinary);

		const firstRequest = plugin.getHighlightIndexForCapture(capture);
		const secondRequest = plugin.getHighlightIndexForCapture(capture);
		await started;
		expect(readBinary).toHaveBeenCalledOnce();
		release(asArrayBuffer(bytes));
		const [first, second] = await Promise.all([firstRequest, secondRequest]);
		expect(second).toBe(first);
		expect(readBinary).toHaveBeenCalledOnce();
	});

	it('does not publish an index if the file cache is invalidated during its read', async () => {
		const bytes = await makeFixturePdfBytes();
		let release!: (bytes: ArrayBuffer) => void;
		let markStarted!: () => void;
		const gate = new Promise<ArrayBuffer>((resolve) => { release = resolve; });
		const started = new Promise<void>((resolve) => { markStarted = resolve; });
		const readBinary = vi.fn(() => { markStarted(); return gate; });
		const { plugin, capture } = setupPlugin(readBinary);

		const staleRequest = plugin.getHighlightIndexForCapture(capture);
		await started;
		plugin.invalidateHighlightIndex();
		release(asArrayBuffer(bytes));
		await expect(staleRequest).rejects.toThrow(/PDF changed while inspecting annotations/);
		expect(plugin.highlightIndex).toBeNull();

		readBinary.mockResolvedValue(asArrayBuffer(bytes));
		await plugin.getHighlightIndexForCapture(capture);
		expect(readBinary).toHaveBeenCalledTimes(2);
	});
});
