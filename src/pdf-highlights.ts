// Reads every /Highlight annotation out of a temporary PDF.js document parsed
// from the same immutable byte snapshot used for its stored metadata. No need
// to bundle our own copy of pdf.js.
//
// No Obsidian imports -- the pdf.js document is passed in.
import { quadPointsToRects, extractQuote, normalizeQuote, type PdfJsTextItem } from './pdf-text-extraction';
import type { StoredQuotesByReference } from './annotate';

export interface HighlightEntry {
	pageNumber: number;
	/** PDF-space top of the first quad; used to sort entries in reading order. */
	top: number;
	colorCss: string;
	quote: string;
	note: string | null;
	/** pdf.js annotation id (e.g. "40R") -- the same id Obsidian's own
	 * `#page=N&annotation=ID` deep links target. */
	annotationId: string | null;
}

// Minimal local shapes for the slice of pdf.js's live, untyped document we
// actually read -- same approach as PdfViewportLike in geometry.ts: capture
// only what we use, rather than depending on pdfjs-dist's real (and
// version-specific) types for this glue code.
export interface PdfJsAnnotation {
	subtype?: string;
	quadPoints?: unknown;
	color?: number[];
	contentsObj?: { str?: string };
	id?: string;
}

export interface PdfJsPage {
	getAnnotations(): Promise<PdfJsAnnotation[]>;
	getTextContent(): Promise<{ items: PdfJsTextItem[] }>;
}

export interface PdfJsDocument {
	numPages: number;
	getPage(pageNumber: number): Promise<PdfJsPage>;
}

export interface CollectHighlightsOptions {
	signal?: AbortSignal;
	onProgress?: (pageNumber: number, pageCount: number) => void;
}

function assertScanActive(signal?: AbortSignal): void {
	if (!signal?.aborted) return;
	const error = new Error('The highlights scan was cancelled.');
	error.name = 'AbortError';
	throw error;
}

function isLegacyTruncatedQuote(quote: string): boolean {
	return quote.length === 300 && quote.endsWith('…');
}

function shouldYield(pdfjsDoc: PdfJsDocument, pageNumber: number): boolean {
	return pdfjsDoc.numPages >= 64 && pageNumber % 4 === 0;
}

export async function collectHighlights(
	pdfjsDoc: PdfJsDocument,
	storedQuotes: StoredQuotesByReference,
	options: CollectHighlightsOptions = {},
): Promise<HighlightEntry[]> {
	const entries: HighlightEntry[] = [];
	for (let pageNumber = 1; pageNumber <= pdfjsDoc.numPages; pageNumber++) {
		assertScanActive(options.signal);
		const page = await pdfjsDoc.getPage(pageNumber);
		const annotations = await page.getAnnotations();
		const highlights = annotations.filter((a) => a.subtype === 'Highlight');
		const pageStoredQuotes = storedQuotes.byAnnotationId.get(pageNumber - 1);
		let textItems: PdfJsTextItem[] | null = null;
		for (const annotation of highlights) {
			assertScanActive(options.signal);
			const rects = quadPointsToRects(annotation.quadPoints);
			const metadata = annotation.id ? pageStoredQuotes?.get(annotation.id) : null;
			const storedQuote = metadata?.quote ?? null;
			const needsRecovery = !metadata?.isRegion && (storedQuote === null || isLegacyTruncatedQuote(storedQuote));
			let recoveredQuote = '';
			if (needsRecovery && rects.length > 0) {
				textItems ??= (await page.getTextContent()).items;
				assertScanActive(options.signal);
				recoveredQuote = extractQuote(rects, textItems);
			}
			const quote = metadata?.isRegion
				? normalizeQuote(storedQuote ?? '')
				: storedQuote === null
				? recoveredQuote
				: isLegacyTruncatedQuote(storedQuote) && recoveredQuote.startsWith(storedQuote.slice(0, -1))
					? recoveredQuote
					: normalizeQuote(storedQuote);
			const [r, g, b] = annotation.color ?? [255, 255, 0];
			entries.push({
				pageNumber,
				top: rects[0]?.top ?? 0,
				colorCss: `rgb(${r}, ${g}, ${b})`,
				quote,
				note: annotation.contentsObj?.str?.trim() || null,
				annotationId: annotation.id ?? null,
			});
		}
		options.onProgress?.(pageNumber, pdfjsDoc.numPages);
		if (shouldYield(pdfjsDoc, pageNumber)) {
			await new Promise<void>((resolve) => setTimeout(resolve, 0));
			assertScanActive(options.signal);
		}
	}
	// Reading order: page ascending, then top-of-page first (PDF y grows upward).
	// Two highlights on the same line tie on `top`; a stable sort leaves them in
	// /Annots order, which is what makes re-exporting an unchanged PDF a no-op.
	entries.sort((a, b) => a.pageNumber - b.pageNumber || b.top - a.top);
	return entries;
}
