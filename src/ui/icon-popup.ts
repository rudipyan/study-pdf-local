// Compact horizontal icon popup (color dots / trash), replacing Obsidian's
// vertical text Menu for the in-PDF actions. Styled exclusively with Obsidian
// CSS variables + the `clickable-icon` class (see styles.css), so it inherits
// the active theme's colors -- the failure mode of the first custom popup
// (hardcoded colors, unreadable in dark themes) can't recur.
import { Scope, setIcon, setTooltip, type App } from 'obsidian';
import { popupMaxSize } from '../palette-editor';
import { bindPopupDragging } from './popup-drag';
import { bindAutoNoteSize, countNoteWords, NOTE_WORD_LIMIT } from './note-editor-size';
import { bindNoteDictation } from './note-dictation';
import { createNoteFormattingControls } from './note-formatting-controls';

let nextNoteCounterId = 0;

export type PopupButton =
	| { type: 'color'; hex: string; name: string; onClick: () => void }
	| { type: 'icon'; icon: string; label: string; onClick: () => void };

export interface IconPopup {
	el: HTMLElement;
	/** Schedules one coalesced reposition after viewport movement. */
	reposition(): void;
	/** Candidate chooser remains open while the visual viewport moves. */
	preserveOnScroll?: boolean;
	/** A host microphone permission prompt may temporarily take window focus. */
	readonly preserveOnBlur?: boolean;
	hide(): void;
}

export interface PopupPositioning {
	/** Coalesces event-driven positioning and optional layout work into one frame. */
	schedule(beforePosition?: () => void, afterPosition?: () => void): void;
	/** Applies layout and positioning immediately, canceling a pending frame. */
	reposition(beforePosition?: () => void, afterPosition?: () => void): void;
	dispose(): void;
}

export interface PopupAnchor {
	x: number;
	y: number;
	/** Bottom edge to use when there is room above the anchor instead. */
	aboveY?: number;
}

/** Clamp into the viewport after layout so the popup never overflows an edge.
 * `el` must already be attached to the DOM: Obsidian's createDiv/createEl
 * attach as part of creation (unlike document.createElement, which returns a
 * detached node), so by the time an element exists here, it's already in the
 * tree -- this only positions it. */
export function positionPopup(doc: Document, el: HTMLElement, position: PopupAnchor, limits?: { width: number; height: number }) {
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
	const setStyleIfChanged = (property: 'left' | 'top' | 'maxWidth' | 'maxHeight' | 'boxSizing' | 'overflowY', value: string) => {
		if (el.style[property] !== value) el.style[property] = value;
	};
	setStyleIfChanged('maxWidth', `${Math.min(maxSize.width, limits?.width ?? Infinity)}px`);
	setStyleIfChanged('maxHeight', `${Math.min(maxSize.height, limits?.height ?? Infinity)}px`);
	setStyleIfChanged('boxSizing', 'border-box');
	setStyleIfChanged('overflowY', 'auto');
	const { width, height } = el.getBoundingClientRect();
	setStyleIfChanged('left', `${Math.max(viewportLeft + 4, Math.min(position.x + viewportLeft, viewportLeft + viewportWidth - width - 4))}px`);
	const bottomAlignedTop = viewportHeight - height - 4;
	const above = position.aboveY === undefined ? -Infinity : position.aboveY - height;
	const top = position.y > bottomAlignedTop && above >= 4 ? above : position.y;
	setStyleIfChanged('top', `${viewportTop + Math.max(4, Math.min(top, bottomAlignedTop))}px`);
}

export function trackPopupPosition(
	doc: Document,
	el: HTMLElement,
	position: PopupAnchor,
): PopupPositioning {
	const win = doc.defaultView ?? window;
	const viewport = win.visualViewport;
	let disposed = false;
	let frame = 0;
	const beforeCallbacks = new Set<() => void>();
	const afterCallbacks = new Set<() => void>();
	const run = () => {
		frame = 0;
		if (disposed) return;
		for (const callback of beforeCallbacks) callback();
		beforeCallbacks.clear();
		if (el.isConnected) positionPopup(doc, el, position);
		for (const callback of afterCallbacks) callback();
		afterCallbacks.clear();
	};
	const schedule = (beforePosition?: () => void, afterPosition?: () => void) => {
		if (disposed) return;
		if (beforePosition) beforeCallbacks.add(beforePosition);
		if (afterPosition) afterCallbacks.add(afterPosition);
		if (!frame) frame = win.requestAnimationFrame(run);
	};
	const reposition = (beforePosition?: () => void, afterPosition?: () => void) => {
		if (disposed) return;
		if (beforePosition) beforeCallbacks.add(beforePosition);
		if (afterPosition) afterCallbacks.add(afterPosition);
		if (frame) win.cancelAnimationFrame(frame);
		frame = 0;
		run();
	};
	const onResize = () => schedule();
	const onScroll = () => schedule();
	win.addEventListener('resize', onResize);
	doc.addEventListener('scroll', onScroll, true);
	viewport?.addEventListener('resize', onResize);
	viewport?.addEventListener('scroll', onScroll);
	return {
		schedule,
		reposition,
		dispose() {
			if (disposed) return;
			disposed = true;
			if (frame) win.cancelAnimationFrame(frame);
			frame = 0;
			beforeCallbacks.clear();
			afterCallbacks.clear();
			win.removeEventListener('resize', onResize);
			doc.removeEventListener('scroll', onScroll, true);
			viewport?.removeEventListener('resize', onResize);
			viewport?.removeEventListener('scroll', onScroll);
		},
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
		btnEl.type = 'button';
		if (button.type === 'color') {
			const dot = btnEl.createSpan({ cls: 'study-pdf-color-dot' });
			dot.setCssStyles({ backgroundColor: button.hex });
			setTooltip(btnEl, button.name);
			btnEl.setAttribute('aria-label', button.name);
		} else {
			setIcon(btnEl, button.icon);
			btnEl.setAttribute('aria-label', button.label);
			setTooltip(btnEl, button.label);
		}
		btnEl.addEventListener('click', button.onClick);
	}

	positionPopup(doc, el, position);
	const positioning = trackPopupPosition(doc, el, position);
	let closed = false;
	const onKeyDown = (evt: KeyboardEvent) => {
		if (evt.key !== 'Escape') return;
		evt.preventDefault();
		hide();
	};
	const hide = () => {
		if (closed) return;
		closed = true;
		positioning.dispose();
		doc.removeEventListener('keydown', onKeyDown);
		el.remove();
		options.onDismiss?.();
	};
	// Keep focus on the PDF so Shift+arrows and continued selection still work.
	doc.addEventListener('keydown', onKeyDown);

	return {
		el,
		reposition: () => positioning.schedule(),
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
		inputLabel?: string;
		onSave: (note: string) => void | boolean | Promise<void | boolean>;
		onSaved?: () => void;
		onCancel: () => void;
	},
): IconPopup {
	const el = doc.body.createDiv({ cls: 'study-pdf-popup study-pdf-note-editor' });
	doc.dispatchEvent(new Event('study-pdf-note-editor-open'));
	el.setAttribute('role', 'dialog');
	el.setAttribute('aria-label', 'Annotation note');
	const popupPosition = { ...position };
	el.tabIndex = -1;
	let closed = false;
	let composing = false;
	let dictating = false;
	let pending = false;
	let savedCloseTimer = 0;

	const handle = el.createEl('button', { cls: 'study-pdf-note-handle' });
	handle.type = 'button';
	handle.setAttribute('aria-label', 'Move note. Drag or use arrow keys.');
	setTooltip(handle, 'Move note');
	setIcon(handle, 'grip-horizontal');
	let repositionPopup: () => void = () => undefined;

	// createEl's `value` option only reflects for <input> elements, not
	// <textarea> -- set it directly so an existing note is pre-filled.
	const input = el.createEl('textarea', {
		cls: 'study-pdf-note-input',
		placeholder: 'Note…',
	});
	input.setAttribute('aria-label', options.inputLabel ?? 'Highlight note');
	input.value = options.initial;
	const preview = el.createDiv({ cls: 'study-pdf-note-preview' });
	preview.hidden = true;
	const formatControls = createNoteFormattingControls(el, input, preview, {
		reposition: () => repositionPopup(),
		isComposing: () => composing,
	});
	// Existing longer notes remain readable/editable without silent truncation.
	const wordLimit = Math.max(NOTE_WORD_LIMIT, countNoteWords(options.initial));

	const row = el.createDiv({ cls: 'study-pdf-popup-row study-pdf-note-footer' });
	const status = row.createSpan({ cls: 'study-pdf-note-status' });
	status.setAttribute('aria-live', 'polite');
	const counter = row.createSpan({ cls: 'study-pdf-note-word-count' });
	counter.id = `study-pdf-note-words-${++nextNoteCounterId}`;
	input.setAttribute('aria-describedby', counter.id);
	const setStatus = (state: 'idle' | 'pending' | 'saved' | 'failed') => {
		status.empty();
		status.removeAttribute('data-state');
		if (state === 'idle') return;
		status.setAttribute('data-state', state);
		setIcon(status, state === 'pending' ? 'loader-circle' : state === 'saved' ? 'check' : 'circle-alert');
		status.setAttribute('aria-label', state === 'pending' ? 'Saving draft' : state === 'saved' ? 'Draft saved' : 'Save failed. Draft retained.');
	};
	const makeButton = (icon: string, label: string, onClick?: () => void) => {
		const btnEl = row.createEl('button', { cls: 'clickable-icon' });
		btnEl.type = 'button';
		setIcon(btnEl, icon);
		setTooltip(btnEl, label);
		btnEl.setAttribute('aria-label', label);
		if (onClick) btnEl.addEventListener('click', onClick);
		return btnEl;
	};
	const micButton = makeButton('mic', 'Dictate note');
	micButton.classList.add('study-pdf-note-format-button');
	const saveButton = makeButton('check', 'Save note', () => { void submit(); });
	const cancel = () => {
		dictation.abort();
		options.onCancel();
	};
	const cancelButton = makeButton('x', 'Cancel', cancel);
	const dictationStatus = el.createDiv({ cls: 'study-pdf-popup-note study-pdf-note-footer' });
	dictationStatus.setAttribute('role', 'status');
	dictationStatus.hidden = true;
	const syncEditingControls = () => {
		const state = status.getAttribute('data-state');
		micButton.disabled = composing || state === 'pending' || state === 'saved';
		formatControls.setDisabled(micButton.disabled || dictating);
	};
	const dictation = bindNoteDictation(input, micButton, dictationStatus, {
		canDictate: () => preview.hidden && !micButton.disabled,
		onActiveChange(active) {
			dictating = active;
			syncEditingControls();
		},
		reposition: () => repositionPopup(),
	});
	const updateWordCount = () => {
		const count = countNoteWords(input.value);
		counter.setText(`${count} / ${wordLimit}`);
		counter.setAttribute('aria-label', `${count} of ${wordLimit} words`);
		counter.classList.toggle('is-over-limit', count > wordLimit);
		input.setAttribute('aria-invalid', String(count > wordLimit));
		saveButton.disabled = pending || status.getAttribute('data-state') === 'saved' || count > wordLimit;
	};
	const updateStatus = (state: 'idle' | 'pending' | 'saved' | 'failed') => {
		setStatus(state);
		saveButton.disabled = state === 'pending' || state === 'saved' || countNoteWords(input.value) > wordLimit;
		cancelButton.disabled = state === 'pending' || state === 'saved';
		input.disabled = state === 'pending';
		syncEditingControls();
	};
	const submit = async () => {
		if (pending || closed || status.getAttribute('data-state') === 'saved' || countNoteWords(input.value) > wordLimit) return;
		dictation.abort();
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
				saveButton.disabled = countNoteWords(input.value) > wordLimit;
				cancelButton.disabled = false;
			}
		}
	};

	input.addEventListener('compositionstart', () => {
		composing = true;
		dictation.abort();
		syncEditingControls();
	});
	input.addEventListener('compositionend', () => {
		composing = false;
		syncEditingControls();
	});
	input.addEventListener('input', () => {
		updateWordCount();
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
		cancel();
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

	positionPopup(doc, el, popupPosition);
	const positioning = trackPopupPosition(doc, el, popupPosition);
	repositionPopup = () => positioning.reposition();
	const stopDragging = bindPopupDragging(doc, el, handle, popupPosition, positioning);
	const stopAutoSize = bindAutoNoteSize(doc, el, input, positioning);
	updateWordCount();
	input.focus();

	return {
		el,
		reposition: () => positioning.schedule(),
		preserveOnScroll: true,
		get preserveOnBlur() { return dictating; },
		hide() {
			if (closed) return;
			closed = true;
			dictation.dispose();
			if (savedCloseTimer) doc.defaultView?.clearTimeout(savedCloseTimer);
			stopAutoSize();
			stopDragging();
			positioning.dispose();
			el.removeEventListener('keydown', onKeyDown);
			app.keymap.popScope(scope);
			el.remove();
		},
	};
}
