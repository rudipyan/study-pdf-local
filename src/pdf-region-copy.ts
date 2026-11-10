import type { ActivePdfView } from './obsidian-pdf-internals';
import type { PdfBox } from './geometry';

/** Call directly from the user's click: Safari needs clipboard activation before
 * asynchronous PNG encoding completes. Rendering is only requested on Copy. */
export function copyPdfRegionImage(
	view: ActivePdfView,
	pageIndex: number,
	box: PdfBox,
	isCurrent: () => boolean,
): Promise<void> {
	const win = view.containerEl.ownerDocument.defaultView;
	const Item = (win as (Window & { ClipboardItem?: typeof ClipboardItem }) | null)?.ClipboardItem;
	const clipboard = win?.navigator.clipboard;
	if (!isCurrent() || !view.captureRegionImage || !Item || !clipboard?.write) {
		return Promise.reject(new Error('Image copying is unavailable here. Keep the PDF open and allow clipboard access.'));
	}
	const image = view.captureRegionImage(pageIndex, box).then((blob) => {
		if (!isCurrent()) throw new Error('The PDF changed while the image was being copied.');
		return blob;
	});
	// Some engines reject write before consuming its promised representation.
	void image.catch(() => undefined);
	try {
		return clipboard.write([new Item({ 'image/png': image })]);
	} catch (error) {
		return Promise.reject(error instanceof Error ? error : new Error(String(error)));
	}
}
