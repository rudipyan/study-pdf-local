export interface PdfPageProxyLike {
	rotate: number;
	render?(options: Record<string, unknown>): { promise: Promise<unknown>; cancel?(): void };
}

export interface InPlacePdfWriteToken {
	fingerprint: string;
	generation: number;
	writeId: number;
}

export type InPlaceRefreshResult = 'refreshed' | 'superseded' | 'unavailable';

export interface PdfAnnotationLayerBuilderLike {
	pdfPage: PdfPageProxyLike;
	div: { remove(): void; parentNode?: unknown } | null;
	annotationLayer: unknown;
	_cancelled: boolean;
	cancel(): void;
	render(options: { viewport: unknown; intent: 'display'; structTreeLayer: unknown }): Promise<void> | void;
}

export interface PdfPageViewLike {
	pdfPage: PdfPageProxyLike | null;
	pdfPageRotate: number;
	viewport: unknown;
	structTreeLayer: unknown;
	annotationLayer: PdfAnnotationLayerBuilderLike | null;
	canvas?: HTMLCanvasElement | null;
	_annotationCanvasMap?: Map<unknown, unknown> | null;
	detailView?: { update?(options: { underlyingViewUpdated: boolean }): void } | null;
	_getRenderingContext?: (context: CanvasRenderingContext2D, transform: number[] | null) => Record<string, unknown>;
}

/** Standard annotation appearances are painted into the page canvas too. Draw
 * the changed page offscreen, then copy the finished image in one operation. */
export async function refreshPageCanvas(
	pageView: PdfPageViewLike,
	updatedPage: PdfPageProxyLike,
	isCurrent: () => boolean,
	previewRaster?: HTMLCanvasElement | null,
): Promise<void> {
	const canvas = pageView.canvas;
	if (!canvas) return; // Offscreen pages will render from their updated proxy.
	const viewport = pageView.viewport;
	const parent = canvas.parentNode;
	const sourcePage = pageView.pdfPage;
	const pageViewRotate = pageView.pdfPageRotate;
	const width = canvas.width;
	const height = canvas.height;
	const size = viewport as { width?: number; height?: number; scale?: number; rotation?: number } | null;
	if (!size?.width || !size.height) throw new Error('Study PDF: could not read the page dimensions.');
	const viewportWidth = size.width;
	const viewportHeight = size.height;
	const viewportScale = size.scale;
	const viewportRotation = size.rotation;
	const widthStyle = canvas.style?.cssText ?? '';
	const className = canvas.className ?? '';
	const parentStyle = canvas.parentElement?.getAttribute?.('style');
	const parentClassName = canvas.parentElement?.getAttribute?.('class');
	const previewIsCurrent = previewRaster && previewRaster !== canvas &&
		previewRaster.width === width && previewRaster.height === height && !pageView._annotationCanvasMap?.size && isCurrent() &&
		pageView.pdfPage === sourcePage && pageView.pdfPageRotate === pageViewRotate &&
		pageView.canvas === canvas && pageView.viewport === viewport &&
		canvas.width === width && canvas.height === height && (canvas.style?.cssText ?? '') === widthStyle &&
		(canvas.className ?? '') === className && canvas.parentNode === parent &&
		canvas.parentElement?.getAttribute?.('style') === parentStyle &&
		canvas.parentElement?.getAttribute?.('class') === parentClassName &&
		size.width === viewportWidth && size.height === viewportHeight &&
		size.scale === viewportScale && size.rotation === viewportRotation;
	const context = canvas.getContext('2d');
	if (!context) throw new Error('Study PDF: could not create a page drawing context.');
	const copyRaster = (raster: HTMLCanvasElement) => {
		context.save();
		try {
			context.setTransform(1, 0, 0, 1, 0, 0);
			context.globalCompositeOperation = 'copy';
			context.drawImage(raster, 0, 0);
		} finally {
			context.restore();
		}
	};
	if (previewIsCurrent && previewRaster && isCurrent()) {
		copyRaster(previewRaster);
		return;
	}
	if (!updatedPage.render || !pageView._getRenderingContext) {
		throw new Error('Study PDF: this PDF viewer cannot redraw one page safely.');
	}
	const scratch = canvas.ownerDocument.createElement('canvas');
	scratch.width = width;
	scratch.height = height;
	try {
		const scratchContext = scratch.getContext('2d', { alpha: false });
		if (!scratchContext) throw new Error('Study PDF: could not create a page drawing context.');
		const sx = width / size.width;
		const sy = height / size.height;
		await updatedPage.render(pageView._getRenderingContext(scratchContext, [sx, 0, 0, sy, 0, 0])).promise;
		if (!isCurrent() || pageView.canvas !== canvas || pageView.viewport !== viewport ||
			canvas.width !== width || canvas.height !== height || (parent && canvas.parentNode !== parent)) {
			throw new Error('Study PDF: the page changed while its annotations were being drawn.');
		}
		copyRaster(scratch);
	} finally {
		scratch.width = scratch.height = 0;
	}
}

/** Refresh just this page's standard PDF annotation DOM. The PDF page canvas,
 * text layer, scroll position, and every other page remain in place. */
export async function refreshPageAnnotationLayer(
	pageView: PdfPageViewLike,
	updatedPage: PdfPageProxyLike,
): Promise<void> {
	pageView.pdfPage = updatedPage;
	pageView.pdfPageRotate = updatedPage.rotate;

	const builder = pageView.annotationLayer;
	if (!builder) return; // An unrendered page will use the new page proxy when it is drawn.
	if (!pageView.viewport || typeof builder.render !== 'function' || typeof builder.cancel !== 'function') {
		throw new Error('Study PDF: this Obsidian PDF viewer cannot refresh one page safely.');
	}

	const oldLayer = builder.div;
	const layerParent = oldLayer?.parentNode;
	builder.cancel();
	builder.pdfPage = updatedPage;
	builder.div = null;
	builder.annotationLayer = null;
	builder._cancelled = false;
	await builder.render({
		viewport: pageView.viewport,
		intent: 'display',
		structTreeLayer: pageView.structTreeLayer,
	});
	// render() assigns div asynchronously; TypeScript cannot track that mutation.
	const refreshedLayer = builder.div as PdfAnnotationLayerBuilderLike['div'];
	if (!refreshedLayer || (layerParent && refreshedLayer.parentNode !== layerParent)) {
		throw new Error('Study PDF: the refreshed PDF annotation layer was not attached to its page.');
	}
	// PDFPageView's onAppend callback replaces its previous layer element. Keep
	// that element attached until render() calls it, or replaceWith() does nothing.
	oldLayer?.remove();
}

export function shouldSuppressPdfViewReload(options: {
	expectedFingerprint: string;
	currentFingerprint: string;
	startedAt: number;
	now: number;
	windowMs: number;
}): boolean {
	const age = options.now - options.startedAt;
	return age >= 0 && age <= options.windowMs && options.expectedFingerprint === options.currentFingerprint;
}

export async function fingerprintPdfBytes(bytes: Uint8Array): Promise<string> {
	const subtle = globalThis.crypto?.subtle;
	if (!subtle) throw new Error('Study PDF: this environment cannot verify the saved PDF bytes.');
	const exactBytes = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const digest = await subtle.digest('SHA-256', exactBytes as BufferSource);
	return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, '0')).join('');
}
