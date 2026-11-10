import type { PopupPositioning } from './icon-popup';

export const NOTE_WORD_LIMIT = 500;

export function countNoteWords(text: string): number {
	return text.match(/\S+/gu)?.length ?? 0;
}

/** Fit the open note to its text and the visible screen/keyboard. There is no
 * PDF access, text-layer observation, or work after the editor is closed. */
export function bindAutoNoteSize(
	doc: Document,
	card: HTMLElement,
	input: HTMLTextAreaElement,
	positioning: PopupPositioning,
): () => void {
	const win = doc.defaultView;
	if (!win) return () => undefined;
	let closed = false;
	const fit = () => {
		if (closed) return;
		const width = win.visualViewport?.width ?? win.innerWidth;
		const height = win.visualViewport?.height ?? win.innerHeight;
		const preferredWidth = input.value.length <= 160 ? 340 : input.value.length <= 600 ? 460 : 600;
		card.style.width = `${Math.max(0, Math.min(preferredWidth, width - 16))}px`;
		input.setCssStyles({ width: '100%', minHeight: '0', height: '0px' });
		const chromeHeight = card.scrollHeight + 2;
		const maximum = Math.max(0, Math.min(480, height * 0.65, height - chromeHeight - 16));
		const natural = input.scrollHeight + input.offsetHeight - input.clientHeight;
		const target = Math.min(maximum, Math.max(Math.min(100, maximum), natural));
		input.style.height = `${target}px`;
		input.style.overflowY = natural > target ? 'auto' : 'hidden';
	};
	const schedule = () => { if (!closed) positioning.schedule(fit); };
	input.addEventListener('input', schedule);
	win.addEventListener('resize', schedule);
	win.visualViewport?.addEventListener('resize', schedule);
	positioning.reposition(fit);
	return () => {
		closed = true;
		input.removeEventListener('input', schedule);
		win.removeEventListener('resize', schedule);
		win.visualViewport?.removeEventListener('resize', schedule);
	};
}
