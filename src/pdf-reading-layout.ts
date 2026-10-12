/** Keeps horizontal touch drift out of a PDF viewport while its visible pages
 * fit. It samples the top, center, and bottom of the viewport and checks a
 * bounded neighborhood around those pages, never scanning the whole PDF. */
export interface PdfReadingLayoutView {
	containerEl: HTMLElement;
	getPdfScrollElement(): HTMLElement | null;
	getPdfScrollHostElement(): HTMLElement | null;
	getCurrentPageNumber(): number;
	getPageCount(): number;
	getRenderedPageElement(pageIndex: number): HTMLElement | null;
	getPageIndexAtPoint(clientX: number, clientY: number): number | null;
	getPageContainerElement(): HTMLElement | null;
}

export interface PdfReadingLayoutController {
	updateView(view: PdfReadingLayoutView): void;
	refresh(): void;
	dispose(): void;
}

const HORIZONTAL_STABLE_CLASS = 'study-pdf-horizontal-scroll-stable';
const PAGE_WIDTH_TOLERANCE_PX = 2;

export function createPdfReadingLayout(initialView: PdfReadingLayoutView): PdfReadingLayoutController {
	let view = initialView;
	let scrollEl: HTMLElement | null = null;
	let frameId: number | null = null;
	let secondPinchFrameId: number | null = null;
	let disposed = false;
	let touchPinchActive = false;
	let pointerPinchActive = false;
	const touchPointerIds = new Set<number>();
	let observedPages = new Set<HTMLElement>();
	let observedPageContainer: HTMLElement | null = null;
	let observedScrollParent: HTMLElement | null = null;
	const ownerWindow = initialView.containerEl.ownerDocument.defaultView;
	const ResizeObserverConstructor = ownerWindow?.ResizeObserver;
	const MutationObserverConstructor = ownerWindow?.MutationObserver;
	const resizeObserver = ResizeObserverConstructor
		? new ResizeObserverConstructor(() => scheduleRefresh())
		: null;
	let attachScrollElement: (next: HTMLElement | null) => void = () => {};
	let observePageContainer: () => void = () => {};
	let observeScrollParent: () => void = () => {};
	const mutationObserver = MutationObserverConstructor
		? new MutationObserverConstructor(() => {
			observePageContainer();
			scheduleRefresh();
		})
		: null;
	const scrollParentObserver = MutationObserverConstructor
		? new MutationObserverConstructor(() => {
			const nextScrollEl = view.getPdfScrollElement();
			if (nextScrollEl !== scrollEl) attachScrollElement(nextScrollEl);
			else {
				observePageContainer();
				scheduleRefresh();
			}
		})
		: null;

	const setHorizontalLock = (locked: boolean) => {
		if (!scrollEl) return;
		const wasLocked = scrollEl.classList.contains(HORIZONTAL_STABLE_CLASS);
		if (locked === wasLocked) return;
		scrollEl.classList.toggle(HORIZONTAL_STABLE_CLASS, locked);
		// A prior wide page can leave a horizontal offset behind. Return to the
		// left edge only once when entering the fit state; never reset during a
		// normal vertical scroll.
		if (locked && scrollEl.scrollLeft !== 0) scrollEl.scrollLeft = 0;
	};

	const visiblePages = (): HTMLElement[] => {
		if (!scrollEl) return [];
		const viewport = scrollEl.getBoundingClientRect();
		const centerX = viewport.left + scrollEl.clientLeft + scrollEl.clientWidth / 2;
		const contentTop = viewport.top + scrollEl.clientTop;
		const contentHeight = scrollEl.clientHeight;
		const inset = Math.min(12, contentHeight / 4);
		const sampledPageIndexes = [
			view.getPageIndexAtPoint(centerX, contentTop + inset),
			view.getPageIndexAtPoint(centerX, contentTop + contentHeight / 2),
			view.getPageIndexAtPoint(centerX, contentTop + contentHeight - inset),
		].filter((index): index is number => index !== null && index >= 0);
		const currentPageNumber = view.getCurrentPageNumber();
		const anchors = new Set([
			currentPageNumber,
			...sampledPageIndexes.map((index) => index + 1),
		].filter((n) => Number.isInteger(n) && n > 0));
		if (anchors.size === 0) return [];
		const pageCount = view.getPageCount();
		const numbers = new Set<number>();
		for (const anchor of anchors) {
			for (const number of [anchor - 1, anchor, anchor + 1]) {
				if (number > 0 && (pageCount <= 0 || number <= pageCount)) numbers.add(number);
			}
		}
		const pages: HTMLElement[] = [];
		for (const number of numbers) {
			const page = view.getRenderedPageElement(number - 1);
			if (!page || pages.includes(page)) continue;
			const rect = page.getBoundingClientRect();
			if (rect.bottom > viewport.top && rect.top < viewport.bottom) pages.push(page);
		}
		return pages;
	};

	const visibleHorizontalBounds = (): { left: number; right: number } | null => {
		if (!scrollEl) return null;
		const rect = scrollEl.getBoundingClientRect();
		let left = rect.left + scrollEl.clientLeft;
		let right = left + scrollEl.clientWidth;
		if (ownerWindow) {
			left = Math.max(left, 0);
			right = Math.min(right, ownerWindow.innerWidth);
		}
		let ancestor = scrollEl.parentElement;
		while (ancestor && ancestor !== scrollEl.ownerDocument.documentElement) {
			const overflowX = ownerWindow?.getComputedStyle(ancestor).overflowX;
			if (overflowX && overflowX !== 'visible') {
				const ancestorRect = ancestor.getBoundingClientRect();
				left = Math.max(left, ancestorRect.left + ancestor.clientLeft);
				right = Math.min(right, ancestorRect.left + ancestor.clientLeft + ancestor.clientWidth);
			}
			ancestor = ancestor.parentElement;
		}
		return right > left ? { left, right } : null;
	};

	const observeVisiblePages = (pages: HTMLElement[]) => {
		if (!resizeObserver) return;
		if (pages.length === observedPages.size && pages.every((page) => observedPages.has(page))) return;
		for (const page of observedPages) resizeObserver.unobserve(page);
		observedPages = new Set(pages);
		for (const page of observedPages) resizeObserver.observe(page);
	};

	observePageContainer = () => {
		if (!mutationObserver || !scrollEl) return;
		const next = view.getPageContainerElement();
		if (next === observedPageContainer) return;
		mutationObserver.disconnect();
		mutationObserver.observe(scrollEl, { childList: true });
		observedPageContainer = next;
		if (observedPageContainer) mutationObserver.observe(observedPageContainer, { childList: true });
	};

	observeScrollParent = () => {
		if (!scrollParentObserver) return;
		const next = view.getPdfScrollHostElement();
		if (next === observedScrollParent) return;
		scrollParentObserver.disconnect();
		observedScrollParent = next;
		if (observedScrollParent) scrollParentObserver.observe(observedScrollParent, { childList: true });
	};

	const refreshNow = () => {
		if (disposed || !scrollEl) return;
		const pages = visiblePages();
		observeVisiblePages(pages);
		const bounds = visibleHorizontalBounds();
		if (pointerPinchActive || touchPinchActive || pages.length === 0 || !bounds) {
			setHorizontalLock(false);
			return;
		}
		const rects = pages.map((page) => page.getBoundingClientRect());
		const left = Math.min(...rects.map((rect) => rect.left));
		const right = Math.max(...rects.map((rect) => rect.right));
		const fits = right - left <= bounds.right - bounds.left + PAGE_WIDTH_TOLERANCE_PX &&
			left >= bounds.left - PAGE_WIDTH_TOLERANCE_PX && right <= bounds.right + PAGE_WIDTH_TOLERANCE_PX;
		setHorizontalLock(fits);
	};

	const scheduleRefresh = () => {
		if (disposed || frameId !== null) return;
		if (!ownerWindow) {
			refreshNow();
			return;
		}
		frameId = ownerWindow.requestAnimationFrame(() => {
			frameId = null;
			refreshNow();
		});
	};

	const schedulePinchRecheck = () => {
		if (!ownerWindow || disposed || secondPinchFrameId !== null) {
			scheduleRefresh();
			return;
		}
		const firstFrame = ownerWindow.requestAnimationFrame(() => {
			secondPinchFrameId = ownerWindow.requestAnimationFrame(() => {
				secondPinchFrameId = null;
				pointerPinchActive = touchPointerIds.size > 1;
				if (!pointerPinchActive && !touchPinchActive) scheduleRefresh();
			});
		});
		secondPinchFrameId = firstFrame;
	};

	const onScroll = () => scheduleRefresh();
	const onPointerDown = (event: PointerEvent) => {
		if (event.pointerType !== 'touch') return;
		touchPointerIds.add(event.pointerId);
		if (touchPointerIds.size > 1) {
			pointerPinchActive = true;
			setHorizontalLock(false);
		}
	};
	const onPointerEnd = (event: PointerEvent) => {
		if (event.pointerType !== 'touch') return;
		touchPointerIds.delete(event.pointerId);
		if (touchPointerIds.size <= 1) schedulePinchRecheck();
	};
	const onTouchStart = (event: TouchEvent) => {
		if (event.touches.length > 1) {
			touchPinchActive = true;
			setHorizontalLock(false);
		}
	};
	const onTouchEnd = (event: TouchEvent) => {
		if (event.touches.length <= 1) {
			touchPinchActive = false;
			schedulePinchRecheck();
		}
	};
	const onResize = () => scheduleRefresh();

	attachScrollElement = (next: HTMLElement | null) => {
		if (scrollEl === next) return;
		if (secondPinchFrameId !== null) ownerWindow?.cancelAnimationFrame(secondPinchFrameId);
		secondPinchFrameId = null;
		touchPointerIds.clear();
		pointerPinchActive = false;
		touchPinchActive = false;
		if (scrollEl) {
			scrollEl.classList.remove(HORIZONTAL_STABLE_CLASS);
			scrollEl.removeEventListener('scroll', onScroll);
			scrollEl.removeEventListener('pointerdown', onPointerDown);
			scrollEl.removeEventListener('pointerup', onPointerEnd);
			scrollEl.removeEventListener('pointercancel', onPointerEnd);
			scrollEl.removeEventListener('touchstart', onTouchStart);
			scrollEl.removeEventListener('touchend', onTouchEnd);
			scrollEl.removeEventListener('touchcancel', onTouchEnd);
		}
		resizeObserver?.disconnect();
		mutationObserver?.disconnect();
		observedPages.clear();
		observedPageContainer = null;
		scrollEl = next;
		observeScrollParent();
		if (!scrollEl) return;
		scrollEl.addEventListener('scroll', onScroll, { passive: true });
		scrollEl.addEventListener('pointerdown', onPointerDown, { passive: true });
		scrollEl.addEventListener('pointerup', onPointerEnd, { passive: true });
		scrollEl.addEventListener('pointercancel', onPointerEnd, { passive: true });
		scrollEl.addEventListener('touchstart', onTouchStart, { passive: true });
		scrollEl.addEventListener('touchend', onTouchEnd, { passive: true });
		scrollEl.addEventListener('touchcancel', onTouchEnd, { passive: true });
		resizeObserver?.observe(scrollEl);
		let ancestor = scrollEl.parentElement;
		while (ancestor && ancestor !== scrollEl.ownerDocument.documentElement) {
			resizeObserver?.observe(ancestor);
			ancestor = ancestor.parentElement;
		}
		mutationObserver?.observe(scrollEl, { childList: true });
		observePageContainer();
	};

	ownerWindow?.addEventListener('resize', onResize, { passive: true });
	attachScrollElement(view.getPdfScrollElement());
	scheduleRefresh();

	return {
		updateView(nextView) {
			view = nextView;
			attachScrollElement(nextView.getPdfScrollElement());
			scheduleRefresh();
		},
		refresh: scheduleRefresh,
		dispose() {
			if (disposed) return;
			disposed = true;
			if (frameId !== null) ownerWindow?.cancelAnimationFrame(frameId);
			if (secondPinchFrameId !== null) ownerWindow?.cancelAnimationFrame(secondPinchFrameId);
			frameId = null;
			secondPinchFrameId = null;
			ownerWindow?.removeEventListener('resize', onResize);
			attachScrollElement(null);
			scrollParentObserver?.disconnect();
			resizeObserver?.disconnect();
			mutationObserver?.disconnect();
			observedPages.clear();
			touchPointerIds.clear();
		},
	};
}
