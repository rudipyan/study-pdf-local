// "Show all highlights and notes": a native Obsidian Modal listing every
// highlight and standalone note in the open PDF -- color dot, the highlighted text
// (recovered by matching the annotation's QuadPoints against the page's text
// items), the note if any, and the page number. Clicking a row jumps there.
//
// UI glue only: the reading of the live pdf.js document lives in
// pdf-highlights.ts and the Markdown shapes in highlight-export.ts, both shared
// with the "Export highlights to note" command.
import { Modal, Notice, setTooltip, type App } from 'obsidian';
import { getAllPdfViews, type ActivePdfView } from '../obsidian-pdf-internals';
import { capturePdfTarget, isCapturedPdfCurrent, isCapturedPdfViewLive, type CapturedPdfTarget, type PdfMutationCoordinator } from '../pdf-mutation';
import { withPdfHighlightSnapshot } from '../pdf-highlight-snapshot';
import { excerptQuote } from '../pdf-text-extraction';
import type { HighlightEntry } from '../pdf-highlights';
import { formatQuoteBlock } from '../highlight-export';
import { collectHighlightColors, filterHighlightsByColor } from './highlight-color-filter';
import { renderNoteMarkdown } from './note-markdown';

export class HighlightListModal extends Modal {
	private readonly pdfView: ActivePdfView;
	private readonly onExport: () => Promise<void>;
	private readonly onExportSelection: (entries: HighlightEntry[], snapshotFingerprint: string) => Promise<void>;
	private readonly coordinator: PdfMutationCoordinator;
	private readonly capture: CapturedPdfTarget<ActivePdfView['file'], ActivePdfView>;
	private closed = false;
	private scanController: AbortController | null = null;
	private scannedSnapshotFingerprint: string | null = null;

	constructor(
		app: App,
		pdfView: ActivePdfView,
		coordinator: PdfMutationCoordinator,
		onExport: () => Promise<void>,
		onExportSelection: (entries: HighlightEntry[], snapshotFingerprint: string) => Promise<void>,
	) {
		super(app);
		this.pdfView = pdfView;
		this.coordinator = coordinator;
		this.onExport = onExport;
		this.onExportSelection = onExportSelection;
		this.capture = capturePdfTarget(pdfView.file, pdfView);
	}

	private assertCurrent() {
		if (this.closed || !isCapturedPdfCurrent(this.capture, (path) => this.app.vault.getAbstractFileByPath(path)) ||
			!isCapturedPdfViewLive(this.capture, getAllPdfViews(this.app))) {
			throw new Error('The PDF changed or closed. Open the highlights list again.');
		}
	}

	async onOpen() {
		this.closed = false;
		this.titleEl.setText('Highlights & notes');
		this.contentEl.addClass('study-pdf-list');
		this.contentEl.setText('Scanning document…');
		const controller = new AbortController();
		this.scanController = controller;
		try {
			await withPdfHighlightSnapshot({
				path: this.capture.path,
				pdfView: this.pdfView,
				coordinator: this.coordinator,
				read: () => this.app.vault.readBinary(this.pdfView.file),
				assertCurrent: () => this.assertCurrent(),
				signal: controller.signal,
				onProgress: (pageNumber, pageCount) => {
					if (!this.closed) this.contentEl.setText(`Scanning document… ${pageNumber}/${pageCount}`);
				},
			}, async (entries, snapshotFingerprint) => {
				this.assertCurrent();
				this.scannedSnapshotFingerprint = snapshotFingerprint;
				this.render(entries);
			});
		} catch (err) {
			if (!this.closed) this.contentEl.setText(`Could not read highlights -- ${(err as Error).message}`);
		} finally {
			if (this.scanController === controller) this.scanController = null;
		}
	}

	onClose() {
		this.closed = true;
		this.scanController?.abort();
		this.scanController = null;
		this.scannedSnapshotFingerprint = null;
		this.contentEl.empty();
	}

	private async copyToClipboard(text: string, what: string): Promise<boolean> {
		try {
			await navigator.clipboard.writeText(text);
			new Notice(`Copied ${what} to clipboard.`);
			return true;
		} catch (error) {
			new Notice(`Could not copy ${what}: ${(error as Error).message}`);
			return false;
		}
	}

	/** Plain Markdown: just the quoted text and the note, no link. */
	private formatEntryText(entry: HighlightEntry): string {
		if (entry.standaloneNote) return entry.note ?? '';
		return formatQuoteBlock(entry.quote || '(no text)', entry.note);
	}

	private render(entries: HighlightEntry[]) {
		const { contentEl } = this;
		contentEl.empty();
		if (entries.length === 0) {
			contentEl.setText('No highlights or notes in this PDF.');
			return;
		}

		const toolbar = contentEl.createDiv({ cls: 'study-pdf-list-toolbar' });
		const selectedColors = new Set<string>();
		const highlights = entries.filter((entry) => !entry.standaloneNote);
		let withNotes = false;
		const filtersActive = () => withNotes || selectedColors.size > 0;
		const visibleEntries = () => {
			const matchingColors = selectedColors.size > 0 ? filterHighlightsByColor(highlights, selectedColors) : entries;
			return withNotes ? matchingColors.filter((entry) => entry.note?.trim()) : matchingColors;
		};
		const copyAnnotations = toolbar.createEl('button', { text: 'Copy annotations' });
		setTooltip(copyAnnotations, 'Copy the visible highlights and notes as plain Markdown, without links');
		copyAnnotations.addEventListener('click', () => {
			const visible = visibleEntries();
			void this.copyToClipboard(visible.map((entry) => this.formatEntryText(entry)).join('\n\n'), visible.length + ' annotations');
		});
		const exportAnnotations = toolbar.createEl('button', { text: 'Export annotations' });
		setTooltip(exportAnnotations, 'Export the visible highlights and notes');
		exportAnnotations.addEventListener('click', () => {
			try { this.assertCurrent(); } catch { this.close(); return; }
			if (filtersActive()) {
				const snapshotFingerprint = this.scannedSnapshotFingerprint;
				if (!snapshotFingerprint) return;
				const visible = visibleEntries();
				this.close();
				void this.onExportSelection(visible, snapshotFingerprint);
				return;
			}
			this.close();
			void this.onExport();
		});

		const filterToolbar = contentEl.createDiv({ cls: 'study-pdf-list-filters' });
		filterToolbar.setAttribute('role', 'group');
		filterToolbar.setAttribute('aria-label', 'Filter annotations');
		const filterStatus = contentEl.createDiv({ cls: 'study-pdf-list-filter-status' });
		filterStatus.setAttribute('role', 'status');
		filterStatus.setAttribute('aria-live', 'polite');

		const filterButtons = new Map<string, HTMLButtonElement>();
		const allColors = filterToolbar.createEl('button', { text: 'All colors' });
		allColors.type = 'button';
		allColors.setAttribute('aria-pressed', 'true');
		const notesFilter = filterToolbar.createEl('button', { cls: 'study-pdf-list-filter', text: 'With notes' });
		notesFilter.type = 'button';
		notesFilter.setAttribute('aria-pressed', 'false');
		const colorFilters = collectHighlightColors(highlights);
		const rowContainer = contentEl.createDiv({ cls: 'study-pdf-list-rows' });
		const renderRows = () => {
			rowContainer.empty();
			const visible = visibleEntries();
			copyAnnotations.disabled = visible.length === 0;
			exportAnnotations.disabled = visible.length === 0;
			filterStatus.setText(filtersActive()
				? `${visible.length} of ${entries.length} annotations shown.`
				: '');
			for (const entry of visible) {
				const row = rowContainer.createDiv({ cls: 'study-pdf-list-row' });
				const dot = row.createSpan({ cls: 'study-pdf-color-dot' });
				dot.setCssStyles({ backgroundColor: entry.colorCss });
				const body = row.createDiv({ cls: 'study-pdf-list-body' });
				if (!entry.standaloneNote) {
					body.createDiv({ cls: 'study-pdf-list-quote', text: excerptQuote(entry.quote) || '(no text)' });
				}
				if (entry.note) renderNoteMarkdown(body.createDiv({ cls: 'study-pdf-list-note' }), entry.note);
				row.createDiv({ cls: 'study-pdf-list-page', text: 'p. ' + entry.pageNumber });

				row.addEventListener('click', () => {
					if (!this.pdfView.containerEl.ownerDocument.defaultView?.getSelection()?.isCollapsed) return;
					try { this.assertCurrent(); } catch { this.close(); return; }
					this.pdfView.goToPage(entry.pageNumber);
					this.close();
				});
			}
		};
		allColors.addEventListener('click', () => {
			if (selectedColors.size === 0) return;
			selectedColors.clear();
			for (const button of filterButtons.values()) button.setAttribute('aria-pressed', 'false');
			allColors.setAttribute('aria-pressed', 'true');
			renderRows();
		});
		notesFilter.addEventListener('click', () => {
			withNotes = !withNotes;
			notesFilter.setAttribute('aria-pressed', String(withNotes));
			renderRows();
		});
		for (const { colorCss, count } of colorFilters) {
			const button = filterToolbar.createEl('button', { cls: 'study-pdf-list-filter' });
			button.type = 'button';
			button.setAttribute('aria-label', `Filter to ${colorCss}, ${count} highlight${count === 1 ? '' : 's'}`);
			button.setAttribute('aria-pressed', 'false');
			const swatch = button.createSpan({ cls: 'study-pdf-list-filter-swatch' });
			swatch.setCssStyles({ backgroundColor: colorCss });
			button.createSpan({ cls: 'study-pdf-list-filter-count', text: String(count) });
			filterButtons.set(colorCss, button);
			button.addEventListener('click', () => {
				if (selectedColors.has(colorCss)) selectedColors.delete(colorCss);
				else selectedColors.add(colorCss);
				for (const [color, filterButton] of filterButtons) {
					filterButton.setAttribute('aria-pressed', String(selectedColors.has(color)));
				}
				allColors.setAttribute('aria-pressed', String(selectedColors.size === 0));
				renderRows();
			});
		}
		renderRows();
	}
}
