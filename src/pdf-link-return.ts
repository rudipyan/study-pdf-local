import { setIcon } from 'obsidian';
import { acquirePdfOverlayHostPositioning } from './ui/pdf-overlay-host';
import type { ActivePdfView, PdfReturnPosition } from './obsidian-pdf-internals';

export interface PdfLinkReturnController {
	isCurrent(): boolean;
	dispose(): void;
}

const BUTTON_CLASS = 'clickable-icon study-pdf-link-return';
const MAX_RETURN_POSITIONS = 20;
const EVENTS_TO_STOP = [
	'pointerdown', 'pointerup', 'pointermove', 'pointercancel',
	'mousedown', 'mouseup', 'mousemove',
	'touchstart', 'touchmove', 'touchend', 'touchcancel',
	'keydown', 'keyup', 'dblclick',
];

/** Adds a small, per-view return control for successful native internal links. */
export function createPdfLinkReturn(view: ActivePdfView): PdfLinkReturnController {
	const host = view.getPdfScrollHostElement();
	const ownerDocument = view.containerEl.ownerDocument;
	const positions: PdfReturnPosition[] = [];
	let button: HTMLButtonElement | null = null;
	let watcher: ReturnType<NonNullable<ActivePdfView['watchInternalNavigation']>> | undefined;
	let releaseHostPositioning: (() => void) | null = null;
	let disposed = false;
	let restoring = false;
	const eventListeners: Array<[string, EventListener]> = [];

	const isCurrent = (): boolean => {
		if (disposed || !watcher || !button || !host) return false;
		try {
			if (button.parentElement !== host || view.getPdfScrollHostElement() !== host ||
				!view.containerEl.contains(host)) return false;
			return watcher.isCurrent();
		} catch {
			return false;
		}
	};

	const updateVisibility = (): void => {
		if (button) button.hidden = positions.length === 0;
	};

	const returnToPreviousPosition = (): void => {
		if (!isCurrent()) {
			positions.length = 0;
			updateVisibility();
			return;
		}
		while (positions.length > 0) {
			const position = positions.pop();
			if (!position) continue;
			restoring = true;
			let restored = false;
			try {
				restored = watcher!.restore(position);
			} catch {
				// A stale position should not interfere with native PDF navigation.
			} finally {
				restoring = false;
			}
			if (restored) break;
		}
		updateVisibility();
	};

	const onClick = (event: MouseEvent): void => {
		event.stopPropagation();
		returnToPreviousPosition();
	};
	const stopPropagation = (event: Event): void => event.stopPropagation();

	const hasMountPoint = !!host && host.ownerDocument === ownerDocument && view.containerEl.contains(host);
	if (hasMountPoint) {
		try {
			watcher = view.watchInternalNavigation?.((position) => {
				if (disposed || restoring || !isCurrent()) return;
				positions.push(position);
				if (positions.length > MAX_RETURN_POSITIONS) {
					positions.splice(0, positions.length - MAX_RETURN_POSITIONS);
				}
				updateVisibility();
			});
		} catch {
			// A missing native hook disables only the return control.
		}
	}

	if (watcher && host && hasMountPoint) {
		releaseHostPositioning = acquirePdfOverlayHostPositioning(host);
		button = ownerDocument.createElement('button');
		button.type = 'button';
		button.className = BUTTON_CLASS;
		button.hidden = true;
		button.title = 'Back to previous reading position';
		button.setAttribute('aria-label', 'Back to previous reading position');
		setIcon(button, 'arrow-left');
		for (const eventName of EVENTS_TO_STOP) {
			button.addEventListener(eventName, stopPropagation);
			eventListeners.push([eventName, stopPropagation]);
		}
		button.addEventListener('click', stopPropagation);
		eventListeners.push(['click', stopPropagation]);
		button.addEventListener('click', onClick);
		host.append(button);
	}

	return {
		isCurrent,
		dispose(): void {
			if (disposed) return;
			disposed = true;
			positions.length = 0;
			for (const [eventName, listener] of eventListeners) {
				button?.removeEventListener(eventName, listener);
			}
			eventListeners.length = 0;
			button?.removeEventListener('click', onClick);
			button?.remove();
			button = null;
			releaseHostPositioning?.();
			releaseHostPositioning = null;
			try {
				watcher?.dispose();
			} catch {
				// UI cleanup is complete even if the native observer is already stale.
			}
		},
	};
}
