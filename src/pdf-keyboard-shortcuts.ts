export type PdfKeyboardShortcut =
	| { type: 'toggle-mode' }
	| { type: 'select-color'; index: number }
	| { type: 'select-mode' }
	| { type: 'undo' }
	| { type: 'redo' };

export interface PdfKeyboardShortcutContext {
	isMac: boolean;
	focusedPdfPane: boolean;
	editableTarget: boolean;
	modalOrSearch: boolean;
	popupOpen: boolean;
}

export function isPotentialPdfKeyboardShortcut(
	event: Pick<KeyboardEvent, 'key' | 'shiftKey' | 'altKey' | 'ctrlKey' | 'metaKey' | 'defaultPrevented' | 'isComposing' | 'repeat'>,
	isMac: boolean,
): boolean {
	if (!isMac || event.defaultPrevented || event.isComposing || event.repeat) return false;
	const key = event.key.toLowerCase();
	if (key === 'z') return event.metaKey && !event.ctrlKey && !event.altKey;
	if (event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) return false;
	return key === 'h' || key === 'escape' || /^[1-9]$/.test(key);
}

export function classifyPdfKeyboardShortcut(
	event: Pick<KeyboardEvent, 'key' | 'shiftKey' | 'altKey' | 'ctrlKey' | 'metaKey' | 'defaultPrevented' | 'isComposing' | 'repeat'>,
	context: PdfKeyboardShortcutContext,
): PdfKeyboardShortcut | null {
	if (!context.isMac || !context.focusedPdfPane || context.editableTarget || context.modalOrSearch ||
		event.defaultPrevented || event.isComposing || event.repeat) return null;

	const key = event.key.toLowerCase();
	const hasNoModifiers = !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey;
	if (context.popupOpen) return null;
	if (key === 'escape' && hasNoModifiers) return { type: 'select-mode' };
	if (key === 'z' && event.metaKey && !event.ctrlKey && !event.altKey) {
		return event.shiftKey ? { type: 'redo' } : { type: 'undo' };
	}
	if (!hasNoModifiers) return null;
	if (key === 'h') return { type: 'toggle-mode' };
	if (/^[1-9]$/.test(key)) return { type: 'select-color', index: Number(key) - 1 };
	return null;
}
