import { afterEach, describe, expect, it, vi } from 'vitest';
import { retainPdfDocument } from '../src/pdf-document-lifetime';

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => { resolve = done; });
	return { promise, resolve };
}

afterEach(() => vi.useRealTimers());

describe('temporary document retirement safety', () => {
	it('protects editor and detail pages after the main page releases them', async () => {
		const page = { rotate: 0 };
		const lease = retainPdfDocument({ getPage: async () => page });
		await lease.getPage(1);
		expect(lease.canRelease([{ annotationEditorLayer: { pdfPage: page } }])).toBe(false);
		expect(lease.canRelease([{ detailView: { pdfPage: page } }])).toBe(false);
		expect(lease.canRelease([])).toBe(true);
	});

	it.each(['getTextContent', 'getAnnotations', 'getStructTree', 'getXfa', 'getJSActions', 'getOperatorList'])(
		'keeps detached page %s work alive and preserves the native promise', async (method) => {
			const work = deferred();
			const page = { rotate: 0, [method]: () => work.promise };
			const lease = retainPdfDocument({ getPage: async () => page });
			await lease.getPage(1);
			expect(page[method]!()).toBe(work.promise);
			expect(lease.canRelease([])).toBe(false);
			work.resolve();
			await work.promise;
			expect(lease.canRelease([])).toBe(true);
		},
	);

	it('protects an outstanding document export and restores wrapped document methods', async () => {
		const work = deferred();
		const getData = () => work.promise;
		const document = { getPage: async () => ({ rotate: 0 }), getData };
		const lease = retainPdfDocument(document);
		expect(document.getData()).toBe(work.promise);
		expect(lease.canRelease([])).toBe(false);
		work.resolve();
		await work.promise;
		expect(lease.canRelease([])).toBe(true);
		lease.detach();
		expect(document.getData).toBe(getData);
	});

	it('returns a direct text stream unchanged and fails closed on its unknown lifetime', async () => {
		const stream = {};
		const page = { rotate: 0, streamTextContent: () => stream };
		const lease = retainPdfDocument({ getPage: async () => page });
		await lease.getPage(1);
		expect(page.streamTextContent()).toBe(stream);
		expect(lease.canRelease([])).toBe(false);
	});

	it('releases exhausted direct streams only after page consumers also detach', async () => {
		const stream = new ReadableStream({ start: (controller) => { controller.enqueue('text'); controller.close(); } });
		const page = { rotate: 0, streamTextContent: () => stream };
		const onIdle = vi.fn();
		const lease = retainPdfDocument({ getPage: async () => page }, onIdle);
		await lease.getPage(1);
		expect(page.streamTextContent()).toBe(stream);
		expect(lease.canRelease([])).toBe(false);
		const reader = stream.getReader();
		while (!(await reader.read()).done) { /* Consume exactly as the native text layer does. */ }
		reader.releaseLock();
		expect(onIdle).toHaveBeenCalledOnce();
		expect(lease.canRelease([{ textLayer: { pdfPage: page } }])).toBe(false);
		expect(lease.canRelease([])).toBe(true);
	});

	it('retains all concurrent stream work until each known lifetime ends', async () => {
		const streams = [new ReadableStream(), new ReadableStream(), {}];
		const page = { rotate: 0, streamTextContent: () => streams.shift() };
		const lease = retainPdfDocument({ getPage: async () => page });
		await lease.getPage(1);
		const first = page.streamTextContent() as ReadableStream;
		const second = page.streamTextContent() as ReadableStream;
		await first.cancel();
		expect(lease.canRelease([])).toBe(false);
		await second.cancel();
		expect(lease.canRelease([])).toBe(true);
		page.streamTextContent();
		expect(lease.canRelease([])).toBe(false);
	});

	it('keeps a cancelled stream retained until its underlying work settles', async () => {
		const cancellation = deferred();
		const page = { rotate: 0, streamTextContent: () => new ReadableStream({ cancel: () => cancellation.promise }) };
		const lease = retainPdfDocument({ getPage: async () => page });
		await lease.getPage(1);
		const reader = page.streamTextContent().getReader();
		const cancel = reader.cancel();
		await reader.closed;
		expect(lease.canRelease([])).toBe(false);
		cancellation.resolve();
		await cancel;
		expect(lease.canRelease([])).toBe(true);
	});

	it('does not add outstanding work when stream creation throws synchronously', async () => {
		const failure = new Error('native stream failed');
		const page = { rotate: 0, streamTextContent: () => { throw failure; } };
		const lease = retainPdfDocument({ getPage: async () => page });
		await lease.getPage(1);
		expect(() => page.streamTextContent()).toThrow(failure);
		expect(lease.canRelease([])).toBe(true);
	});

	it('bounds 200 completed/cancelled direct-stream revisions without retiring active pages', async () => {
		const held = [];
		for (let revision = 0; revision < 200; revision++) {
			const page = { rotate: 0, streamTextContent: () => new ReadableStream({ start: (controller) => controller.close() }) };
			const lease = retainPdfDocument({ getPage: async () => page });
			await lease.getPage(1);
			const reader = page.streamTextContent().getReader();
			if (revision % 2) await reader.cancel();
			else await reader.read();
			reader.releaseLock();
			for (const previous of held) expect(previous.canRelease([])).toBe(true);
			held.splice(0, held.length, lease);
			expect(lease.canRelease([{ pdfPage: page }])).toBe(false);
		}
		expect(held).toHaveLength(1);
	});

	it('allows retirement when native getTextContent has finished consuming its internal stream', async () => {
		const work = deferred();
		const page = {
			rotate: 0,
			streamTextContent: () => ({}),
			getTextContent() { this.streamTextContent(); return work.promise; },
		};
		const lease = retainPdfDocument({ getPage: async () => page });
		await lease.getPage(1);
		page.getTextContent();
		expect(lease.canRelease([])).toBe(false);
		work.resolve();
		await work.promise;
		expect(lease.canRelease([])).toBe(true);
	});

	it('waits for the getPage attachment turn and signals idle without polling', async () => {
		vi.useFakeTimers();
		const onIdle = vi.fn();
		const document = { getPage: async () => ({ rotate: 0 }) };
		const lease = retainPdfDocument(document, onIdle);
		await document.getPage();
		expect(lease.canRelease([])).toBe(false);
		await vi.runAllTimersAsync();
		expect(lease.canRelease([])).toBe(true);
		expect(onIdle).toHaveBeenCalledOnce();
	});
});
