# Rudi's Study PDF

An independent, MIT-licensed fork of [Study PDF](https://github.com/gris/study-pdf) with custom highlight colors, editable annotations, and a compact reading toolbar.

Maintained by **Rudi Sayat Pulatyan**. Based on João Gris’s Study PDF 0.4.4, commit `b646a401c18624434f770b7a6d78ae725a91d437`. João Gris is the original author and a credited contributor. This fork is not an official Study PDF release and is not listed in Obsidian Community Plugins.

**[Download 0.6.0](https://github.com/rudipyan/study-pdf-local/releases/tag/0.6.0)** · [Report a bug](https://github.com/rudipyan/study-pdf-local/issues)

## What it does

- Choose a custom color, then select text to highlight automatically. Select mode keeps normal reading and copying available.
- Recolor, copy, or remove highlights from their popup. Imported highlights can be copied from the PDF’s selectable text when there is no saved quote.
- Add formatted notes to highlights or right-click a page to add a standalone note. Hover over a note marker to preview it, or click to keep it open. Drag markers to reposition them.
- Select an area around a figure or table to highlight it or copy it as an image.
- Highlight across rendered pages in one save and one undo step.
- Filter the annotation list by color or show only entries with notes. Copy or export the visible entries as Markdown.
- Undo/redo, Fit width, zoom, page navigation, thumbnails, dark and sepia reading modes, and full-screen reading. An on-page return button appears after an internal link jump.
- Optional study timer with adjustable work and break lengths.
- Apple Pencil drag-to-highlight for selectable text; fingers remain available for scrolling. No freehand ink, OCR, or handwriting recognition.
- Optional flashcard export from annotated passages and comments.

Highlights and comments are standard PDF annotations written into the PDF itself. To share the annotated PDF, share that modified file; no separate annotation database is required. The plugin creates no automatic PDF backups.

## Install manually

1. Download **study-pdf-local-0.6.0.zip** from the release above.
2. Extract the `study-pdf-local` folder into `<vault>/.obsidian/plugins/`. Its `main.js`, `manifest.json`, and `styles.css` must be directly inside that folder.
3. Restart Obsidian. In **Settings → Community plugins**, turn off Restricted mode if needed and enable **Rudi's Study PDF**.
4. Disable the original **Study PDF** before enabling this fork, so both do not hook the same PDF viewer.

If upgrading, replace only `main.js`, `manifest.json`, and `styles.css`. Keep your existing settings and the folder name `study-pdf-local`.

On iPad/iPhone, the same three files must reach that device’s vault plugin folder. If using iCloud, wait for synchronization and restart Obsidian on each device; check that the plugin is enabled there. Desktop and mobile Obsidian can have different settings-folder configurations.

## Use

Open a PDF and use the toolbar’s pointer or highlighter icon. Choose a color before highlighting. Click an existing annotation to copy it, change its color, add a note, or delete it using the white circle with a red slash.

The PDF toolbar list button opens **Highlights & notes**. Apply filters before choosing **Copy annotations** or **Export annotations**. Flashcards use a separate `(flashcards).md` note.

On macOS, `H` toggles Highlight, `1`–`9` choose colors, `⌘Z` / `⌘⇧Z` undo/redo, and `Esc` returns to Select before leaving full screen. Click a highlight and press `⌘C` to copy or `Backspace` to remove it. Shortcuts leave editors and modals alone.

## Preview status and limits

This public preview uses the same product code as the local `0.4.4-local.62` build.

- The production build and 571 automated tests passed. Lint reported 40 warnings and zero errors.
- Live Obsidian interactions on macOS and physical iPad/iPhone/Pencil behavior have not been systematically verified for this build.
- The plugin uses undocumented Obsidian PDF.js internals, which can change between Obsidian versions. Integration source was inspected against PDF.js 5.3.34. The inherited minimum Obsidian version is not a verified compatibility matrix.
- Password-to-open PDFs cannot be modified. Scanned PDFs without a selectable text layer cannot be text-highlighted.
- Text recovered from imported highlights can be approximate on complex layouts. Recoloring a supported imported highlight can replace custom styling with the standard highlight appearance.
- Note dictation depends on the host app’s speech recognition support. The host speech service may process audio online.
- Cross-page text highlights require complete rendered text/geometry; incomplete selections are rejected rather than partially saved.
- Undo history is temporary and size-limited: up to 30 steps per PDF and 64 MiB total. Very large operations may not fit.
- Failed note saves retain the draft while the editor stays open; drafts are lost if it is dismissed or the plugin unloads.
- PDF files are rewritten on saves. Structural verification remains enabled, but concurrent edits from another reader/device are unsupported. Keep copies of files you cannot replace.
- Performance changes are implemented; no timing benchmark is claimed.

## Development

Requires Node.js and npm. Install dependencies with `npm ci`, build with `npm run build`, and check changes with `npm test` and `npm run lint`. `npm run dev` watches the source.

`main.js` is generated and ignored by Git; compiled files are attached to releases. Releases are published manually, not by an inherited automatic workflow. See [CONTRIBUTING.md](CONTRIBUTING.md).

## Attribution and license

Original project: [Study PDF by João Gris](https://github.com/gris/study-pdf). This fork preserves upstream history and the original copyright/license notice. Fork maintenance and additions: Rudi Sayat Pulatyan. Distributed under the [MIT License](LICENSE). Bundled dependency notices are preserved in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
