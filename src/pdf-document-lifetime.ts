import type { PdfPageProxyLike } from './pdf-in-place';
import { observePdfStreamLifetime } from './pdf-stream-lifetime';

interface PdfDocumentLike {
	getPage(number: number): Promise<PdfPageProxyLike>;
}

export interface PdfPageConsumers {
	pdfPage?: PdfPageProxyLike | null;
	annotationLayer?: {
		pdfPage?: PdfPageProxyLike;
		page?: PdfPageProxyLike;
		annotationLayer?: { page?: PdfPageProxyLike } | null;
	} | null;
	textLayer?: { pdfPage?: PdfPageProxyLike } | null;
	xfaLayer?: { pdfPage?: PdfPageProxyLike } | null;
	annotationEditorLayer?: { pdfPage?: PdfPageProxyLike } | null;
	detailView?: PdfPageConsumers | null;
}

/** A lazily loaded page can outlive the document's turn as the active viewer
 * document. Keep its worker alive while a page/layer or outstanding request
 * still uses it; editing a different page does not make it obsolete. */
export function retainPdfDocument(document: PdfDocumentLike, onIdle?: () => void) {
	const pages = new WeakSet<PdfPageProxyLike>();
	let pendingWork = 0;
	let textRequestDepth = 0;
	const restoreDocumentMethods: (() => void)[] = [];
	const finishWork = () => {
		pendingWork--;
		if (pendingWork === 0) onIdle?.();
	};
	const trackRequests = (target: object, names: readonly string[], restore?: (() => void)[]) => {
		const methods = target as Record<string, unknown>;
		for (const name of names) {
			const original = methods[name];
			if (typeof original !== 'function') continue;
			const tracked = (...args: unknown[]): Promise<unknown> => {
				pendingWork++;
				if (name === 'getTextContent') textRequestDepth++;
				try {
					const result = original.apply(target, args) as Promise<unknown>;
					void result.then(finishWork, finishWork);
					return result;
				} catch (error) {
					finishWork();
					throw error;
				} finally {
					if (name === 'getTextContent') textRequestDepth--;
				}
			};
			methods[name] = tracked;
			restore?.push(() => { if (methods[name] === tracked) methods[name] = original; });
		}
	};
	trackRequests(document, [
		'getPageIndex', 'getDestinations', 'getDestination', 'getPageLabels', 'getPageLayout', 'getPageMode',
		'getViewerPreferences', 'getOpenAction', 'getAttachments', 'getAnnotationsByType', 'getOutline',
		'getOptionalContentConfig', 'getPermissions', 'getMetadata', 'getMarkInfo', 'getData', 'getDownloadInfo',
		'getStats', 'getFieldObjects', 'hasJSActions', 'getCalculationOrderIds', 'getJSActions', 'saveDocument',
	], restoreDocumentMethods);
	// Preserve the original method for restoration; every invocation below supplies its receiver.
	// eslint-disable-next-line @typescript-eslint/unbound-method -- Original identity is restored; calls use .call(document).
	const originalGetPage = document.getPage;
	const getPageForRefresh = async (number: number): Promise<PdfPageProxyLike> => {
		const page = await originalGetPage.call(document, number);
		if (!pages.has(page)) {
			pages.add(page);
			// Text extraction and structure/annotation reads can outlive the layer
			// that requested them. Protect the worker until those promises settle.
			trackRequests(page, ['getTextContent', 'getAnnotations', 'getStructTree', 'getXfa', 'getJSActions', 'getOperatorList']);
			const streamPage = page as PdfPageProxyLike & { streamTextContent?: (...args: unknown[]) => unknown };
			const streamTextContent = streamPage.streamTextContent;
			if (typeof streamTextContent === 'function') {
				streamPage.streamTextContent = (...args) => {
					const stream = streamTextContent.apply(page, args);
					// getTextContent's outer promise already covers its internal
					// stream. Native text layers consume a direct reader instead.
					if (textRequestDepth === 0) {
						pendingWork++;
						observePdfStreamLifetime(stream, { onComplete: finishWork, onUnobservable: () => undefined });
					}
					return stream;
				};
			}
			// Save the method without rebinding it; the wrapper calls it with this page.
			// eslint-disable-next-line @typescript-eslint/unbound-method -- The wrapper supplies the owning page via .call(page).
			const originalRender = page.render;
			if (originalRender) {
				page.render = (options) => {
					const render = originalRender.call(page, options);
					pendingWork++;
					void render.promise.then(finishWork, finishWork);
					return render;
				};
			}
		}
		return page;
	};
	const getPage = async (number: number): Promise<PdfPageProxyLike> => {
		pendingWork++;
		try {
			return await getPageForRefresh(number);
		} finally {
			// PDF.js attaches the returned proxy in its awaiting continuation.
			// Do not retire its worker between resolution and that attachment.
			setTimeout(finishWork, 0);
		}
	};
	document.getPage = getPage;
	return {
		document,
		// The refresh caller attaches its proxy before checking obsolete workers.
		getPage: getPageForRefresh,
		canRelease(pageViews: readonly PdfPageConsumers[]): boolean {
			if (pendingWork > 0) return false;
			return !pageViews.some((view) =>
				[
					view.pdfPage,
					view.annotationLayer?.pdfPage,
					view.annotationLayer?.page,
					view.annotationLayer?.annotationLayer?.page,
					view.textLayer?.pdfPage,
					view.xfaLayer?.pdfPage,
					view.annotationEditorLayer?.pdfPage,
					view.detailView?.pdfPage,
				]
					.some((page) => page != null && pages.has(page)),
			);
		},
		detach(): void {
			if (document.getPage === getPage) document.getPage = originalGetPage;
			for (const restore of restoreDocumentMethods) restore();
		},
	};
}
