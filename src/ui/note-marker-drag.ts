import type { NoteMarkerPosition } from '../note-marker-positions';

/** Drag the closed comment icon. Touch/pen requires a short hold; mouse can
 * drag immediately. A drag never opens the note and never writes PDF bytes. */
export function bindNoteMarkerDragging(
	button: HTMLButtonElement,
	layer: HTMLElement,
	onDrop: (position: NoteMarkerPosition) => void,
): { consumeClick(event: MouseEvent): boolean; dispose(): void } {
	const win = layer.ownerDocument.defaultView;
	if (!win) return { consumeClick: () => false, dispose: () => undefined };
	let disposed = false;
	let suppressClick = false;
	let hold = 0;
	let frame = 0;
	let drag: {
		id: number; x: number; y: number; centerX: number; centerY: number;
		bounds: DOMRect; armed: boolean; holdActivated: boolean; moved: boolean; cancelled: boolean;
		position: NoteMarkerPosition;
		original: { left: string; right: string; top: string; transform: string };
	} | null = null;
	const place = (position: NoteMarkerPosition) => {
		button.style.left = `${position.x * 100}%`;
		button.style.top = `${position.y * 100}%`;
		button.setCssStyles({ right: 'auto', transform: 'translate(-50%, -50%)' });
	};
	const paint = () => {
		frame = 0;
		if (drag && !disposed) place(drag.position);
	};
	const finish = (commit: boolean) => {
		const previous = drag;
		drag = null;
		if (hold) win.clearTimeout(hold);
		if (frame) win.cancelAnimationFrame(frame);
		hold = frame = 0;
		win.removeEventListener('blur', blur);
		button.classList.remove('study-pdf-note-marker-held');
		if (!previous) return;
		if (button.hasPointerCapture(previous.id)) button.releasePointerCapture(previous.id);
		suppressClick ||= previous.moved || previous.cancelled || previous.holdActivated;
		if (commit && previous.moved && !previous.cancelled && button.isConnected && layer.contains(button)) {
			place(previous.position);
			onDrop(previous.position);
		} else if (previous.moved) Object.assign(button.style, previous.original);
	};
	const blur = () => finish(false);
	const down = (event: PointerEvent) => {
		event.stopPropagation();
		if (disposed || !event.isPrimary || event.button !== 0) { if (drag) finish(false); return; }
		finish(false);
		suppressClick = false;
		const bounds = layer.getBoundingClientRect();
		const rect = button.getBoundingClientRect();
		if (bounds.width <= 0 || bounds.height <= 0) return;
		drag = {
			id: event.pointerId, x: event.clientX, y: event.clientY,
			centerX: rect.left + rect.width / 2 - bounds.left, centerY: rect.top + rect.height / 2 - bounds.top,
			bounds, armed: event.pointerType === 'mouse', holdActivated: false, moved: false, cancelled: false,
			position: { x: 0, y: 0 },
			original: { left: button.style.left, right: button.style.right, top: button.style.top, transform: button.style.transform },
		};
		button.setPointerCapture(event.pointerId);
		win.addEventListener('blur', blur);
		if (!drag.armed) hold = win.setTimeout(() => {
			hold = 0;
			if (drag && !drag.cancelled) { drag.armed = true; drag.holdActivated = true; button.classList.add('study-pdf-note-marker-held'); }
		}, 350);
	};
	const update = (event: PointerEvent) => {
		if (!drag || event.pointerId !== drag.id) return;
		const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
		if (Math.hypot(dx, dy) < 6 && !drag.moved) return;
		if (!drag.armed) { drag.cancelled = true; suppressClick = true; return; }
		const now = layer.getBoundingClientRect();
		if (Math.abs(now.left - drag.bounds.left) > 1 || Math.abs(now.top - drag.bounds.top) > 1 ||
			Math.abs(now.width - drag.bounds.width) > 1 || Math.abs(now.height - drag.bounds.height) > 1) {
			drag.cancelled = true;
			return;
		}
		if (drag.cancelled) return;
		event.preventDefault();
		drag.moved = true;
		button.classList.add('study-pdf-note-marker-held');
		const halfX = Math.min(22, now.width / 2), halfY = Math.min(22, now.height / 2);
		drag.position = {
			x: Math.max(halfX, Math.min(now.width - halfX, drag.centerX + dx)) / now.width,
			y: Math.max(halfY, Math.min(now.height - halfY, drag.centerY + dy)) / now.height,
		};
		if (!frame) frame = win.requestAnimationFrame(paint);
	};
	const move = (event: PointerEvent) => { event.stopPropagation(); update(event); };
	const up = (event: PointerEvent) => {
		event.stopPropagation();
		if (!drag || drag.id !== event.pointerId) return;
		update(event);
		finish(true);
	};
	const cancel = (event: PointerEvent) => {
		event.stopPropagation();
		if (!drag || drag.id !== event.pointerId) return;
		drag.cancelled = true;
		finish(false);
	};
	const contextMenu = (event: Event) => { event.preventDefault(); event.stopPropagation(); };
	button.addEventListener('pointerdown', down);
	button.addEventListener('pointermove', move);
	button.addEventListener('pointerup', up);
	button.addEventListener('pointercancel', cancel);
	button.addEventListener('lostpointercapture', cancel);
	button.addEventListener('contextmenu', contextMenu);
	return {
		consumeClick(event) { const consumed = event.detail > 0 && suppressClick; suppressClick = false; return consumed; },
		dispose() {
			if (disposed) return;
			disposed = true;
			finish(false);
			button.removeEventListener('pointerdown', down);
			button.removeEventListener('pointermove', move);
			button.removeEventListener('pointerup', up);
			button.removeEventListener('pointercancel', cancel);
			button.removeEventListener('lostpointercapture', cancel);
			button.removeEventListener('contextmenu', contextMenu);
		},
	};
}
