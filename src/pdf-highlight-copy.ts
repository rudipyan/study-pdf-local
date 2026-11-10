import type { HighlightInfo } from './annotate';
import type { ActivePdfView } from './obsidian-pdf-internals';
import type { PdfJsDocument } from './pdf-highlights';
import { extractQuote } from './pdf-text-extraction';

type CopyableHighlight = Pick<HighlightInfo, 'quote' | 'quoteRects' | 'regionBox'>;

export function canCopyHighlight(highlight: CopyableHighlight): boolean {
	return Boolean(highlight.regionBox || highlight.quote?.trim() || highlight.quoteRects?.length);
}

export async function copyPdfHighlightText(
	view: ActivePdfView,
	pageIndex: number,
	highlight: CopyableHighlight,
	isCurrent: () => boolean,
): Promise<void> {
	const win = view.containerEl.ownerDocument.defaultView;
	const clipboard = win?.navigator.clipboard;
	if (!clipboard) throw new Error('Clipboard access is unavailable.');
	if (!isCurrent()) throw new Error('The PDF changed before the text could be copied.');
	if (highlight.quote?.trim()) {
		await clipboard.writeText(highlight.quote);
		return;
	}

	const rects = highlight.quoteRects;
	if (!rects?.length) throw new Error('No highlighted text was found.');
	const pdf = view.getPdfJsDocument() as PdfJsDocument;
	const quote = pdf.getPage(pageIndex + 1).then(async (page) => {
		const { items } = await page.getTextContent();
		if (!isCurrent() || view.getPdfJsDocument() !== pdf) throw new Error('The PDF changed before the text could be copied.');
		const text = extractQuote(rects, items);
		if (!text) throw new Error('No selectable text was found under this highlight.');
		return text;
	});

	// Start the write inside the click or shortcut so WebKit retains user activation.
	const Item = (win as (Window & { ClipboardItem?: typeof ClipboardItem }) | null)?.ClipboardItem;
	if (Item && typeof clipboard.write === 'function') {
		const data = quote.then((text) => new Blob([text], { type: 'text/plain' }));
		void data.catch(() => undefined); // The browser may reject before consuming the data.
		await Promise.all([quote, clipboard.write([new Item({ 'text/plain': data })])]);
		return;
	}
	await clipboard.writeText(await quote);
}
