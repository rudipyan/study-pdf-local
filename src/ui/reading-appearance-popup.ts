import { setIcon } from 'obsidian';
import { PDF_READING_APPEARANCES, type PdfReadingAppearance } from '../pdf-reading-appearance';
import { positionPopup, trackPopupPosition, type IconPopup, type PopupPositioning } from './icon-popup';

export function showReadingAppearancePopup(
	doc: Document,
	anchor: HTMLElement,
	current: PdfReadingAppearance,
	onSelect: (appearance: PdfReadingAppearance) => void,
	onDismiss?: () => void,
): IconPopup {
	const el = doc.body.createDiv({ cls: 'study-pdf-popup study-pdf-reading-appearance-popup' });
	el.setAttribute('role', 'dialog');
	el.setAttribute('aria-label', 'PDF reading appearance');
	el.addEventListener('mousedown', (event) => event.preventDefault());
	anchor.setAttribute('aria-expanded', 'true');
	let closed = false;
	let positioning: PopupPositioning | null = null;
	function hide() {
		if (closed) return;
		closed = true;
		positioning?.dispose();
		doc.removeEventListener('keydown', onKeyDown);
		doc.removeEventListener('pointerdown', onPointerDown, true);
		if (anchor.isConnected) anchor.setAttribute('aria-expanded', 'false');
		el.remove();
		onDismiss?.();
	}
	function onKeyDown(event: KeyboardEvent) {
		if (event.key !== 'Escape') return;
		event.preventDefault();
		hide();
	}
	function onPointerDown(event: PointerEvent) {
		const path = event.composedPath();
		if (path.includes(el) || path.includes(anchor)) return;
		hide();
	}

	for (const appearance of PDF_READING_APPEARANCES) {
		const button = el.createEl('button', { cls: 'clickable-icon study-pdf-reading-appearance-option' });
		button.type = 'button';
		button.setAttribute('aria-pressed', String(appearance.id === current));
		button.setAttribute('aria-label', appearance.label);
		const icon = button.createSpan({ cls: 'study-pdf-reading-appearance-check' });
		icon.setAttribute('aria-hidden', 'true');
		if (appearance.id === current) setIcon(icon, 'check');
		button.createSpan({ text: appearance.label });
		button.addEventListener('click', () => {
			onSelect(appearance.id);
			hide();
		});
	}

	const anchorRect = anchor.getBoundingClientRect();
	const position = { x: anchorRect.left, y: anchorRect.bottom + 4 };
	positionPopup(doc, el, position);
	positioning = trackPopupPosition(doc, el, position);
	doc.addEventListener('keydown', onKeyDown);
	doc.addEventListener('pointerdown', onPointerDown, true);

	return { el, reposition() { positioning?.schedule(); }, hide };
}
