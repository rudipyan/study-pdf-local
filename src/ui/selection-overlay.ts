// Paints the current text selection ourselves, as real DOM rectangles.
//
// Only needed on iOS: WKWebView ignores every ::selection property inside the
// PDF text layer (background-color, color and -webkit-text-fill-color were all
// confirmed dead on-device at the highest specificity in the cascade) and paints
// its own very faint system tint instead, which is close to invisible over white
// paper. CodeMirror has the same problem in the editor and solves it the same
// way, which is why notes look stronger than PDFs on an iPhone.
//
// Deliberately dumb: it owns no selection state of its own, it just renders
// whatever rectangles it is handed. Deciding *when* to show them stays in
// main.ts alongside the rest of the selection logic.

/** A viewport-space rectangle to paint. Structural, not a DOMRect, so callers
 * can hand over plain objects and tests don't need a DOM. */
export interface OverlayRect {
	left: number;
	top: number;
	width: number;
	height: number;
}

export interface SelectionOverlay {
	/** Replaces whatever is currently painted. An empty list clears it. */
	update(rects: OverlayRect[], color?: string): void;
	/** Removes the overlay element entirely. */
	destroy(): void;
}

/** How much two rects must overlap vertically, as a fraction of the shorter
 * one, to count as the same line of text. Rects on one line routinely differ in
 * top and height by a few pixels when a line mixes font sizes (superscript
 * footnote markers, small caps), so exact comparison leaves them unmerged --
 * measured on a real page before this was a ratio. Consecutive lines overlap far
 * less than half, so this separates them cleanly. */
const SAME_LINE_OVERLAP = 0.5;

/** Drops zero-area rectangles and unions ones that sit on the same line and
 * touch. getClientRects() returns one rect per line box, but on a PDF text layer
 * it also returns slivers for inter-word gaps and overlapping rects where
 * adjacent spans abut -- painted at partial opacity those show up as seams and
 * double-darkened patches along an otherwise even line. */
export function normalizeOverlayRects(rects: OverlayRect[]): OverlayRect[] {
	const usable = rects.filter((r) => r.width >= 1 && r.height >= 1);
	const out: OverlayRect[] = [];
	for (const rect of usable) {
		let merged = { ...rect };
		for (let index = 0; index < out.length;) {
			const current = out[index]!;
			if (!onSameLine(current, merged) || !touchesHorizontally(current, merged)) {
				index++;
				continue;
			}
			const left = Math.min(current.left, merged.left);
			const top = Math.min(current.top, merged.top);
			merged = {
				left,
				top,
				width: Math.max(current.left + current.width, merged.left + merged.width) - left,
				height: Math.max(current.top + current.height, merged.top + merged.height) - top,
			};
			out.splice(index, 1);
			// The wider union can connect to rectangles visited earlier, including
			// in reversed DOM order. Recheck only the existing bounded output list.
			index = 0;
		}
		out.push(merged);
	}
	return out;
}

function onSameLine(a: OverlayRect, b: OverlayRect): boolean {
	const overlap = Math.min(a.top + a.height, b.top + b.height) - Math.max(a.top, b.top);
	return overlap > 0 && overlap >= Math.min(a.height, b.height) * SAME_LINE_OVERLAP;
}

/** Touching counts as overlapping: abutting spans leave no gap, and a 1px slack
 * absorbs the sub-pixel seams that fractional zoom levels produce. */
function touchesHorizontally(a: OverlayRect, b: OverlayRect): boolean {
	return b.left <= a.left + a.width + 1 && a.left <= b.left + b.width + 1;
}

interface OverlayPdfView {
	containerEl: HTMLElement;
	getPdfScrollElement(): HTMLElement | null;
	findPageIndexForNode(node: Node): number | null;
	getPageElement(pageIndex: number): HTMLElement | null;
}

/** Visual preview only. Saving still captures and validates every selected
 * text fragment separately; this path never walks text nodes or reads PDF data. */
export function liveSelectionOverlayRects(view: OverlayPdfView, range: Range): OverlayRect[] {
	try {
		const pane = view.containerEl;
		const doc = pane.ownerDocument;
		const win = doc.defaultView;
		const scroll = view.getPdfScrollElement();
		if (!win || !scroll || !pane.contains(scroll) || range.collapsed ||
			!range.startContainer.isConnected || !range.endContainer.isConnected ||
			!pane.contains(range.startContainer) || !pane.contains(range.endContainer)) return [];
		const textLayerFor = (node: Node) => (node.nodeType === 1 ? node as Element : node.parentElement)?.closest<HTMLElement>('.textLayer') ?? null;
		const firstLayer = textLayerFor(range.startContainer);
		const lastLayer = textLayerFor(range.endContainer);
		const firstPage = view.findPageIndexForNode(range.startContainer);
		const lastPage = view.findPageIndexForNode(range.endContainer);
		if (!firstLayer || !lastLayer || firstPage === null || lastPage === null ||
			!Number.isInteger(firstPage) || firstPage < 0 || !Number.isInteger(lastPage) || firstPage > lastPage) return [];
		const layers: HTMLElement[] = [];
		for (let index = firstPage; index <= lastPage; index++) {
			const page = view.getPageElement(index);
			const layer = page?.matches('.textLayer') ? page : page?.querySelector<HTMLElement>('.textLayer');
			if (!layer || !layer.isConnected || !pane.contains(layer) ||
				(index === firstPage && layer !== firstLayer) || (index === lastPage && layer !== lastLayer)) return [];
			layers.push(layer);
		}
		const viewport = win.visualViewport;
		let left = Math.max(0, viewport?.offsetLeft ?? 0);
		let top = Math.max(0, viewport?.offsetTop ?? 0);
		let right = Math.min(win.innerWidth, left + (viewport?.width ?? win.innerWidth));
		let bottom = Math.min(win.innerHeight, top + (viewport?.height ?? win.innerHeight));
		const intersect = (rect: { left: number; top: number; right: number; bottom: number }) => {
			left = Math.max(left, rect.left); top = Math.max(top, rect.top);
			right = Math.min(right, rect.right); bottom = Math.min(bottom, rect.bottom);
		};
		intersect(pane.getBoundingClientRect());
		const scrollRect = scroll.getBoundingClientRect();
		intersect({ left: scrollRect.left + scroll.clientLeft, top: scrollRect.top + scroll.clientTop,
			right: scrollRect.left + scroll.clientLeft + scroll.clientWidth,
			bottom: scrollRect.top + scroll.clientTop + scroll.clientHeight });
		// The pane/scroller and clipping wrappers bound body-level fixed paint.
		// This is one ancestor walk per animation frame, never a page/text scan.
		let ancestor = scroll.parentElement;
		while (ancestor && ancestor !== doc.documentElement) {
			const style = win.getComputedStyle(ancestor);
			const rect = ancestor.getBoundingClientRect();
			if (style.overflowX !== 'visible') {
				left = Math.max(left, rect.left + ancestor.clientLeft);
				right = Math.min(right, rect.left + ancestor.clientLeft + ancestor.clientWidth);
			}
			if (style.overflowY !== 'visible') {
				top = Math.max(top, rect.top + ancestor.clientTop);
				bottom = Math.min(bottom, rect.top + ancestor.clientTop + ancestor.clientHeight);
			}
			ancestor = ancestor.parentElement;
		}
		const toolbar = pane.querySelector<HTMLElement>('.study-pdf-annotation-toolbar');
		if (toolbar) top = Math.max(top, toolbar.getBoundingClientRect().bottom);
		if (right <= left || bottom <= top) return [];
		const rects: OverlayRect[] = [];
		for (let index = 0; index < layers.length; index++) {
			const layer = layers[index]!;
			const layerRect = layer.getBoundingClientRect();
			if (layerRect.right <= left || layerRect.left >= right || layerRect.bottom <= top || layerRect.top >= bottom) continue;
			// A cross-page Range includes page wrappers and annotation UI. Restrict
			// each native subrange to one textLayer before asking WebKit for boxes.
			const visualRange = layers.length === 1 ? range : range.cloneRange();
			if (index > 0) visualRange.setStart(layer, 0);
			if (index < layers.length - 1) visualRange.setEnd(layer, layer.childNodes.length);
			// PDF.js moves its full-page endOfContent sentinel next to the native
			// anchor while handles move. It can sit between selected text spans:
			// split around it rather than truncating the selected text after it.
			const sentinel = layer.querySelector<HTMLElement>('.endOfContent');
			let nativeRanges = [visualRange];
			if (sentinel && visualRange.intersectsNode(sentinel)) {
				const before = visualRange.cloneRange();
				before.setEndBefore(sentinel);
				const after = visualRange.cloneRange();
				after.setStartAfter(sentinel);
				nativeRanges = [before, after];
			}
			for (const nativeRange of nativeRanges) {
				for (const rect of Array.from(nativeRange.getClientRects())) {
					const x = Math.max(left, layerRect.left, rect.left);
					const y = Math.max(top, layerRect.top, rect.top);
					const width = Math.min(right, layerRect.right, rect.right) - x;
					const height = Math.min(bottom, layerRect.bottom, rect.bottom) - y;
					if ([x, y, width, height].every(Number.isFinite) && width >= 1 && height >= 1) rects.push({ left: x, top: y, width, height });
				}
			}
		}
		return rects;
	} catch {
		// A detached native selection clears the optional preview only.
		return [];
	}
}

export function createSelectionOverlay(doc: Document): SelectionOverlay {
	const el = doc.body.createDiv({ cls: 'study-pdf-selection-overlay' });
	const elements: HTMLElement[] = [];
	const geometrySignatures: string[] = [];
	const colors: string[] = [];
	let disposed = false;
	return {
		update(rects: OverlayRect[], color?: string) {
			if (disposed) return;
			const normalized = normalizeOverlayRects(rects);
			while (elements.length > normalized.length) {
				elements.pop()!.remove();
				geometrySignatures.pop();
				colors.pop();
			}
			for (let index = 0; index < normalized.length; index++) {
				const rect = normalized[index]!;
				const rectEl = elements[index] ?? el.createDiv({ cls: 'study-pdf-selection-rect' });
				elements[index] = rectEl;
				const geometry = `${rect.left},${rect.top},${rect.width},${rect.height}`;
				if (geometrySignatures[index] !== geometry) {
					rectEl.setCssStyles({ left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px` });
					geometrySignatures[index] = geometry;
				}
				const nextColor = color ?? '';
				if (colors[index] !== nextColor) {
					rectEl.style.backgroundColor = nextColor;
					colors[index] = nextColor;
				}
			}
		},
		destroy() {
			disposed = true;
			elements.length = 0;
			geometrySignatures.length = 0;
			colors.length = 0;
			el.remove();
		},
	};
}
