# Study PDF Local

An independent, MIT-licensed fork of [Study PDF](https://github.com/gris/study-pdf) with custom highlight colors, editable annotations, and a compact reading toolbar.

Maintained by **Rudi Sayat Pulatyan**. Based on João Gris’s Study PDF 0.4.4, commit `b646a401c18624434f770b7a6d78ae725a91d437`. João Gris is the original author and a credited contributor. This fork is not an official Study PDF release and is not listed in Obsidian Community Plugins.

**[Download 0.5.0](https://github.com/rudipyan/study-pdf-local/releases/tag/0.5.0)** · [Report a bug](https://github.com/rudipyan/study-pdf-local/issues)

## What it does

- Choose a custom color, then select text to highlight automatically. Select mode keeps normal reading and copying available.
- Change an existing highlight’s color directly from its popup, add/edit a comment, or remove it.
- Highlight across rendered pages in one save and one undo step.
- Browse annotations and copy/export all or a selected subset as Markdown with links back to the PDF. Full quotation text is retained; list previews are shortened.
- Undo/redo, Fit width, and full-screen reading with a centered icon toolbar and pinned exit control.
- Apple Pencil drag-to-highlight for selectable text; fingers remain available for scrolling. No freehand ink, OCR, or handwriting recognition.
- Optional flashcard export from annotated passages and comments.

Highlights and comments are standard PDF annotations written into the PDF itself. To share the annotated PDF, share that modified file; no separate annotation database is required. The plugin creates no automatic PDF backups.

## Install manually

1. Download **study-pdf-local-0.5.0.zip** from the release above.
2. Extract the `study-pdf-local` folder into `<vault>/.obsidian/plugins/`. Its `main.js`, `manifest.json`, and `styles.css` must be directly inside that folder.
3. Restart Obsidian. In **Settings → Community plugins**, turn off Restricted mode if needed and enable **Study PDF Local**.
4. Disable the original **Study PDF** before enabling this fork, so both do not hook the same PDF viewer.

If upgrading the private local fork, replace only `main.js`, `manifest.json`, and `styles.css`; keep your existing `data.json` settings file. Keep the folder name `study-pdf-local`.

On iPad/iPhone, the same three files must reach that device’s vault plugin folder. If using iCloud, wait for synchronization and restart Obsidian on each device; check that the plugin is enabled there. Desktop and mobile Obsidian can have different settings-folder configurations.

## Use

Open a PDF and use the toolbar’s pointer or highlighter icon. Choose a color before highlighting. Click an existing annotation to change color, add a note, or delete it using the white circle with a red slash.

The PDF toolbar list button opens the annotation overview. Select rows for subset copy/export. Full export writes `<PDF name> (highlights).md`; selected export writes `<PDF name> (highlights selection).md`. Export replaces only its managed block, preserving surrounding text. Flashcards use a separate `(flashcards).md` note.

On macOS, `H` toggles Highlight, `1`–`9` choose colors, `⌘Z` / `⌘⇧Z` undo/redo, and `Esc` returns to Select before leaving full screen. Shortcuts leave editors and modals alone.

## Preview status and limits

This is the first public preview of the private `.19` fork, published as `0.5.0`. The product code and bundle match that reviewed local build. The experimental region-quotation tool was removed before this public release.

- Production build/TypeScript passed. Lint passed with zero errors and 20 warnings. An independent source review and browser layout previews were completed.
- The automated test suite was not run for this release; inherited and local tests are included as development material, not a claim of passing coverage.
- Live Obsidian interactions on macOS and physical iPad/iPhone/Pencil behavior have not been systematically verified for this build. Device support is implemented, not certified.
- The plugin uses undocumented Obsidian PDF.js internals, which can change between Obsidian versions. Integration source was inspected against PDF.js 5.3.34. The inherited minimum Obsidian version is not a verified compatibility matrix.
- Password-to-open PDFs cannot be modified. Scanned PDFs without a selectable text layer cannot be text-highlighted.
- Cross-page text highlights require complete rendered text/geometry; incomplete selections are rejected rather than partially saved.
- Undo history is temporary and size-limited: up to 30 steps per PDF and 64 MiB total. Very large operations may not fit.
- Failed note saves retain the draft while the editor stays open; drafts are lost if it is dismissed or the plugin unloads.
- PDF files are rewritten on saves. Structural verification remains enabled, but concurrent edits from another reader/device are unsupported. Keep copies of files you cannot replace.
- Performance changes are implemented; no timing benchmark is claimed.

## Development

Requires Node.js and npm. Install dependencies with `npm ci`, build with `npm run build`, and lint with `npm run lint`. `npm test` is available when explicitly running the test suite. `npm run dev` watches the source.

`main.js` is generated and ignored by Git; compiled files are attached to releases. Releases are published manually, not by an inherited automatic workflow. See [CONTRIBUTING.md](CONTRIBUTING.md).

## Attribution and license

Original project: [Study PDF by João Gris](https://github.com/gris/study-pdf). This fork preserves upstream history and the original copyright/license notice. Fork maintenance and additions: Rudi Sayat Pulatyan. Distributed under the [MIT License](LICENSE). Bundled dependency notices are preserved in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
