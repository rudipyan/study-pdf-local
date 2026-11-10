import { setIcon, setTooltip } from 'obsidian';
import { formatNoteSelection, type NoteFormattingAction } from './note-markdown-formatting';
import { renderNoteMarkdown } from './note-markdown';

export interface NoteFormattingControls {
	buttons: HTMLButtonElement[];
	setDisabled(disabled: boolean): void;
}

/** Add safe Markdown controls around the existing plain-text note source. */
export function createNoteFormattingControls(
	card: HTMLElement,
	input: HTMLTextAreaElement,
	preview: HTMLElement,
	options: { reposition(): void; isComposing(): boolean },
): NoteFormattingControls {
	const toolbar = card.createDiv({ cls: 'study-pdf-note-formatting' });
	toolbar.setAttribute('role', 'group');
	toolbar.setAttribute('aria-label', 'Note formatting');
	const buttons: HTMLButtonElement[] = [];
	const actionButtons: HTMLButtonElement[] = [];
	const actions: Array<{ button: HTMLButtonElement; action: NoteFormattingAction }> = [];
	const makeButton = (icon: string, label: string, action: NoteFormattingAction) => {
		const button = toolbar.createEl('button', { cls: 'clickable-icon study-pdf-note-format-button' });
		button.type = 'button';
		setIcon(button, icon);
		setTooltip(button, label);
		button.setAttribute('aria-label', label);
		button.addEventListener('mousedown', (event) => event.preventDefault());
		buttons.push(button);
		actionButtons.push(button);
		actions.push({ button, action });
	};
	makeButton('bold', 'Bold', 'bold');
	makeButton('italic', 'Italic', 'italic');
	makeButton('list', 'Bullet list', 'bullets');
	makeButton('list-ordered', 'Numbered list', 'numbered');
	const previewButton = toolbar.createEl('button', { cls: 'clickable-icon study-pdf-note-format-button' });
	previewButton.type = 'button';
	setIcon(previewButton, 'eye');
	setTooltip(previewButton, 'Preview note');
	previewButton.setAttribute('aria-label', 'Preview note');
	previewButton.setAttribute('aria-pressed', 'false');
	previewButton.addEventListener('mousedown', (event) => event.preventDefault());
	buttons.push(previewButton);

	let previewing = false;
	let controlsDisabled = false;
	let selection = { start: input.value.length, end: input.value.length };
	const syncDisabled = () => {
		for (const button of actionButtons) button.disabled = controlsDisabled || previewing || options.isComposing();
		previewButton.disabled = controlsDisabled || options.isComposing();
	};
	const applyFormatting = (action: NoteFormattingAction) => {
		if (input.disabled || previewing || options.isComposing()) return;
		const formatted = formatNoteSelection(input.value, input.selectionStart, input.selectionEnd, action);
		input.value = formatted.value;
		input.focus();
		input.setSelectionRange(formatted.selectionStart, formatted.selectionEnd);
		input.dispatchEvent(new Event('input', { bubbles: true }));
	};
	for (const { button, action } of actions) button.addEventListener('click', () => applyFormatting(action));

	previewButton.addEventListener('click', () => {
		if (input.disabled || options.isComposing()) return;
		previewing = !previewing;
		if (previewing) {
			selection = { start: input.selectionStart, end: input.selectionEnd };
			renderNoteMarkdown(preview, input.value);
			preview.hidden = false;
			syncDisabled();
			input.classList.add('is-preview-hidden');
			input.setAttribute('aria-hidden', 'true');
			previewButton.setAttribute('aria-pressed', 'true');
			previewButton.setAttribute('aria-label', 'Edit note');
			setTooltip(previewButton, 'Edit note');
			setIcon(previewButton, 'pencil');
			previewButton.focus();
		} else {
			preview.hidden = true;
			input.classList.remove('is-preview-hidden');
			input.removeAttribute('aria-hidden');
			previewButton.setAttribute('aria-pressed', 'false');
			previewButton.setAttribute('aria-label', 'Preview note');
			setTooltip(previewButton, 'Preview note');
			setIcon(previewButton, 'eye');
			input.focus();
			input.setSelectionRange(selection.start, selection.end);
		}
		syncDisabled();
		options.reposition();
	});

	input.addEventListener('keydown', (event) => {
		if (event.isComposing || options.isComposing() || event.keyCode === 229) return;
		if (!(event.metaKey || event.ctrlKey) || event.shiftKey || event.altKey) return;
		const key = event.key.toLowerCase();
		const action = key === 'b' ? 'bold' : key === 'i' ? 'italic' : null;
		if (!action) return;
		event.preventDefault();
		applyFormatting(action);
	});

	return {
		buttons,
		setDisabled(disabled) {
			controlsDisabled = disabled;
			syncDisabled();
		},
	};
}
