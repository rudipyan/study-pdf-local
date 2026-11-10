import { describe, expect, it } from 'vitest';
import { addHighlightAnnotation, addPageNote, getStoredQuotes } from '../src/annotate';
import { collectHighlights } from '../src/pdf-highlights';
import { loadPdfjsDoc, makeFixturePdfBytes } from './helpers/pdf-fixture';

describe('standalone PDF notes', () => {
	it('survives reopening as a native comment at the chosen point alongside existing highlights', async () => {
		const original = await addHighlightAnnotation(await makeFixturePdfBytes(), {
			pageIndex: 0, quadPoints: [10, 40, 80, 40, 10, 30, 80, 30],
			box: { left: 10, right: 80, top: 40, bottom: 30 }, color: { r: 1, g: 1, b: 0 }, quote: 'An existing highlight',
		});
		const note = 'Page comment — **revisit this**';
		const saved = await addPageNote(original, { pageIndex: 0, point: { x: 398, y: 2 }, note });
		const doc = await loadPdfjsDoc(saved);
		try {
			const annotations = await (await doc.getPage(1)).getAnnotations();
			const comment = annotations.find((annotation: { subtype: string }) => annotation.subtype === 'Text');
			expect(comment).toMatchObject({ contentsObj: { str: note }, name: 'Comment', rect: [378, 0, 400, 22] });
			const entries = await collectHighlights(doc, await getStoredQuotes(saved));
			expect(entries).toHaveLength(2);
			expect(entries).toContainEqual(expect.objectContaining({ pageNumber: 1, quote: '', note, standaloneNote: true, annotationId: comment.id }));
			expect(entries).toContainEqual(expect.objectContaining({ pageNumber: 1, quote: 'An existing highlight', note: null }));
		} finally {
			await doc.loadingTask.destroy();
		}
	});

	it('rejects an empty draft and invalid page location', async () => {
		const bytes = await makeFixturePdfBytes();
		await expect(addPageNote(bytes, { pageIndex: 0, point: { x: 25, y: 20 }, note: ' ' })).rejects.toThrow(/needs text/);
		await expect(addPageNote(bytes, { pageIndex: 1, point: { x: 25, y: 20 }, note: 'note' })).rejects.toThrow(/page does not exist/);
	});
});
