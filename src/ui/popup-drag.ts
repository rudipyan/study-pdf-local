/** Pointer/keyboard movement for one open popup. Does not track PDF selections
 * or pages; all listeners, capture, and animation frames are released on close. */
import type { PopupPositioning } from './icon-popup';

export function bindPopupDragging(
	doc: Document,
	popup: HTMLElement,
	handle: HTMLButtonElement,
	position: { x: number; y: number },
	positioning: PopupPositioning,
): () => void {
	const win = doc.defaultView;
	if (!win) return () => undefined;
	let disposed = false;
	let drag: { id: number; x: number; y: number } | null = null;

	const rememberClampedPosition = () => {
		const bounds = popup.getBoundingClientRect();
		position.x = bounds.left - (win.visualViewport?.offsetLeft ?? 0);
		position.y = bounds.top - (win.visualViewport?.offsetTop ?? 0);
	};
	const schedule = () => { if (!disposed) positioning.schedule(undefined, rememberClampedPosition); };
	const finish = () => {
		const previous = drag;
		drag = null;
		popup.classList.remove('study-pdf-note-dragging');
		if (previous && handle.hasPointerCapture(previous.id)) handle.releasePointerCapture(previous.id);
	};
	const down = (event: PointerEvent) => {
		event.stopPropagation();
		if (disposed || !event.isPrimary || event.button !== 0 || drag) return;
		event.preventDefault(); // Keep the note's text/caret and keyboard intact.
		rememberClampedPosition();
		drag = { id: event.pointerId, x: event.clientX, y: event.clientY };
		handle.setPointerCapture(event.pointerId);
		popup.classList.add('study-pdf-note-dragging');
	};
	const update = (event: PointerEvent) => {
		if (!drag || event.pointerId !== drag.id) return false;
		position.x += event.clientX - drag.x;
		position.y += event.clientY - drag.y;
		drag.x = event.clientX;
		drag.y = event.clientY;
		return true;
	};
	const move = (event: PointerEvent) => {
		event.stopPropagation();
		if (!update(event)) return;
		event.preventDefault();
		schedule();
	};
	const up = (event: PointerEvent) => {
		event.stopPropagation();
		if (!update(event)) return;
		event.preventDefault();
		finish();
		positioning.reposition(undefined, rememberClampedPosition);
	};
	const cancel = (event: PointerEvent) => {
		event.stopPropagation();
		if (!drag || event.pointerId !== drag.id) return;
		finish();
		positioning.reposition(undefined, rememberClampedPosition);
	};
	const key = (event: KeyboardEvent) => {
		const directions: Record<string, readonly [number, number]> = {
			ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1],
		};
		const direction = directions[event.key];
		if (!direction || event.altKey || event.ctrlKey || event.metaKey || event.isComposing) return;
		event.preventDefault();
		event.stopPropagation();
		rememberClampedPosition();
		const distance = event.shiftKey ? 24 : 8;
		position.x += direction[0] * distance;
		position.y += direction[1] * distance;
		positioning.reposition(undefined, rememberClampedPosition);
	};
	const suppressContextMenu = (event: Event) => event.preventDefault();
	handle.addEventListener('pointerdown', down);
	handle.addEventListener('pointermove', move);
	handle.addEventListener('pointerup', up);
	handle.addEventListener('pointercancel', cancel);
	handle.addEventListener('lostpointercapture', cancel);
	handle.addEventListener('keydown', key);
	handle.addEventListener('contextmenu', suppressContextMenu);
	win.addEventListener('blur', finish);
	const resize = new win.ResizeObserver(schedule);
	resize.observe(popup);

	return () => {
		if (disposed) return;
		disposed = true;
		finish();
		resize.disconnect();
		handle.removeEventListener('pointerdown', down);
		handle.removeEventListener('pointermove', move);
		handle.removeEventListener('pointerup', up);
		handle.removeEventListener('pointercancel', cancel);
		handle.removeEventListener('lostpointercapture', cancel);
		handle.removeEventListener('keydown', key);
		handle.removeEventListener('contextmenu', suppressContextMenu);
		win.removeEventListener('blur', finish);
	};
}
