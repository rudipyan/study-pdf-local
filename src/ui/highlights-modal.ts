// "Show all highlights and notes": a native Obsidian Modal listing every
// /Highlight annotation in the open PDF -- color dot, the highlighted text
// (recovered by matching the annotation's QuadPoints against the page's text
// items), the note if any, and the page number. Clicking a row jumps there.
//
// UI glue only: the reading of the live pdf.js document lives in
// pdf-highlights.ts and the Markdown shapes in highlight-export.ts, both shared
// with the "Export highlights to note" command.
import { Modal, Notice, setIcon, setTooltip, type App } from 'obsidian';
import { getAllPdfViews, type ActivePdfView } from '../obsidian-pdf-internals';
import { capturePdfTarget, isCapturedPdfCurrent, isCapturedPdfViewLive, type CapturedPdfTarget, type PdfMutationCoordinator } from '../pdf-mutation';
import { withPdfHighlightSnapshot } from '../pdf-highlight-snapshot';
import { excerptQuote } from '../pdf-text-extraction';
import type { HighlightEntry } from '../pdf-highlights';
import { buildEntryLink, formatQuoteBlock } from '../highlight-export';

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

	/** Markdown where the quoted text itself IS the deep link: clicking it in a
	 * note reopens the PDF at this exact annotation. Note follows, if any. */
	private formatEntryAsLink(entry: HighlightEntry): string {
		const link = buildEntryLink(entry, (subpath, alias) =>
			this.app.fileManager.generateMarkdownLink(this.pdfView.file, '', subpath, alias),
		);
		return formatQuoteBlock(link, entry.note);
	}

	/** Plain Markdown: just the quoted text and the note, no link. */
	private formatEntryText(entry: HighlightEntry): string {
		return formatQuoteBlock(entry.quote || '(no text)', entry.note);
	}

	private render(entries: HighlightEntry[]) {
		const { contentEl } = this;
		contentEl.empty();
		if (entries.length === 0) {
			contentEl.setText('No highlights in this PDF.');
			return;
		}

		const toolbar = contentEl.createDiv({ cls: 'study-pdf-list-toolbar' });
		const selectedIndexes = new Set<number>();
		const selectedEntries = () => entries.filter((_entry, index) => selectedIndexes.has(index));
		const selectedCopyLinks = toolbar.createEl('button', { text: 'Copy selected links' });
		const selectedCopyText = toolbar.createEl('button', { text: 'Copy selected text' });
		const selectedExport = toolbar.createEl('button', { text: 'Export selection' });
		const updateSelectedActions = () => {
			const disabled = selectedIndexes.size === 0;
			selectedCopyLinks.disabled = disabled;
			selectedCopyText.disabled = disabled;
			selectedExport.disabled = disabled;
		};
		selectedCopyLinks.addEventListener('click', () => {
			const selected = selectedEntries();
			void this.copyToClipboard(selected.map((entry) => this.formatEntryAsLink(entry)).join('\n\n'), `${selected.length} selected highlights as links`);
		});
		selectedCopyText.addEventListener('click', () => {
			const selected = selectedEntries();
			void this.copyToClipboard(selected.map((entry) => this.formatEntryText(entry)).join('\n\n'), `${selected.length} selected highlights`);
		});
		selectedExport.addEventListener('click', () => {
			const selected = selectedEntries();
			if (selected.length === 0 || !this.scannedSnapshotFingerprint) return;
			const snapshotFingerprint = this.scannedSnapshotFingerprint;
			this.close();
			void this.onExportSelection(selected, snapshotFingerprint);
		});
		updateSelectedActions();

		const copyAllLinks = toolbar.createEl('button', { text: 'Copy all as links' });
		setTooltip(copyAllLinks, 'Copy every highlight as a clickable annotation link (plus notes)');
		copyAllLinks.addEventListener('click', () => {
			void this.copyToClipboard(
				entries.map((e) => this.formatEntryAsLink(e)).join('\n\n'),
				`${entries.length} highlights as links`,
			);
		});
		const copyAllText = toolbar.createEl('button', { text: 'Copy all text' });
		setTooltip(copyAllText, 'Copy every highlight and note as plain Markdown, no links');
		copyAllText.addEventListener('click', () => {
			void this.copyToClipboard(
				entries.map((e) => this.formatEntryText(e)).join('\n\n'),
				`${entries.length} highlights`,
			);
		});

		// Last, not first: this one writes a file, so it shouldn't sit where the
		// copy buttons have trained the user's click to land. Closing first keeps
		// the modal from covering the note when a new one opens in a tab.
		const exportToNote = toolbar.createEl('button', { text: 'Export to note' });
		setTooltip(exportToNote, 'Write these highlights into a note beside the PDF');
		exportToNote.addEventListener('click', () => {
			try { this.assertCurrent(); } catch { this.close(); return; }
			this.close();
			void this.onExport();
		});

		for (const [entryIndex, entry] of entries.entries()) {
			const row = contentEl.createDiv({ cls: 'study-pdf-list-row' });
			const checkbox = row.createEl('input');
			checkbox.type = 'checkbox';
			checkbox.setAttribute('aria-label', `Select highlight on page ${entry.pageNumber}`);
			checkbox.addEventListener('click', (event) => event.stopPropagation());
			checkbox.addEventListener('change', () => {
				if (checkbox.checked) selectedIndexes.add(entryIndex);
				else selectedIndexes.delete(entryIndex);
				updateSelectedActions();
			});
			const dot = row.createSpan({ cls: 'study-pdf-color-dot' });
			dot.setCssStyles({ backgroundColor: entry.colorCss });
			const body = row.createDiv({ cls: 'study-pdf-list-body' });
			body.createDiv({ cls: 'study-pdf-list-quote', text: excerptQuote(entry.quote) || '(no text)' });
			if (entry.note) body.createDiv({ cls: 'study-pdf-list-note', text: entry.note });
			row.createDiv({ cls: 'study-pdf-list-page', text: `p. ${entry.pageNumber}` });

			const makeCopyButton = (icon: string, tooltip: string, format: () => string) => {
				const btn = row.createEl('button', { cls: 'clickable-icon study-pdf-list-copy' });
				setIcon(btn, icon);
				setTooltip(btn, tooltip);
				btn.addEventListener('click', (evt) => {
					evt.stopPropagation(); // don't also navigate
					void this.copyToClipboard(format(), 'highlight').then((copied) => {
						if (!copied) return;
						setIcon(btn, 'check');
						this.pdfView.containerEl.ownerDocument.defaultView?.setTimeout(() => setIcon(btn, icon), 1200);
					});
				});
			};
			makeCopyButton('link', 'Copy as annotation link', () => this.formatEntryAsLink(entry));
			makeCopyButton('copy', 'Copy text only', () => this.formatEntryText(entry));

			row.addEventListener('click', () => {
				// Selecting text inside the row shouldn't teleport the viewer -- only
				// treat plain clicks as navigation.
				if (!this.pdfView.containerEl.ownerDocument.defaultView?.getSelection()?.isCollapsed) return;
				try { this.assertCurrent(); } catch { this.close(); return; }
				this.pdfView.goToPage(entry.pageNumber);
				this.close();
			});
		}
	}
}
