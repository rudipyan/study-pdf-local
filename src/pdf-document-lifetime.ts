import type { PdfPageProxyLike } from './pdf-in-place';

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
}

/** A lazily loaded page can outlive the document's turn as the active viewer
 * document. Keep its worker alive while a page/layer or outstanding request
 * still uses it; editing a different page does not make it obsolete. */
export function retainPdfDocument(document: PdfDocumentLike) {
	const pages = new WeakSet<PdfPageProxyLike>();
	let pendingWork = 0;
	// Preserve the original method for restoration; every invocation below supplies its receiver.
	// eslint-disable-next-line @typescript-eslint/unbound-method -- Original identity is restored; calls use .call(document).
	const originalGetPage = document.getPage;
	const getPageForRefresh = async (number: number): Promise<PdfPageProxyLike> => {
		const page = await originalGetPage.call(document, number);
		if (!pages.has(page)) {
			pages.add(page);
			// Save the method without rebinding it; the wrapper calls it with this page.
			// eslint-disable-next-line @typescript-eslint/unbound-method -- The wrapper supplies the owning page via .call(page).
			const originalRender = page.render;
			if (originalRender) {
				page.render = (options) => {
					const render = originalRender.call(page, options);
					pendingWork++;
					void render.promise.then(() => pendingWork--, () => pendingWork--);
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
			setTimeout(() => pendingWork--, 0);
		}
	};
	document.getPage = getPage;
	return {
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
				]
					.some((page) => page != null && pages.has(page)),
			);
		},
		detach(): void {
			if (document.getPage === getPage) document.getPage = originalGetPage;
		},
	};
}
