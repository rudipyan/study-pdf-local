import { describe, expect, it, vi } from 'vitest';
import { fingerprintPdfBytes, refreshPageAnnotationLayer, refreshPageCanvas, shouldSuppressPdfViewReload } from '../src/pdf-in-place';

describe('refreshPageCanvas', () => {
	function fixture() {
		const context = { save: vi.fn(), restore: vi.fn(), setTransform: vi.fn(), drawImage: vi.fn() };
		const scratchContext = {};
		const scratch = { width: 0, height: 0, getContext: () => scratchContext };
		const canvas = { width: 1200, height: 1600, parentNode: {}, getContext: () => context, ownerDocument: { createElement: () => scratch } };
		const pageView = {
			pdfPage: null, pdfPageRotate: 0, annotationLayer: null, structTreeLayer: null,
			viewport: { width: 600, height: 800 }, canvas: canvas as unknown as HTMLCanvasElement,
			_getRenderingContext: vi.fn((canvasContext, transform) => ({ canvasContext, transform, annotationMode: 2 })),
		};
		return { pageView, context, scratch, scratchContext };
	}

	it('waits for the offscreen render before copying pixels into the existing canvas', async () => {
		const f = fixture();
		let finish!: () => void;
		const render = vi.fn(() => ({ promise: new Promise<void>((resolve) => { finish = resolve; }) }));
		const update = refreshPageCanvas(f.pageView, { rotate: 0, render }, () => true);
		expect(f.context.drawImage).not.toHaveBeenCalled();
		expect(render).toHaveBeenCalledWith({ canvasContext: f.scratchContext, transform: [2, 0, 0, 2, 0, 0], annotationMode: 2 });
		finish();
		await update;
		expect(f.context.drawImage).toHaveBeenCalledWith(f.scratch, 0, 0);
		expect(f.context.restore).toHaveBeenCalledOnce();
		expect(f.scratch.width).toBe(0);
	});

	it('does not overwrite the canvas after a newer document has replaced the target', async () => {
		const f = fixture();
		const render = vi.fn(() => ({ promise: Promise.resolve() }));
		await expect(refreshPageCanvas(f.pageView, { rotate: 0, render }, () => false)).rejects.toThrow('page changed');
		expect(f.context.drawImage).not.toHaveBeenCalled();
		expect(f.scratch.width).toBe(0);
	});

	it('copies a completed preview raster without rendering the updated page again', async () => {
		const f = fixture();
		const render = vi.fn(() => ({ promise: Promise.resolve() }));
		const raster = { width: 1200, height: 1600 } as HTMLCanvasElement;

		await refreshPageCanvas(f.pageView, { rotate: 0, render }, () => true, raster);

		expect(render).not.toHaveBeenCalled();
		expect(f.context.drawImage).toHaveBeenCalledWith(raster, 0, 0);
		expect(f.scratch.width).toBe(0);
	});

	it('falls back to rendering when the supplied preview raster is stale', async () => {
		const f = fixture();
		const render = vi.fn(() => ({ promise: Promise.resolve() }));
		const raster = { width: 600, height: 800 } as HTMLCanvasElement;

		await refreshPageCanvas(f.pageView, { rotate: 0, render }, () => true, raster);

		expect(render).toHaveBeenCalledOnce();
		expect(f.context.drawImage).toHaveBeenCalledWith(f.scratch, 0, 0);
	});

	it('falls back to the live render when annotation canvases are present', async () => {
		const f = fixture();
		const annotationCanvasMap = new Map([['form-field', {}]]);
		f.pageView._annotationCanvasMap = annotationCanvasMap;
		f.pageView._getRenderingContext = vi.fn((canvasContext, transform) => ({
			canvasContext, transform, annotationCanvasMap,
		}));
		const render = vi.fn(() => ({ promise: Promise.resolve() }));
		const raster = { width: 1200, height: 1600 } as HTMLCanvasElement;

		await refreshPageCanvas(f.pageView, { rotate: 0, render }, () => true, raster);

		expect(render).toHaveBeenCalledOnce();
		expect(f.pageView._getRenderingContext).toHaveBeenCalledWith(f.scratchContext, [2, 0, 0, 2, 0, 0]);
		expect(f.pageView._getRenderingContext.mock.results[0]?.value.annotationCanvasMap).toBe(annotationCanvasMap);
		expect(f.context.drawImage).toHaveBeenCalledWith(f.scratch, 0, 0);
	});
});

describe('shouldSuppressPdfViewReload', () => {
	const expectedFingerprint = 'a'.repeat(64);

	it('suppresses only the exact plugin-written bytes inside the short event window', () => {
		expect(shouldSuppressPdfViewReload({
			expectedFingerprint,
			currentFingerprint: expectedFingerprint,
			startedAt: 100,
			now: 300,
			windowMs: 2500,
		})).toBe(true);
	});

	it('allows external edits and later reloads through', () => {
		expect(shouldSuppressPdfViewReload({
			expectedFingerprint,
			currentFingerprint: 'b'.repeat(64),
			startedAt: 100,
			now: 300,
			windowMs: 2500,
		})).toBe(false);
		expect(shouldSuppressPdfViewReload({
			expectedFingerprint,
			currentFingerprint: expectedFingerprint,
			startedAt: 100,
			now: 3000,
			windowMs: 2500,
		})).toBe(false);
	});
});

describe('refreshPageAnnotationLayer', () => {
	it('rebuilds only the annotation layer and preserves the page DOM', async () => {
		const parent = {};
		const oldLayer = { remove: vi.fn(), parentNode: parent };
		const updatedPage = { rotate: 0 };
		const builder = {
			pdfPage: { rotate: 0 },
			div: oldLayer,
			annotationLayer: {},
			_cancelled: false,
			cancel: vi.fn(function (this: { _cancelled: boolean }) { this._cancelled = true; }),
			render: vi.fn(async function (this: { div: object | null }) {
				expect(oldLayer.remove).not.toHaveBeenCalled();
				this.div = { parentNode: parent };
			}),
		};
		const pageView = {
			pdfPage: { rotate: 0 },
			pdfPageRotate: 0,
			viewport: { scale: 1 },
			structTreeLayer: null,
			annotationLayer: builder,
		};

		await refreshPageAnnotationLayer(pageView, updatedPage);

		expect(pageView.pdfPage).toBe(updatedPage);
		expect(oldLayer.remove).toHaveBeenCalledOnce();
		expect(builder.cancel).toHaveBeenCalledOnce();
		expect(builder._cancelled).toBe(false);
		expect(builder.render).toHaveBeenCalledWith({
			viewport: pageView.viewport,
			intent: 'display',
			structTreeLayer: null,
		});
		expect(pageView.annotationLayer).toBe(builder);
	});

	it('rejects a replacement layer that was not attached to the original page', async () => {
		const oldLayer = { remove: vi.fn(), parentNode: {} };
		const builder = {
			pdfPage: { rotate: 0 }, div: oldLayer, annotationLayer: {}, _cancelled: false,
			cancel: vi.fn(),
			render: vi.fn(async function (this: { div: object | null }) { this.div = { parentNode: null }; }),
		};
		const pageView = {
			pdfPage: { rotate: 0 }, pdfPageRotate: 0, viewport: {}, structTreeLayer: null, annotationLayer: builder,
		};
		await expect(refreshPageAnnotationLayer(pageView, { rotate: 0 })).rejects.toThrow('not attached');
		expect(oldLayer.remove).not.toHaveBeenCalled();
	});

	it('updates an unrendered page proxy without creating or resetting its layers', async () => {
		const pageView = {
			pdfPage: null,
			pdfPageRotate: 0,
			viewport: null,
			structTreeLayer: null,
			annotationLayer: null,
		};
		const updatedPage = { rotate: 90 };

		await refreshPageAnnotationLayer(pageView, updatedPage);

		expect(pageView.pdfPage).toBe(updatedPage);
		expect(pageView.pdfPageRotate).toBe(90);
	});
});

describe('fingerprintPdfBytes', () => {
	it('hashes only the supplied typed-array view', async () => {
		const whole = new Uint8Array([99, 1, 2, 3, 88]);
		const view = whole.subarray(1, 4);
		const digest = await fingerprintPdfBytes(view);
		expect(digest).toBe(await fingerprintPdfBytes(new Uint8Array([1, 2, 3])));
	});
});
