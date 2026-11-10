import { positionPopup } from './icon-popup';
import { renderNoteMarkdown } from './note-markdown';

const OPEN_DELAY_MS = 150;
const CLOSE_DELAY_MS = 120;
const EDITOR_OPEN_EVENT = 'study-pdf-note-editor-open';
export const ANNOTATION_ACTIONS_OPEN_EVENT = 'study-pdf-annotation-actions-open';

interface HoverOwner {
	current: HoverBinding | null;
}

interface NoteHoverPreview {
	cancel(): void;
	refresh(): void;
	dispose(): void;
}

interface HoverBinding extends NoteHoverPreview {
	hide(): void;
}

const documentOwners = new WeakMap<Document, HoverOwner>();

function clearTimer(win: Window, timer: number): void {
	if (timer) win.clearTimeout(timer);
}

/** Show one delayed, mouse-only preview per document without taking focus. */
export function bindNoteHoverPreview(
	anchor: HTMLElement,
	layer: HTMLElement,
	getNote: () => string,
): NoteHoverPreview {
	const doc = anchor.ownerDocument;
	const win = doc.defaultView;
	if (!win) return { cancel: () => undefined, refresh: () => undefined, dispose: () => undefined };
	let owner = documentOwners.get(doc);
	if (!owner) {
		owner = { current: null };
		documentOwners.set(doc, owner);
	}
	let openTimer = 0;
	let closeTimer = 0;
	let preview: HTMLElement | null = null;
	let observer: MutationObserver | null = null;
	let watching = false;
	let disposed = false;

	const isAvailable = () => anchor.isConnected && layer.isConnected && layer.contains(anchor);
	const removePreview = () => {
		if (!preview) {
			if (owner?.current === binding) owner.current = null;
			return;
		}
		preview.removeEventListener('pointerenter', onPreviewEnter);
		preview.removeEventListener('pointerleave', onPreviewLeave);
		preview.remove();
		preview = null;
		if (owner?.current === binding) owner.current = null;
	};
	const stopWatching = () => {
		if (!watching) return;
		watching = false;
		doc.removeEventListener('scroll', onDocumentScroll, true);
		doc.removeEventListener(EDITOR_OPEN_EVENT, hide);
		doc.removeEventListener(ANNOTATION_ACTIONS_OPEN_EVENT, hide);
		win.removeEventListener('blur', onWindowBlur);
		win.removeEventListener('resize', hide);
		win.visualViewport?.removeEventListener('resize', hide);
		win.removeEventListener('pagehide', onWindowUnload);
		win.removeEventListener('unload', onWindowUnload);
		observer?.disconnect();
		observer = null;
	};
	const hide = () => {
		clearTimer(win, openTimer);
		clearTimer(win, closeTimer);
		openTimer = closeTimer = 0;
		stopWatching();
		removePreview();
	};
	const scheduleClose = () => {
		clearTimer(win, closeTimer);
		closeTimer = win.setTimeout(() => {
			closeTimer = 0;
			hide();
		}, CLOSE_DELAY_MS);
	};
	const onPreviewEnter = (event: PointerEvent) => {
		if (event.pointerType !== 'mouse' || event.buttons !== 0) return;
		clearTimer(win, closeTimer);
		closeTimer = 0;
	};
	const onPreviewLeave = (event: PointerEvent) => {
		if (event.pointerType !== 'mouse') return;
		if (event.relatedTarget === anchor) {
			clearTimer(win, closeTimer);
			closeTimer = 0;
			return;
		}
		scheduleClose();
	};
	const onAnchorEnter = (event: Event) => {
		const pointer = event as PointerEvent;
		if (disposed || pointer.pointerType !== 'mouse' || pointer.buttons !== 0 || !isAvailable()) return;
		clearTimer(win, closeTimer);
		clearTimer(win, openTimer);
		closeTimer = openTimer = 0;
		if (preview) return;
		startWatching();
		openTimer = win.setTimeout(() => {
			openTimer = 0;
			if (disposed || !isAvailable()) { hide(); return; }
			if (doc.querySelector('.study-pdf-note-editor') || doc.querySelector('.study-pdf-candidate-modal')) { hide(); return; }
			const note = getNote();
			if (!note.trim()) { hide(); return; }
			owner?.current?.hide();
			const card = doc.createElement('div');
			card.className = 'study-pdf-popup study-pdf-note-hover-preview';
			card.setAttribute('role', 'note');
			card.setAttribute('aria-label', 'Highlight note preview');
			renderNoteMarkdown(card, note);
			doc.body.appendChild(card);
			const rect = anchor.getBoundingClientRect();
			const viewportHeight = win.visualViewport?.height ?? win.innerHeight;
			positionPopup(doc, card, { x: rect.left, y: rect.bottom, aboveY: rect.top }, {
				width: 380,
				height: viewportHeight * 0.6,
			});
			preview = card;
			owner.current = binding;
			card.addEventListener('pointerenter', onPreviewEnter);
			card.addEventListener('pointerleave', onPreviewLeave);
		}, OPEN_DELAY_MS);
	};
	const onAnchorLeave = (event: Event) => {
		const pointer = event as PointerEvent;
		if (pointer.pointerType !== 'mouse') return;
		if (pointer.relatedTarget === preview) {
			clearTimer(win, closeTimer);
			closeTimer = 0;
			return;
		}
		clearTimer(win, openTimer);
		openTimer = 0;
		if (preview) scheduleClose();
		else hide();
	};
	const onPointerDown = () => binding.cancel();
	const onDocumentScroll = (event: Event) => {
		const target = event.target;
		if (preview && target && typeof target === 'object' && 'nodeType' in target && preview.contains(target as Node)) return;
		hide();
	};
	const onWindowBlur = () => hide();
	const onWindowUnload = () => hide();
	const startWatching = () => {
		if (watching) return;
		watching = true;
		doc.addEventListener('scroll', onDocumentScroll, true);
		doc.addEventListener(EDITOR_OPEN_EVENT, hide);
		doc.addEventListener(ANNOTATION_ACTIONS_OPEN_EVENT, hide);
		win.addEventListener('blur', onWindowBlur);
		win.addEventListener('resize', hide);
		win.visualViewport?.addEventListener('resize', hide);
		win.addEventListener('pagehide', onWindowUnload);
		win.addEventListener('unload', onWindowUnload);
		const Observer = win.MutationObserver;
		if (!Observer) return;
		observer = new Observer(() => {
			if (!isAvailable()) hide();
		});
		observer.observe(layer, { childList: true, subtree: true });
	};
	const binding: HoverBinding = {
		hide,
		cancel() {
			if (owner?.current) owner.current.hide();
			hide();
		},
		refresh: hide,
		dispose() {
			if (disposed) return;
			disposed = true;
			hide();
			anchor.removeEventListener('pointerenter', onAnchorEnter);
			anchor.removeEventListener('pointerleave', onAnchorLeave);
			anchor.removeEventListener('pointerdown', onPointerDown);
		},
	};

	anchor.addEventListener('pointerenter', onAnchorEnter);
	anchor.addEventListener('pointerleave', onAnchorLeave);
	anchor.addEventListener('pointerdown', onPointerDown);
	return binding;
}
