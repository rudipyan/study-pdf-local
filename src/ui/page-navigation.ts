import { Scope, setIcon, type App } from 'obsidian';
import { positionPopup, trackPopupPosition, type IconPopup } from './icon-popup';

let nextPageInputId = 0;

export interface PageNavigationActions {
	getPagePosition(): { page: number; total: number } | null;
	goToPage(page: number): boolean;
	watchPagePosition(onChange: () => void): () => void;
	pageKeymap: Pick<App['keymap'], 'pushScope' | 'popScope'>;
	onPagePopupOpen(popup: IconPopup): void;
	onPagePopupClose(popup: IconPopup): void;
}

/** Physical PDF positions are always one-based; printed labels remain metadata. */
export function createPageNavigation(group: HTMLElement, actions: PageNavigationActions) {
	const nativeInput = group.querySelector<HTMLInputElement>('input.pdf-page-input');
	const nativeCount = group.querySelector<HTMLElement>('span.pdf-page-numbers');
	if (!nativeInput) return null;
	const doc = group.ownerDocument;
	const store = group.createDiv({ cls: 'study-pdf-page-native' });
	store.hidden = true;
	store.append(nativeInput);
	if (nativeCount) store.append(nativeCount);
	const trigger = group.createEl('button', { cls: 'study-pdf-page-trigger' });
	trigger.type = 'button';
	trigger.setAttribute('aria-haspopup', 'dialog');
	trigger.setAttribute('aria-expanded', 'false');
	const label = trigger.createSpan();
	trigger.createSpan({ text: '/', cls: 'study-pdf-page-prefix' }).setAttribute('aria-hidden', 'true');
	const totalLabel = trigger.createSpan({ cls: 'study-pdf-page-prefix' });
	let popup: IconPopup | null = null;
	let draft: HTMLInputElement | null = null;
	let positionText: HTMLElement | null = null;
	let disposed = false;
	let updateQueued = false;
	const readPosition = () => {
		const position = actions.getPagePosition();
		return position && Number.isInteger(position.total) && position.total >= 1 &&
			Number.isInteger(position.page) && position.page >= 1 && position.page <= position.total ? position : null;
	};
	const update = () => {
		const position = readPosition();
		label.textContent = position ? String(position.page) : '—';
		totalLabel.textContent = position ? String(position.total) : '—';
		trigger.disabled = !position;
		trigger.setAttribute('aria-label', position ? `PDF page ${position.page} of ${position.total}. Jump to page` : 'PDF page position unavailable');
		const detail = nativeInput.type === 'text' && nativeInput.value ? `Printed page label: ${nativeInput.value}` : '';
		if (positionText) positionText.textContent = detail;
		if (positionText) positionText.hidden = !detail;
		if (!position) { popup?.hide(); return; }
		const value = String(position.page);
		if (draft) draft.max = String(position.total);
		// A page jump elsewhere invalidates a partially entered destination.
		if (draft && popup && value !== draft.dataset.sourcePage) {
			draft.value = value;
			draft.dataset.sourcePage = value;
		}
	};
	const scheduleUpdate = () => {
		if (disposed || updateQueued) return;
		updateQueued = true;
		queueMicrotask(() => {
			updateQueued = false;
			if (!disposed) update();
		});
	};
	const Observer = doc.defaultView?.MutationObserver;
	const observer = Observer ? new Observer(scheduleUpdate) : null;
	if (nativeCount) observer?.observe(nativeCount, { childList: true, characterData: true, subtree: true });
	const stopWatching = actions.watchPagePosition(scheduleUpdate);
	nativeInput.addEventListener('change', update);
	update();

	const open = () => {
		if (popup) { popup.hide(); return; }
		const current = readPosition();
		if (disposed || !current) return;
		const el = doc.body.createDiv({ cls: 'study-pdf-popup study-pdf-page-popup' });
		el.setAttribute('role', 'dialog');
		el.setAttribute('aria-label', 'Jump to PDF page');
		const form = el.createEl('form');
		const field = form.createDiv({ cls: 'study-pdf-page-field' });
		const fieldLabel = field.createEl('label', { text: 'PDF page' });
		const row = field.createDiv({ cls: 'study-pdf-page-entry' });
		const input = row.createEl('input');
		input.id = `study-pdf-page-jump-${++nextPageInputId}`;
		fieldLabel.htmlFor = input.id;
		input.type = 'number';
		input.min = '1';
		input.max = String(current.total);
		input.step = '1';
		input.inputMode = 'numeric';
		input.required = true;
		input.autocomplete = 'off';
		input.spellcheck = false;
		input.value = String(current.page);
		input.dataset.sourcePage = input.value;
		const go = row.createEl('button', { cls: 'clickable-icon study-pdf-page-go' });
		go.type = 'submit';
		go.setAttribute('aria-label', 'Go to PDF page');
		setIcon(go, 'arrow-right');
		positionText = form.createDiv({ cls: 'study-pdf-page-position' });
		draft = input;
		let closed = false;
		const anchor = trigger.getBoundingClientRect();
		const position = { x: anchor.right - 192, y: anchor.bottom + 6 };
		positionPopup(doc, el, position);
		const positioning = trackPopupPosition(doc, el, position);
		const scope = new Scope();
		scope.register([], 'ArrowLeft', () => true);
		scope.register([], 'ArrowRight', () => true);
		actions.pageKeymap.pushScope(scope);
		const hide = (restoreFocus = true) => {
			if (closed) return;
			closed = true;
			const focusInside = el.contains(doc.activeElement);
			positioning.dispose();
			actions.pageKeymap.popScope(scope);
			doc.removeEventListener('pointerdown', outside, true);
			doc.removeEventListener('keydown', key, true);
			trigger.setAttribute('aria-expanded', 'false');
			popup = null; draft = null; positionText = null;
			el.remove();
			if (restoreFocus && focusInside && trigger.isConnected) trigger.focus({ preventScroll: true });
			actions.onPagePopupClose(handle);
		};
		const outside = (event: PointerEvent) => {
			if (!event.composedPath().includes(el) && !event.composedPath().includes(trigger)) hide(false);
		};
		const key = (event: KeyboardEvent) => {
			if (event.key === 'Escape' && !event.isComposing) {
				event.preventDefault(); event.stopPropagation(); hide();
			}
		};
	const handle: IconPopup = { el, preserveOnScroll: true, reposition: () => positioning.schedule(), hide };
		form.addEventListener('submit', (event) => {
			event.preventDefault();
			const destination = Number(input.value);
			const live = readPosition();
			if (!input.value.trim() || !Number.isInteger(destination) || destination < 1 ||
				!live || destination > live.total || !input.checkValidity()) return;
			// Bypass label resolution: typed 1 means the first physical PDF page,
			// even when the document's printed label for that page is 0 or i.
			if (!actions.goToPage(destination)) return;
			hide(); update();
		});
		popup = handle;
		trigger.setAttribute('aria-expanded', 'true');
		update();
		doc.addEventListener('pointerdown', outside, true);
		doc.addEventListener('keydown', key, true);
		actions.onPagePopupOpen(handle);
		input.focus({ preventScroll: true });
		input.select();
		positioning.reposition();
	};
	trigger.addEventListener('click', open);
	return {
		destroy() {
			disposed = true;
			popup?.hide();
			stopWatching();
			observer?.disconnect();
			nativeInput.removeEventListener('change', update);
			trigger.removeEventListener('click', open);
			group.append(nativeInput);
			if (nativeCount) group.append(nativeCount);
			trigger.remove(); store.remove();
		},
	};
}
