import { normalizeOverlayRects } from './selection-overlay';
import type { PageLocalRect } from '../geometry';

/** Paint new highlights immediately; the saved PDF replaces this preview. */
export function showHighlightPreview(
	pageElement: HTMLElement,
	rects: readonly PageLocalRect[],
	color: string,
	expandTop: number,
	expandBottom: number,
): { dispose(): void } {
	const doc = pageElement.ownerDocument;
	const bounds = pageElement.getBoundingClientRect();
	const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
	svg.setAttribute('class', 'study-pdf-highlight-preview');
	svg.setAttribute('viewBox', `0 0 ${bounds.width} ${bounds.height}`);
	svg.setAttribute('preserveAspectRatio', 'none');
	svg.setAttribute('aria-hidden', 'true');
	for (const rect of normalizeOverlayRects(rects.map((r) => ({
		left: r.left, top: r.top - (r.bottom - r.top) * expandTop,
		width: r.right - r.left, height: (r.bottom - r.top) * (1 + expandTop + expandBottom),
	})))) {
		const element = doc.createElementNS('http://www.w3.org/2000/svg', 'rect');
		for (const [name, value] of Object.entries({ x: rect.left, y: rect.top, width: rect.width, height: rect.height, fill: color })) {
			element.setAttribute(name, String(value));
		}
		svg.append(element);
	}
	// Obsidian renders the text layer at 20% opacity. Keep the preview on the
	// containing page so its colour immediately matches the saved annotation.
	const previewParent = pageElement.classList.contains('textLayer')
		? pageElement.parentElement ?? pageElement
		: pageElement;
	previewParent.append(svg);
	return { dispose: () => svg.remove() };
}

/** Let the immediate preview paint before PDF parsing can occupy the UI thread. */
export function letPreviewPaint(
	doc: Document,
	signal?: AbortSignal,
	fallbackWindow: Window | null = typeof window === 'undefined' ? null : window,
): Promise<void> {
	const win = doc.defaultView;
	if (signal?.aborted) return Promise.reject(createPreviewAbortError());
	if (!win || doc.visibilityState === 'hidden') return Promise.resolve();
	if (isWindowClosed(win)) return Promise.reject(createPreviewAbortError());
	if (!fallbackWindow || isWindowClosed(fallbackWindow)) return Promise.resolve();
	return new Promise((resolve, reject) => {
		let settled = false;
		let frame = 0;
		let timeout = 0;
		let paintTimeout = 0;
		const cleanup = () => {
			try { fallbackWindow.clearTimeout(timeout); } catch { /* The host window may already be closing. */ }
			try { fallbackWindow.clearTimeout(paintTimeout); } catch { /* The host window may already be closing. */ }
			try { win.cancelAnimationFrame(frame); } catch { /* The owner window may already be closing. */ }
			try { win.removeEventListener('pagehide', cancel); } catch { /* The owner window may already be closing. */ }
			try { win.removeEventListener('beforeunload', cancel); } catch { /* The owner window may already be closing. */ }
			if (fallbackWindow !== win) {
				try { fallbackWindow.removeEventListener('pagehide', cancel); } catch { /* The host window may already be closing. */ }
				try { fallbackWindow.removeEventListener('beforeunload', cancel); } catch { /* The host window may already be closing. */ }
			}
			try { signal?.removeEventListener('abort', cancel); } catch { /* The action may already be settled. */ }
		};
		const finish = (cancelled: boolean) => {
			if (settled) return;
			settled = true;
			try {
				cleanup();
			} finally {
				if (cancelled || isWindowClosed(win)) reject(createPreviewAbortError());
				else resolve();
			}
		};
		const cancel = () => finish(true);
		const finishAfterPaint = () => {
			// A popout can close without its animation-frame callback running.
			// The surviving main-window fallback will still finish the action.
			if (isWindowClosed(win)) finish(true);
			else finish(false);
		};
		try {
			win.addEventListener('pagehide', cancel, { once: true });
			win.addEventListener('beforeunload', cancel, { once: true });
			if (fallbackWindow !== win) {
				fallbackWindow.addEventListener('pagehide', cancel, { once: true });
				fallbackWindow.addEventListener('beforeunload', cancel, { once: true });
			}
			signal?.addEventListener('abort', cancel, { once: true });
			if (signal?.aborted) {
				cancel();
				return;
			}
			timeout = fallbackWindow.setTimeout(finishAfterPaint, 80);
			frame = win.requestAnimationFrame(() => {
				paintTimeout = fallbackWindow.setTimeout(finishAfterPaint, 0);
			});
		} catch {
			finish(true);
		}
	});
}

function isWindowClosed(win: Window): boolean {
	try { return win.closed; } catch { return true; }
}

function createPreviewAbortError(): Error {
	const error = new Error('The PDF preview was cancelled before it could be saved.');
	error.name = 'AbortError';
	return error;
}
