import { setTooltip } from 'obsidian';
import type { HighlightInfo, HighlightTarget, RgbColor } from '../annotate';
import type { HighlightColorOption } from '../color-palette';
import { candidateAccessibleLabel, defaultFirstColors } from '../palette-editor';
import { positionPopup, trackPopupPosition, type IconPopup } from './icon-popup';

export interface CandidateChoice extends Pick<HighlightInfo, 'target' | 'note' | 'quote' | 'currentColor' | 'unsupportedReason'> {
	pageIndex: number;
}

export interface CandidateChoiceActions {
	onRecolor(target: HighlightTarget, color: RgbColor): void;
	onEditNote(candidate: CandidateChoice): void;
	onRemove(candidate: CandidateChoice): void;
	onDismiss?(): void;
}

export function showColorPaletteModal(
	doc: Document,
	position: { x: number; y: number },
	candidates: readonly CandidateChoice[],
	colors: readonly HighlightColorOption[],
	defaultColorId: string,
	actions: CandidateChoiceActions,
): IconPopup {
	const el = doc.body.createDiv({ cls: 'study-pdf-popup study-pdf-candidate-modal' });
	el.setAttribute('role', 'dialog');
	el.setAttribute('aria-label', 'Annotation actions');
	el.tabIndex = -1;
	el.addEventListener('mousedown', (event) => event.preventDefault());
	const list = el.createDiv({ cls: 'study-pdf-candidate-list' });
	const palette = defaultFirstColors({ colors: [...colors], defaultColorId });
	for (const [candidateIndex, candidate] of candidates.entries()) {
		const candidateLabel = candidateAccessibleLabel(candidate, candidateIndex, candidates.length);
		const item = list.createDiv({ cls: 'study-pdf-candidate' });
		item.setAttribute('role', 'group');
		item.setAttribute('aria-label', candidateLabel);
		if (candidates.length > 1) {
			item.createDiv({ cls: 'study-pdf-candidate-label', text: `Annotation ${candidateIndex + 1}` });
		}
		if (candidate.unsupportedReason) {
			item.createDiv({ cls: 'study-pdf-candidate-unsupported', text: `Color cannot be changed: ${candidate.unsupportedReason}` });
		}
		if (!candidate.target) {
			item.createDiv({
				cls: 'study-pdf-candidate-unsupported',
				text: 'This annotation cannot be edited because it has no stable reference in the PDF.',
			});
		}

		const actionRow = item.createDiv({ cls: 'study-pdf-candidate-actions' });
		const canAddressTarget = candidate.target !== null;
		const noteLabel = candidate.note?.trim() ? 'Edit note' : 'Add note';
		const note = actionRow.createEl('button', { text: noteLabel });
		note.type = 'button';
		note.disabled = !canAddressTarget;
		note.setAttribute('aria-label', `${noteLabel} for ${candidateLabel}`);
		note.addEventListener('click', () => {
			if (candidate.target) actions.onEditNote(candidate);
		});

		const colorRow = actionRow.createDiv({ cls: 'study-pdf-candidate-color-options' });
		colorRow.setAttribute('role', 'group');
		colorRow.setAttribute('aria-label', `Change color for ${candidateLabel}`);
		for (const color of palette) {
			const colorButton = colorRow.createEl('button', { cls: 'study-pdf-annotation-color' });
			colorButton.type = 'button';
			colorButton.disabled = !candidate.target || Boolean(candidate.unsupportedReason);
			const isCurrent = candidate.currentColor !== null && sameRgbColor(candidate.currentColor, colorToRgb(color.hex));
			colorButton.setAttribute('aria-pressed', String(isCurrent));
			colorButton.setAttribute('aria-label', `Change ${candidateLabel} to ${color.name}${isCurrent ? ', current color' : ''}${color.id === defaultColorId ? ', default color' : ''}`);
			setTooltip(colorButton, `${color.name}${isCurrent ? ' (current)' : ''}`);
			const dot = colorButton.createSpan({ cls: 'study-pdf-color-dot' });
			dot.setCssStyles({ backgroundColor: color.hex });
			colorButton.addEventListener('click', () => {
				if (candidate.target && !candidate.unsupportedReason) actions.onRecolor(candidate.target, { ...colorToRgb(color.hex) });
			});
		}

		const remove = colorRow.createEl('button', { cls: 'study-pdf-annotation-color study-pdf-annotation-remove' });
		remove.type = 'button';
		remove.disabled = !canAddressTarget;
		remove.setAttribute('aria-label', `Remove annotation (${candidateLabel})`);
		setTooltip(remove, 'Remove annotation');
		const removeDot = remove.createSpan({ cls: 'study-pdf-color-dot study-pdf-remove-dot' });
		removeDot.setAttribute('aria-hidden', 'true');
		remove.addEventListener('click', () => {
			if (candidate.target) actions.onRemove(candidate);
		});

	}
	positionPopup(doc, el, position);
	const stopPositionTracking = trackPopupPosition(doc, el, position);
	let closed = false;
	const onKeyDown = (event: KeyboardEvent) => {
		if (event.key !== 'Escape') return;
		event.preventDefault();
		hide();
	};
	const hide = () => {
		if (closed) return;
		closed = true;
		stopPositionTracking();
		doc.removeEventListener('keydown', onKeyDown);
		el.remove();
		actions.onDismiss?.();
	};
	doc.addEventListener('keydown', onKeyDown);
	return { el, preserveOnScroll: true, reposition: () => positionPopup(doc, el, position), hide };
}

function colorToRgb(hex: string): RgbColor {
	const value = hex.slice(1);
	return {
		r: parseInt(value.slice(0, 2), 16) / 255,
		g: parseInt(value.slice(2, 4), 16) / 255,
		b: parseInt(value.slice(4, 6), 16) / 255,
	};
}

function sameRgbColor(a: RgbColor, b: RgbColor): boolean {
	return Math.abs(a.r - b.r) < 1e-6 && Math.abs(a.g - b.g) < 1e-6 && Math.abs(a.b - b.b) < 1e-6;
}
