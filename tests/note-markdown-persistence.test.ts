import { describe, expect, it } from 'vitest';
import { addHighlightAnnotation, getStoredQuotes, inspectHighlightAt, setHighlightNoteAt } from '../src/annotate';
import { loadPdfjsDoc, makeFixturePdfBytes } from './helpers/pdf-fixture';

const COLOR = { r: 1, g: 0.92, b: 0.2 };
const BOX = { left: 10, right: 100, top: 220, bottom: 200 };
const PROBE = { left: 50, right: 50, top: 210, bottom: 210 };
const QUAD = [BOX.left, BOX.top, BOX.right, BOX.top, BOX.left, BOX.bottom, BOX.right, BOX.bottom];

describe('formatted annotation note persistence', () => {
	it('saves and reopens Markdown source verbatim in the PDF annotation comment', async () => {
		const original = await makeFixturePdfBytes();
		const highlighted = await addHighlightAnnotation(original, {
			pageIndex: 0,
			quadPoints: QUAD,
			box: BOX,
			color: COLOR,
			quote: 'the original highlighted quote',
		});
		const markdown = '**Bold café** and *italic*\n\n- first item\n- second item';
		const saved = await setHighlightNoteAt(highlighted, { pageIndex: 0, box: PROBE, note: markdown });
		expect(saved.updatedCount).toBe(1);

		const reopened = await loadPdfjsDoc(saved.bytes);
		const annotations = await (await reopened.getPage(1)).getAnnotations();
		expect(annotations[0]?.contentsObj?.str).toBe(markdown);
		expect(await inspectHighlightAt(saved.bytes, { pageIndex: 0, box: PROBE })).toMatchObject({ note: markdown });
		expect((await getStoredQuotes(saved.bytes)).get(0)).toEqual(['the original highlighted quote']);
	});
});
