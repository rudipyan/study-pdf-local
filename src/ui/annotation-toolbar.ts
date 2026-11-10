import { setIcon, setTooltip } from 'obsidian';
import type { HighlightColorOption } from '../color-palette';
import type { PdfReadingAppearance } from '../pdf-reading-appearance';
import { createPomodoroButton } from './pomodoro';
import type { PomodoroTimer } from '../pomodoro';
import type { IconPopup } from './icon-popup';
import { createPageNavigation, type PageNavigationActions } from './page-navigation';

let nextToolbarRestoreId = 0;

export interface AnnotationToolbar {
	el: HTMLElement;
	focusButton: HTMLButtonElement;
	update(
		colors: readonly HighlightColorOption[],
		colorId: string,
		highlighting: boolean,
		history: { canUndo: boolean; canRedo: boolean },
		focusActive: boolean,
		appearance: PdfReadingAppearance,
		areaSelecting?: boolean,
	): void;
	destroy(): void;
}

export function restoreNativePdfToolbarControls(toolbarRow: HTMLElement, fallbackNativeToolbar?: HTMLElement) {
	const restoreId = toolbarRow.dataset.studyPdfToolbarOwner;
	if (!restoreId) return;
	const adjacentNativeToolbar = [toolbarRow.nextElementSibling, toolbarRow.previousElementSibling]
		.find((sibling) => sibling && (sibling as HTMLElement).dataset.studyPdfToolbarOwner === restoreId) as HTMLElement | undefined;
	const nativeToolbar = adjacentNativeToolbar ??
		(fallbackNativeToolbar?.dataset.studyPdfToolbarOwner === restoreId ? fallbackNativeToolbar : undefined);
	if (!nativeToolbar) return;
	const nativeControls = toolbarRow.querySelector<HTMLElement>('.pdf-toolbar-left');
	if (!nativeControls) {
		delete nativeToolbar.dataset.studyPdfToolbarOwner;
		delete toolbarRow.dataset.studyPdfToolbarOwner;
		return;
	}
	const findPlaceholder = (root: ParentNode, className: string) =>
		Array.from(root.querySelectorAll<HTMLElement>(`.${className}`))
			.find((placeholder) => placeholder.dataset.studyPdfToolbarOwner === restoreId);
	const pageInput = toolbarRow.querySelector<HTMLInputElement>('input.pdf-page-input');
	const pageInputPlaceholder = findPlaceholder(nativeControls, 'study-pdf-native-page-input-placeholder');
	if (pageInput && pageInputPlaceholder) pageInputPlaceholder.replaceWith(pageInput);
	const pageNumbers = toolbarRow.querySelector<HTMLElement>('span.pdf-page-numbers');
	const pageNumbersPlaceholder = findPlaceholder(nativeControls, 'study-pdf-native-page-numbers-placeholder');
	if (pageNumbers && pageNumbersPlaceholder) pageNumbersPlaceholder.replaceWith(pageNumbers);
	const sidebarControl = toolbarRow.querySelector<HTMLElement>('.study-pdf-toolbar-sidebar > .clickable-icon');
	const sidebarPlaceholder = findPlaceholder(nativeControls, 'study-pdf-native-sidebar-placeholder');
	if (sidebarControl && sidebarPlaceholder) sidebarPlaceholder.replaceWith(sidebarControl);
	const controlsPlaceholder = Array.from(nativeToolbar.children).find((child) =>
		child.classList.contains('study-pdf-native-toolbar-left-placeholder') &&
		(child as HTMLElement).dataset.studyPdfToolbarOwner === restoreId,
	) as HTMLElement | undefined;
	if (controlsPlaceholder) controlsPlaceholder.replaceWith(nativeControls);
	delete nativeToolbar.dataset.studyPdfToolbarOwner;
	delete toolbarRow.dataset.studyPdfToolbarOwner;
}

/** One compact row combining PDF.js page controls and plugin tools. */
export function createAnnotationToolbar(
	nativeToolbar: HTMLElement,
	actions: PageNavigationActions & {
		pomodoro?: PomodoroTimer;
		onPomodoro?: (anchor: HTMLButtonElement) => IconPopup | null;
		onMode: (highlighting: boolean) => void;
		onArea?: () => void;
		onColor: (colorId: string, event: MouseEvent) => void;
		onPress: (event: PointerEvent) => void;
		onCancel: () => void;
		onUndo: () => void;
		onRedo: () => void;
		onShowHighlights: () => void;
		onFocus: () => void;
		onAppearance: (anchor: HTMLButtonElement) => IconPopup | null;
	},
): AnnotationToolbar {
	const el = nativeToolbar.createDiv({ cls: 'study-pdf-annotation-toolbar' });
	nativeToolbar.before(el);
	el.setAttribute('role', 'toolbar');
	el.setAttribute('aria-label', 'PDF reading and annotation controls');

	const inner = el.createDiv({ cls: 'study-pdf-toolbar-inner' });
	const scrollFrame = inner.createDiv({ cls: 'study-pdf-toolbar-scroll-frame' });
	const leading = scrollFrame.createDiv({ cls: 'study-pdf-toolbar-scroll' });
	leading.setAttribute('role', 'group');
	leading.setAttribute('aria-label', 'Annotation and PDF navigation controls');
	const pinned = inner.createDiv({ cls: 'study-pdf-toolbar-pinned' });
	pinned.setAttribute('role', 'group');
	pinned.setAttribute('aria-label', 'Study timer, full screen, and highlights controls');
	const pageGroup = pinned.createDiv({ cls: 'study-pdf-toolbar-page' });
	pageGroup.setAttribute('role', 'group');
	pageGroup.setAttribute('aria-label', 'Current page and page count');
	pageGroup.hidden = true;
	const nativeControls = nativeToolbar.querySelector<HTMLElement>(':scope > .pdf-toolbar-left');
	const nativeControlsPlaceholder = nativeControls?.ownerDocument.createElement('div') ?? null;
	const restoreId = nativeControls ? `${Date.now()}-${++nextToolbarRestoreId}` : null;
	const scrollContent = leading.createDiv({ cls: 'study-pdf-toolbar-scroll-content' });
	const selectionTools = scrollContent.createDiv({ cls: 'study-pdf-toolbar-selection' });
	const sidebar = selectionTools.createDiv({ cls: 'study-pdf-toolbar-sidebar' });
	sidebar.setAttribute('role', 'group');
	sidebar.setAttribute('aria-label', 'PDF sidebar controls');
	sidebar.hidden = true;
	const sidebarSeparator = selectionTools.createDiv({ cls: 'study-pdf-toolbar-separator' });
	sidebarSeparator.setAttribute('aria-hidden', 'true');
	sidebarSeparator.hidden = true;
	if (nativeControls && nativeControlsPlaceholder) {
		nativeControlsPlaceholder.className = 'study-pdf-native-toolbar-left-placeholder';
		nativeControlsPlaceholder.setAttribute('aria-hidden', 'true');
		nativeControlsPlaceholder.dataset.studyPdfToolbarOwner = restoreId!;
		nativeToolbar.dataset.studyPdfToolbarOwner = restoreId!;
		el.dataset.studyPdfToolbarOwner = restoreId!;
		nativeControls.before(nativeControlsPlaceholder);
		const firstNativeControl = nativeControls.firstElementChild;
		if (firstNativeControl?.classList.contains('clickable-icon')) {
			const sidebarControl = firstNativeControl as HTMLElement;
			const sidebarPlaceholder = sidebarControl.ownerDocument.createElement('span');
			sidebarPlaceholder.className = 'study-pdf-native-sidebar-placeholder';
			sidebarPlaceholder.dataset.studyPdfToolbarOwner = restoreId!;
			sidebarPlaceholder.setAttribute('aria-hidden', 'true');
			sidebarControl.before(sidebarPlaceholder);
			sidebar.append(sidebarControl);
			sidebar.hidden = false;
			sidebarSeparator.hidden = false;
		}
		const pageInput = nativeControls.querySelector<HTMLInputElement>('input.pdf-page-input');
		if (pageInput) {
			const placeholder = pageInput.ownerDocument.createElement('span');
			placeholder.className = 'study-pdf-native-page-input-placeholder';
			placeholder.dataset.studyPdfToolbarOwner = restoreId!;
			placeholder.setAttribute('aria-hidden', 'true');
			pageInput.before(placeholder);
			pageGroup.append(pageInput);
		}
		const pageNumbers = nativeControls.querySelector<HTMLElement>('span.pdf-page-numbers');
		if (pageNumbers) {
			const placeholder = pageNumbers.ownerDocument.createElement('span');
			placeholder.className = 'study-pdf-native-page-numbers-placeholder';
			placeholder.dataset.studyPdfToolbarOwner = restoreId!;
			placeholder.setAttribute('aria-hidden', 'true');
			pageNumbers.before(placeholder);
			pageGroup.append(pageNumbers);
		}
		pageGroup.hidden = !pageInput && !pageNumbers;
	}

	const createGroup = (className: string, label: string, parent = scrollContent) => {
		const group = parent.createDiv({ cls: className });
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

	const modes = createGroup('study-pdf-toolbar-modes', 'Selection mode', selectionTools);
	const select = createButton(modes, 'mouse-pointer-2', 'Select', 'study-pdf-mode-button study-pdf-select-tool', () => actions.onMode(false));
	const highlight = createButton(modes, 'highlighter', 'Highlight', 'study-pdf-mode-button', () => actions.onMode(true));

	const area = createButton(modes, 'scan', 'Select area', 'study-pdf-mode-button study-pdf-select-tool', () => actions.onArea?.());

	const palette = createGroup('study-pdf-toolbar-palette', 'Highlight color');
	let signature = '';
	const colorButtons = new Map<string, HTMLButtonElement>();

	const history = createGroup('study-pdf-toolbar-history', 'Annotation history', selectionTools);
	const undo = createButton(history, 'undo', 'Undo', 'study-pdf-history-button', actions.onUndo);
	const redo = createButton(history, 'redo', 'Redo', 'study-pdf-history-button', actions.onRedo);
	const reading = createGroup('study-pdf-toolbar-reading', 'Page, zoom, and reading appearance');
	reading.append(pageGroup);
	if (nativeControls) reading.append(nativeControls);
	const pageNavigation = createPageNavigation(pageGroup, actions);
	let appearancePopup: IconPopup | null = null;
	const appearance = createButton(reading, 'contrast', 'Reading appearance: Original', 'study-pdf-action-button study-pdf-reading-appearance-trigger', () => {
		appearancePopup?.hide();
		appearancePopup = actions.onAppearance(appearance);
	});
	appearance.setAttribute('aria-haspopup', 'dialog');
	appearance.setAttribute('aria-expanded', 'false');
	let pomodoroPopup: IconPopup | null = null;
	const pomodoro = actions.pomodoro ? createPomodoroButton(pinned, actions.pomodoro, (anchor) => {
		if (pomodoroPopup?.el.isConnected) { pomodoroPopup.hide(); pomodoroPopup = null; return; }
		pomodoroPopup = actions.onPomodoro?.(anchor) ?? null;
	}) : null;
	if (pomodoro) pinned.prepend(pomodoro.button);
	const focus = createButton(pinned, 'maximize-2', 'Full screen', 'study-pdf-action-button study-pdf-action-focus', actions.onFocus);
	const overviewSeparator = pinned.createDiv({ cls: 'study-pdf-toolbar-separator' });
	overviewSeparator.setAttribute('aria-hidden', 'true');
	const overview = pinned.createDiv({ cls: 'study-pdf-toolbar-overview' });
	overview.setAttribute('role', 'group');
	overview.setAttribute('aria-label', 'PDF overview');
	createButton(overview, 'list-checks', 'Show all highlights and notes', 'study-pdf-action-button', actions.onShowHighlights);
	let focusIconActive: boolean | null = null;

	const onMouseDown = (event: MouseEvent) => {
		if (event.button !== 0) return;
		const target = event.target as Element | null;
		if (target && typeof target.closest === 'function' && target.closest('.pdf-page-input')) return;
		event.preventDefault(); // Keep the PDF selection alive.
	};
	el.addEventListener('mousedown', onMouseDown);
	el.addEventListener('pointerdown', actions.onPress);
	el.addEventListener('pointercancel', actions.onCancel);

	return {
		el,
		focusButton: focus,
		update(colors, colorId, highlighting, historyStatus, focusActive, readingAppearance, areaSelecting = false) {
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
			select.setAttribute('aria-pressed', String(!highlighting && !areaSelecting));
			highlight.setAttribute('aria-pressed', String(highlighting && !areaSelecting));
			area.setAttribute('aria-pressed', String(areaSelecting));
			undo.disabled = !historyStatus.canUndo;
			redo.disabled = !historyStatus.canRedo;
			for (const [id, button] of colorButtons) button.setAttribute('aria-pressed', String(id === colorId));
			const focusLabel = focusActive ? 'Exit full screen' : 'Full screen';
			focus.setAttribute('aria-label', focusLabel);
			focus.setAttribute('aria-pressed', String(focusActive));
			setTooltip(focus, focusLabel);
			if (focusIconActive !== focusActive) {
				focusIconActive = focusActive;
				setIcon(focus.querySelector<HTMLElement>('.study-pdf-tool-icon') ?? focus, focusActive ? 'minimize-2' : 'maximize-2');
			}
			const appearanceLabel = readingAppearance === 'black-white' ? 'Dark' : readingAppearance === 'sepia' ? 'Sepia' : 'Original';
			const label = `Reading appearance: ${appearanceLabel}`;
			appearance.setAttribute('aria-label', label);
			setTooltip(appearance, label);
		},
		destroy() {
			pageNavigation?.destroy();
			pomodoroPopup?.hide();
			pomodoro?.dispose();
			appearancePopup?.hide();
			appearancePopup = null;
			restoreNativePdfToolbarControls(el, nativeToolbar);
			el.removeEventListener('mousedown', onMouseDown);
			el.removeEventListener('pointerdown', actions.onPress);
			el.removeEventListener('pointercancel', actions.onCancel);
			el.remove();
		},
	};
}
