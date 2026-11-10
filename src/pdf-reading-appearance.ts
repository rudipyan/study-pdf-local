export type PdfReadingAppearance = 'original' | 'black-white' | 'sepia';

export const PDF_READING_APPEARANCES: readonly { id: PdfReadingAppearance; label: string }[] = [
	{ id: 'original', label: 'Original' },
	{ id: 'black-white', label: 'Dark' },
	{ id: 'sepia', label: 'Sepia' },
];

const APPEARANCE_CLASSES = [
	'study-pdf-reading-appearance-black-white',
	'study-pdf-reading-appearance-sepia',
] as const;

export function setPdfReadingAppearance(containerEl: HTMLElement, appearance: PdfReadingAppearance) {
	containerEl.classList.toggle(APPEARANCE_CLASSES[0], appearance === 'black-white');
	containerEl.classList.toggle(APPEARANCE_CLASSES[1], appearance === 'sepia');
}

export function clearPdfReadingAppearance(containerEl: HTMLElement) {
	containerEl.classList.remove(...APPEARANCE_CLASSES);
}
