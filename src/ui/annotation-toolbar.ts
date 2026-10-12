import { setIcon, setTooltip } from 'obsidian';
import type { HighlightColorOption } from '../color-palette';

export interface AnnotationToolbar {
	el: HTMLElement;
	focusButton: HTMLButtonElement;
	toolsButton: HTMLButtonElement;
	update(
		colors: readonly HighlightColorOption[],
		colorId: string,
		highlighting: boolean,
		history: { canUndo: boolean; canRedo: boolean },
		focusActive: boolean,
		toolsVisible: boolean,
	): void;
	destroy(): void;
}

/** One compact toolbar outside the PDF scroller, with pinned Focus controls. */
export function createAnnotationToolbar(
	nativeToolbar: HTMLElement,
	actions: {
		onMode: (highlighting: boolean) => void;
		onColor: (colorId: string, event: MouseEvent) => void;
		onPress: () => void;
		onCancel: () => void;
		onUndo: () => void;
		onRedo: () => void;
		onFitWidth: () => void;
		onFocus: () => void;
		onToggleTools: () => void;
	},
): AnnotationToolbar {
	const el = nativeToolbar.createDiv({ cls: 'study-pdf-annotation-toolbar' });
	nativeToolbar.before(el);
	el.setAttribute('role', 'toolbar');
	el.setAttribute('aria-label', 'PDF annotation tools');

	const inner = el.createDiv({ cls: 'study-pdf-toolbar-inner' });
	const leading = inner.createDiv({ cls: 'study-pdf-toolbar-scroll' });
	leading.setAttribute('role', 'group');
	leading.setAttribute('aria-label', 'Annotation and page tools');
	const pinned = inner.createDiv({ cls: 'study-pdf-toolbar-pinned' });
	pinned.setAttribute('role', 'group');
	pinned.setAttribute('aria-label', 'Reading mode controls');

	const createGroup = (className: string, label: string) => {
		const group = leading.createDiv({ cls: className });
		group.setAttribute('role', 'group');
		group.setAttribute('aria-label', label);
		return group;
	};
	const createButton = (
		parent: HTMLElement,
		icon: string,
		label: string,
		className: string,
		action: () => void,
	) => {
		const button = parent.createEl('button', { cls: `clickable-icon study-pdf-tool-button ${className}` });
		button.type = 'button';
		button.setAttribute('aria-label', label);
		setTooltip(button, label);
		setIcon(button.createSpan({ cls: 'study-pdf-tool-icon' }), icon);
		button.addEventListener('click', action);
		return button;
	};

	const modes = createGroup('study-pdf-toolbar-modes', 'Selection mode');
	const select = createButton(modes, 'mouse-pointer-2', 'Select', 'study-pdf-mode-button', () => actions.onMode(false));
	const highlight = createButton(modes, 'highlighter', 'Highlight', 'study-pdf-mode-button', () => actions.onMode(true));

	const palette = createGroup('study-pdf-toolbar-palette', 'Highlight color');
	let signature = '';
	const colorButtons = new Map<string, HTMLButtonElement>();

	const history = createGroup('study-pdf-toolbar-history', 'Annotation history');
	const undo = createButton(history, 'undo', 'Undo', 'study-pdf-history-button', actions.onUndo);
	const redo = createButton(history, 'redo', 'Redo', 'study-pdf-history-button', actions.onRedo);

	const fitGroup = createGroup('study-pdf-toolbar-fit', 'Page view');
	createButton(fitGroup, 'arrow-left-right', 'Fit width', 'study-pdf-action-button', actions.onFitWidth);

	const tools = createButton(pinned, 'eye', 'Show PDF tools', 'study-pdf-action-button study-pdf-action-tools', actions.onToggleTools);
	tools.hidden = true;
	tools.setAttribute('aria-expanded', 'false');
	const focus = createButton(pinned, 'maximize-2', 'Full screen', 'study-pdf-action-button study-pdf-action-focus', actions.onFocus);
	let toolsIconVisible: boolean | null = null;
	let focusIconActive: boolean | null = null;

	const onMouseDown = (event: MouseEvent) => {
		if (event.button === 0) event.preventDefault(); // Keep the PDF selection alive.
	};
	el.addEventListener('mousedown', onMouseDown);
	el.addEventListener('pointerdown', actions.onPress);
	el.addEventListener('pointercancel', actions.onCancel);

	return {
		el,
		focusButton: focus,
		toolsButton: tools,
		update(colors, colorId, highlighting, historyStatus, focusActive, toolsVisible) {
			const nextSignature = JSON.stringify(colors);
			if (signature !== nextSignature) {
				signature = nextSignature;
				palette.empty();
				colorButtons.clear();
				for (const color of colors) {
					const button = palette.createEl('button', { cls: 'clickable-icon study-pdf-annotation-color' });
					button.type = 'button';
					button.setAttribute('aria-label', `Highlight with ${color.name}`);
					setTooltip(button, color.name);
					const dot = button.createSpan({ cls: 'study-pdf-color-dot' });
					dot.setAttribute('aria-hidden', 'true');
					dot.setCssStyles({ backgroundColor: color.hex });
					button.addEventListener('click', (event) => actions.onColor(color.id, event));
					colorButtons.set(color.id, button);
				}
			}
			select.setAttribute('aria-pressed', String(!highlighting));
			highlight.setAttribute('aria-pressed', String(highlighting));
			undo.disabled = !historyStatus.canUndo;
			redo.disabled = !historyStatus.canRedo;
			for (const [id, button] of colorButtons) button.setAttribute('aria-pressed', String(id === colorId));
			tools.hidden = !focusActive;
			const toolsLabel = toolsVisible ? 'Hide PDF tools' : 'Show PDF tools';
			tools.setAttribute('aria-label', toolsLabel);
			tools.setAttribute('aria-expanded', String(toolsVisible));
			setTooltip(tools, toolsLabel);
			if (toolsIconVisible !== toolsVisible) {
				toolsIconVisible = toolsVisible;
				setIcon(tools.querySelector<HTMLElement>('.study-pdf-tool-icon') ?? tools, toolsVisible ? 'eye-off' : 'eye');
			}
			const focusLabel = focusActive ? 'Exit full screen' : 'Full screen';
			focus.setAttribute('aria-label', focusLabel);
			focus.setAttribute('aria-pressed', String(focusActive));
			setTooltip(focus, focusLabel);
			if (focusIconActive !== focusActive) {
				focusIconActive = focusActive;
				setIcon(focus.querySelector<HTMLElement>('.study-pdf-tool-icon') ?? focus, focusActive ? 'minimize-2' : 'maximize-2');
			}
		},
		destroy() {
			el.removeEventListener('mousedown', onMouseDown);
			el.removeEventListener('pointerdown', actions.onPress);
			el.removeEventListener('pointercancel', actions.onCancel);
			el.remove();
		},
	};
}
