import { Notice } from 'obsidian';
import { acquirePdfOverlayHostPositioning } from './pdf-overlay-host';
import type { ActivePdfView } from '../obsidian-pdf-internals';
import type { HighlightColorOption } from '../color-palette';
import { clientRectToPageLocal, domRectToPdfBox, type PageLocalRect, type PdfBox, type PdfViewportLike } from '../geometry';
import { copyPdfRegionImage } from '../pdf-region-copy';
import { showIconPopup, type IconPopup } from './icon-popup';

export interface SelectedPdfRegion {
	pageIndex: number;
	pageElement: HTMLElement;
	pageLocalRect: PageLocalRect;
	box: PdfBox;
	viewport: PdfViewportLike;
}

export interface AreaAnnotationTap {
	pageIndex: number;
	pdfPoint: { x: number; y: number };
	position: { x: number; y: number };
}

export interface RegionSelectionController {
	dispose(): void;
}

/** Exists only while Area selection is active. No page scans, worker requests,
 * text-selection handlers, or persistent scroll listeners when inactive. */
export function createRegionSelection(
	view: ActivePdfView,
	actions: {
		isCurrent(): boolean;
		colors(): readonly HighlightColorOption[];
		onHighlight(region: SelectedPdfRegion, color: HighlightColorOption): void;
		onInteractionStart?(): void;
		onTapAnnotation?(tap: AreaAnnotationTap, isCurrent: () => boolean): void;
		hasOpenPopup?(): boolean;
		canHandleEscape(event: KeyboardEvent): boolean;
		onExit(): void;
	},
): RegionSelectionController {
	const doc = view.containerEl.ownerDocument;
	const win = doc.defaultView;
	const scroller = view.getPdfScrollElement();
	if (!win || !scroller) throw new Error('Area selection is unavailable while the PDF is loading.');
	const host = view.getPdfScrollHostElement();
	if (!host) throw new Error('Area selection is unavailable in this PDF pane.');
	const releaseHostPositioning = acquirePdfOverlayHostPositioning(host);
	const overlay = host.createDiv({ cls: 'study-pdf-region-selector' });
	overlay.setAttribute('aria-label', 'Drag a rectangle around a figure or table. Escape cancels.');
	const rectangle = overlay.createDiv({ cls: 'study-pdf-region-rectangle' });
	rectangle.hidden = true;
	let disposed = false;
	let popup: IconPopup | null = null;
	let frame = 0;
	let selectionGeneration = 0;
	let drag: {
		id: number; x: number; y: number; endX: number; endY: number;
		pageIndex: number; pageElement: HTMLElement; bounds: DOMRect; viewport: PdfViewportLike; startedAt: number; moved: boolean;
	} | null = null;
	const current = () => !disposed && actions.isCurrent() && scroller.isConnected && view.containerEl.getClientRects().length > 0;
	const clear = () => {
		selectionGeneration++;
		popup?.hide();
		popup = null;
		const previous = drag;
		drag = null;
		if (previous && overlay.hasPointerCapture(previous.id)) overlay.releasePointerCapture(previous.id);
		if (frame) win.cancelAnimationFrame(frame);
		frame = 0;
		rectangle.hidden = true;
	};
	const layout = () => {
		clear();
		const bounds = scroller.getBoundingClientRect();
		const origin = host.getBoundingClientRect();
		overlay.setCssStyles({ left: `${bounds.left - origin.left - host.clientLeft}px`, top: `${bounds.top - origin.top - host.clientTop}px`, width: `${bounds.width}px`, height: `${bounds.height}px` });
	};
	const boundsForDrag = () => {
		if (!drag) return null;
		const x = Math.max(drag.bounds.left, Math.min(drag.endX, drag.bounds.right));
		const y = Math.max(drag.bounds.top, Math.min(drag.endY, drag.bounds.bottom));
		return { left: Math.min(drag.x, x), top: Math.min(drag.y, y), right: Math.max(drag.x, x), bottom: Math.max(drag.y, y) };
	};
	const paint = () => {
		frame = 0;
		const bounds = boundsForDrag();
		if (!bounds) return;
		const origin = overlay.getBoundingClientRect();
		rectangle.hidden = false;
		rectangle.setCssStyles({ left: `${bounds.left - origin.left}px`, top: `${bounds.top - origin.top}px`, width: `${bounds.right - bounds.left}px`, height: `${bounds.bottom - bounds.top}px` });
	};
	const stop = (event: Event) => event.stopPropagation();
	const down = (event: PointerEvent) => {
		event.stopPropagation();
		if (drag || !event.isPrimary) { clear(); return; }
		if (event.button !== 0 || !current()) return;
		event.preventDefault();
		clear();
		actions.onInteractionStart?.();
		// Hit-testing beneath our transparent surface is bounded to this point.
		overlay.setCssStyles({ pointerEvents: 'none' });
		const node = doc.elementFromPoint(event.clientX, event.clientY);
		overlay.setCssStyles({ pointerEvents: '' });
		const pageIndex = node ? view.findPageIndexForNode(node) : null;
		if (pageIndex === null) return;
		const pageElement = view.getPageElement(pageIndex);
		if (!pageElement || !view.isPageRenderFinished(pageIndex)) return;
		const bounds = pageElement.getBoundingClientRect();
		if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) return;
		drag = { id: event.pointerId, x: event.clientX, y: event.clientY, endX: event.clientX, endY: event.clientY, pageIndex, pageElement, bounds, viewport: view.getPageViewport(pageIndex), startedAt: performance.now(), moved: false };
		overlay.setPointerCapture(event.pointerId);
		win.getSelection()?.removeAllRanges();
	};
	const move = (event: PointerEvent) => {
		event.stopPropagation();
		if (!drag || drag.id !== event.pointerId) return;
		event.preventDefault();
		drag.endX = event.clientX;
		drag.endY = event.clientY;
		if (Math.hypot(event.clientX - drag.x, event.clientY - drag.y) > 6) drag.moved = true;
		if (!frame) frame = win.requestAnimationFrame(paint);
	};
	const up = (event: PointerEvent) => {
		event.stopPropagation();
		if (!drag || event.pointerId !== drag.id) return;
		event.preventDefault();
		drag.endX = event.clientX;
		drag.endY = event.clientY;
		if (frame) win.cancelAnimationFrame(frame);
		paint();
		const saved = drag;
		const bounds = boundsForDrag();
		drag = null;
		if (overlay.hasPointerCapture(saved.id)) overlay.releasePointerCapture(saved.id);
		const pageIsCurrent = () => {
			if (!current() || !saved.pageElement.isConnected) return false;
			try {
				const now = saved.pageElement.getBoundingClientRect();
				return Math.abs(now.left - saved.bounds.left) < 0.5 && Math.abs(now.top - saved.bounds.top) < 0.5 &&
					Math.abs(now.width - saved.bounds.width) < 0.5 && Math.abs(now.height - saved.bounds.height) < 0.5 &&
					view.getPageViewport(saved.pageIndex) === saved.viewport;
			} catch { return false; }
		};
		if (!pageIsCurrent()) { clear(); return; }
		const isTap = !saved.moved && Math.hypot(event.clientX - saved.x, event.clientY - saved.y) <= 6;
		if (isTap) {
			clear();
			if (performance.now() - saved.startedAt > 800) return;
			const generation = selectionGeneration;
			const point = saved.viewport.convertToPdfPoint(saved.x - saved.bounds.left, saved.y - saved.bounds.top);
			actions.onTapAnnotation?.({
				pageIndex: saved.pageIndex,
				pdfPoint: { x: point[0], y: point[1] },
				position: { x: event.clientX, y: event.clientY },
			}, () => generation === selectionGeneration && pageIsCurrent());
			return;
		}
		if (!bounds || bounds.right - bounds.left < 8 || bounds.bottom - bounds.top < 8) { clear(); return; }
		const pageLocalRect = clientRectToPageLocal(bounds, { x: saved.bounds.left, y: saved.bounds.top });
		const viewport = saved.viewport;
		const region: SelectedPdfRegion = { pageIndex: saved.pageIndex, pageElement: saved.pageElement, pageLocalRect, viewport, box: domRectToPdfBox(pageLocalRect, viewport) };
		const generation = selectionGeneration;
		const regionCurrent = () => generation === selectionGeneration && pageIsCurrent();
		if (!regionCurrent()) { clear(); return; }
		popup = showIconPopup(doc, { x: bounds.left, y: Math.min(bounds.bottom + 8, scroller.getBoundingClientRect().bottom - 48) }, [
			{ type: 'icon', icon: 'copy', label: 'Copy selected area', onClick: () => {
				void copyPdfRegionImage(view, region.pageIndex, region.box, regionCurrent).then(
					() => { if (!disposed && generation === selectionGeneration) { new Notice('Selected area copied as an image. Paste it into your note.'); clear(); } },
					(error: unknown) => { if (!disposed && generation === selectionGeneration) new Notice(`Could not copy the selected area: ${(error as Error).message}`); },
				);
			} },
			...actions.colors().map((color) => ({ type: 'color' as const, hex: color.hex, name: `Highlight area with ${color.name}`, onClick: () => {
				if (!regionCurrent()) { clear(); new Notice('The page moved or zoom changed. Select the area again.'); return; }
				clear();
				actions.onHighlight(region, color);
			} })),
			{ type: 'icon', icon: 'x', label: 'Cancel area selection', onClick: clear },
		], { onDismiss: () => { rectangle.hidden = true; } });
		// Keep existing global annotation handlers out of this independent mode.
		for (const name of ['mousedown', 'mouseup', 'pointerdown', 'pointerup', 'touchstart', 'touchend']) popup.el.addEventListener(name, stop);
	};
	const cancel = (event: Event) => {
		event.stopPropagation();
		if (drag && drag.id === (event as PointerEvent).pointerId) clear();
	};
	const key = (event: KeyboardEvent) => {
		// The saved-area chooser/note editor handles its own Escape first.
		if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing || event.keyCode === 229 ||
			event.repeat || event.shiftKey || event.altKey || event.ctrlKey || event.metaKey ||
			!current() || actions.hasOpenPopup?.() || !actions.canHandleEscape(event)) return;
		event.preventDefault();
		event.stopPropagation();
		actions.onExit();
	};
	const wheel = (event: WheelEvent) => {
		if (event.ctrlKey) return; // Zoom belongs to the reader; resize clears the selection.
		event.preventDefault();
		clear();
		scroller.scrollBy({ left: event.deltaX, top: event.deltaY });
	};
	for (const name of ['mousedown', 'mouseup', 'click', 'dblclick', 'touchstart', 'touchmove', 'touchend']) overlay.addEventListener(name, stop);
	overlay.addEventListener('pointerdown', down);
	overlay.addEventListener('pointermove', move);
	overlay.addEventListener('pointerup', up);
	overlay.addEventListener('pointercancel', cancel);
	overlay.addEventListener('lostpointercapture', cancel);
	overlay.addEventListener('wheel', wheel, { passive: false });
	doc.addEventListener('keydown', key, true);
	win.addEventListener('blur', clear);
	win.addEventListener('resize', layout);
	win.visualViewport?.addEventListener('resize', layout);
	win.visualViewport?.addEventListener('scroll', layout);
	scroller.addEventListener('scroll', clear, { passive: true });
	const resize = new win.ResizeObserver(layout);
	resize.observe(scroller);
	layout();
	return { dispose() {
		if (disposed) return;
		disposed = true;
		clear();
		resize.disconnect();
		doc.removeEventListener('keydown', key, true);
		win.removeEventListener('blur', clear);
		win.removeEventListener('resize', layout);
		win.visualViewport?.removeEventListener('resize', layout);
		win.visualViewport?.removeEventListener('scroll', layout);
		scroller.removeEventListener('scroll', clear);
		overlay.remove();
		releaseHostPositioning();
	} };
}
