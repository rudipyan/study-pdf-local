// Compact horizontal icon popup (color dots / trash), replacing Obsidian's
// vertical text Menu for the in-PDF actions. Styled exclusively with Obsidian
// CSS variables + the `clickable-icon` class (see styles.css), so it inherits
// the active theme's colors -- the failure mode of the first custom popup
// (hardcoded colors, unreadable in dark themes) can't recur.
import { Scope, setIcon, setTooltip, type App } from 'obsidian';
import { popupMaxSize } from '../palette-editor';

export type PopupButton =
	| { type: 'color'; hex: string; name: string; onClick: () => void }
	| { type: 'icon'; icon: string; label: string; onClick: () => void };

export interface IconPopup {
	el: HTMLElement;
	/** Repositions the popup after viewport movement. */
	reposition(): void;
	/** Candidate chooser remains open while the visual viewport moves. */
	preserveOnScroll?: boolean;
	hide(): void;
}

/** Clamp into the viewport after layout so the popup never overflows an edge.
 * `el` must already be attached to the DOM: Obsidian's createDiv/createEl
 * attach as part of creation (unlike document.createElement, which returns a
 * detached node), so by the time an element exists here, it's already in the
 * tree -- this only positions it. */
export function positionPopup(doc: Document, el: HTMLElement, position: { x: number; y: number }) {
	const win = doc.defaultView ?? window;
	// visualViewport shrinks when the on-screen keyboard opens (e.g. for the
	// note editor's textarea); innerWidth/innerHeight don't, so clamping
	// against those alone could place the popup behind the keyboard.
	const viewport = win.visualViewport;
	const viewportLeft = viewport?.offsetLeft ?? 0;
	const viewportTop = viewport?.offsetTop ?? 0;
	const viewportWidth = viewport?.width ?? win.innerWidth;
	const viewportHeight = viewport?.height ?? win.innerHeight;
	const maxSize = popupMaxSize({ width: viewportWidth, height: viewportHeight });
	el.setCssStyles({
		left: '0px',
		top: '0px',
		maxWidth: `${maxSize.width}px`,
		maxHeight: `${maxSize.height}px`,
		boxSizing: 'border-box',
		overflowY: 'auto',
	});
	const { width, height } = el.getBoundingClientRect();
	el.setCssStyles({
		left: `${Math.max(viewportLeft + 4, Math.min(position.x + viewportLeft, viewportLeft + viewportWidth - width - 4))}px`,
		top: `${Math.max(viewportTop + 4, Math.min(position.y + viewportTop, viewportTop + viewportHeight - height - 4))}px`,
	});
}

export function trackPopupPosition(
	doc: Document,
	el: HTMLElement,
	position: { x: number; y: number },
): () => void {
	const win = doc.defaultView ?? window;
	const update = () => positionPopup(doc, el, position);
	const viewport = win.visualViewport;
	win.addEventListener('resize', update);
	win.addEventListener('scroll', update, true);
	doc.addEventListener('scroll', update, true);
	viewport?.addEventListener('resize', update);
	viewport?.addEventListener('scroll', update);
	return () => {
		win.removeEventListener('resize', update);
		win.removeEventListener('scroll', update, true);
		doc.removeEventListener('scroll', update, true);
		viewport?.removeEventListener('resize', update);
		viewport?.removeEventListener('scroll', update);
	};
}

export function showIconPopup(
	doc: Document,
	position: { x: number; y: number },
	buttons: PopupButton[],
	options: { text?: string; onDismiss?: () => void; preserveOnScroll?: boolean } = {},
): IconPopup {
	const el = doc.body.createDiv({ cls: 'study-pdf-popup' });
	el.tabIndex = -1;

	// Buttons act on the current text selection; without this, mousedown on the
	// popup itself would collapse that selection before the click ever lands.
	el.addEventListener('mousedown', (evt) => evt.preventDefault());

	if (options.text) {
		el.createDiv({ cls: 'study-pdf-popup-note', text: options.text });
	}

	const row = el.createDiv({ cls: 'study-pdf-popup-row' });
	for (const button of buttons) {
		const btnEl = row.createEl('button', { cls: 'clickable-icon' });
		if (button.type === 'color') {
			const dot = btnEl.createSpan({ cls: 'study-pdf-color-dot' });
			dot.setCssStyles({ backgroundColor: button.hex });
			setTooltip(btnEl, button.name);
			btnEl.setAttribute('aria-label', button.name);
		} else {
			setIcon(btnEl, button.icon);
			setTooltip(btnEl, button.label);
		}
		btnEl.addEventListener('click', button.onClick);
	}

	positionPopup(doc, el, position);
	const stopPositionTracking = trackPopupPosition(doc, el, position);
	let closed = false;
	const onKeyDown = (evt: KeyboardEvent) => {
		if (evt.key !== 'Escape') return;
		evt.preventDefault();
		hide();
	};
	const hide = () => {
		if (closed) return;
		closed = true;
		stopPositionTracking();
		doc.removeEventListener('keydown', onKeyDown);
		el.remove();
		options.onDismiss?.();
	};
	// Keep focus on the PDF so Shift+arrows and continued selection still work.
	doc.addEventListener('keydown', onKeyDown);

	return {
		el,
		reposition: () => positionPopup(doc, el, position),
		preserveOnScroll: options.preserveOnScroll,
		hide,
	};
}

/** Small note editor popup: a textarea prefilled with the current note, plus
 * save/cancel icons. Enter saves (Shift+Enter for a newline), Escape cancels.
 * No mousedown preventDefault here -- the textarea needs real focus/clicks. */
export function showNoteEditorPopup(
	app: App,
	doc: Document,
	position: { x: number; y: number },
	options: {
		initial: string;
		onSave: (note: string) => void | boolean | Promise<void | boolean>;
		onSaved?: () => void;
		onCancel: () => void;
	},
): IconPopup {
	const el = doc.body.createDiv({ cls: 'study-pdf-popup' });
	el.tabIndex = -1;
	let closed = false;
	let composing = false;
	let pending = false;
	let savedCloseTimer = 0;

	// createEl's `value` option only reflects for <input> elements, not
	// <textarea> -- set it directly so an existing note is pre-filled.
	const input = el.createEl('textarea', {
		cls: 'study-pdf-note-input',
		placeholder: 'Note…',
	});
	input.setAttribute('aria-label', 'Highlight note');
	input.value = options.initial;

	const row = el.createDiv({ cls: 'study-pdf-popup-row' });
	const status = row.createSpan({ cls: 'study-pdf-note-status' });
	status.setAttribute('aria-live', 'polite');
	const setStatus = (state: 'idle' | 'pending' | 'saved' | 'failed') => {
		status.empty();
		status.removeAttribute('data-state');
		if (state === 'idle') return;
		status.setAttribute('data-state', state);
		setIcon(status, state === 'pending' ? 'loader-circle' : state === 'saved' ? 'check' : 'circle-alert');
		status.setAttribute('aria-label', state === 'pending' ? 'Saving draft' : state === 'saved' ? 'Draft saved' : 'Save failed. Draft retained.');
	};
	const makeButton = (icon: string, label: string, onClick: () => void) => {
		const btnEl = row.createEl('button', { cls: 'clickable-icon' });
		setIcon(btnEl, icon);
		setTooltip(btnEl, label);
		btnEl.setAttribute('aria-label', label);
		btnEl.addEventListener('click', onClick);
		return btnEl;
	};
	const saveButton = makeButton('check', 'Save note', () => { void submit(); });
	const cancelButton = makeButton('x', 'Cancel', options.onCancel);
	const updateStatus = (state: 'idle' | 'pending' | 'saved' | 'failed') => {
		setStatus(state);
		saveButton.disabled = state === 'pending' || state === 'saved';
		cancelButton.disabled = state === 'pending' || state === 'saved';
		input.disabled = state === 'pending';
	};
	const submit = async () => {
		if (pending || closed) return;
		pending = true;
		updateStatus('pending');
		try {
			const result = await options.onSave(input.value);
			if (closed) return;
			if (result === false) updateStatus('failed');
			else {
				updateStatus('saved');
				const win = doc.defaultView;
				if (win) savedCloseTimer = win.setTimeout(() => { if (!closed) options.onSaved?.(); }, 350);
			}
		} catch {
			if (!closed) updateStatus('failed');
		} finally {
			pending = false;
			if (!closed && status.getAttribute('data-state') !== 'failed' && status.getAttribute('data-state') !== 'saved') {
				saveButton.disabled = false;
				cancelButton.disabled = false;
			}
		}
	};

	input.addEventListener('compositionstart', () => { composing = true; });
	input.addEventListener('compositionend', () => { composing = false; });
	input.addEventListener('input', () => {
		const state = status.getAttribute('data-state');
		if (state === 'failed' || state === 'saved') {
			if (savedCloseTimer) doc.defaultView?.clearTimeout(savedCloseTimer);
			savedCloseTimer = 0;
			updateStatus('idle');
		}
	});
	input.addEventListener('keydown', (evt) => {
		if (evt.isComposing || composing || evt.keyCode === 229) return;
		if (evt.key === 'Enter' && !evt.shiftKey) {
			evt.preventDefault();
			void submit();
		}
	});
	const onKeyDown = (evt: KeyboardEvent) => {
		if (evt.key !== 'Escape' || evt.isComposing || composing || evt.keyCode === 229 || pending) return;
		evt.preventDefault();
		options.onCancel();
	};
	el.addEventListener('keydown', onKeyDown);

	// Obsidian's PDF view owns bare ArrowLeft/ArrowRight through its own Scope
	// (previous/next page) and takes them regardless of what has focus, so
	// pressing left or right inside this textarea turned the page instead of
	// moving the caret. Verified on the live view: with a PDF leaf active, an
	// ArrowLeft in a focused textarea arrives already defaultPrevented, from a
	// listener above anything we can register -- so stopPropagation on the
	// textarea cannot help, and only a keymap scope can.
	//
	// A scope pushed here sits below the view's, so it sees the key first;
	// returning a non-false value means "handled, but don't preventDefault",
	// which stops the view from paging and leaves the browser's own caret
	// movement intact. (Returning false would suppress the caret too.) Only
	// unmodified arrows are bound by the view, so Shift/Alt/Cmd combinations
	// still reach the textarea untouched.
	const scope = new Scope();
	scope.register([], 'ArrowLeft', () => true);
	scope.register([], 'ArrowRight', () => true);
	app.keymap.pushScope(scope);

	positionPopup(doc, el, position);
	const stopPositionTracking = trackPopupPosition(doc, el, position);
	input.focus();

	return {
		el,
		reposition: () => positionPopup(doc, el, position),
		hide() {
			if (closed) return;
			closed = true;
			if (savedCloseTimer) doc.defaultView?.clearTimeout(savedCloseTimer);
			stopPositionTracking();
			el.removeEventListener('keydown', onKeyDown);
			app.keymap.popScope(scope);
			el.remove();
		},
	};
}
