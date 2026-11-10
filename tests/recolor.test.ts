import { describe, expect, it, vi } from 'vitest';
import { PDFDocument, PDFArray, PDFDict, PDFHexString, PDFName, PDFNumber, PDFRawStream, PDFRef, PDFString } from '@cantoo/pdf-lib';
import {
	addHighlightAnnotation,
	buildHighlightIndex,
	findHighlightsAtPoint,
	findHighlightsInIndexAtPoint,
	setHighlightColorAt,
	setHighlightNoteAt,
	setHighlightNoteForTarget,
} from '../src/annotate';
import * as annotate from '../src/annotate';
import type { HighlightTarget } from '../src/annotate';

const YELLOW = { r: 1, g: 0.92, b: 0.2 };
const BLUE = { r: 0.12, g: 0.34, b: 0.78 };
const SLANTED = {
	quadPoints: [20, 40, 80, 50, 25, 20, 85, 30],
	box: { left: 20, right: 85, top: 50, bottom: 20 },
};

async function fixture(pageCount = 1): Promise<Uint8Array> {
	const doc = await PDFDocument.create();
	for (let index = 0; index < pageCount; index++) doc.addPage([400, 300]);
	return doc.save();
}

async function encryptedFixture(userPassword?: string): Promise<Uint8Array> {
	const doc = await PDFDocument.create();
	doc.addPage([400, 300]);
	doc.encrypt({
		ownerPassword: 'owner-secret',
		...(userPassword ? { userPassword } : {}),
		permissions: { modifying: false, annotating: false, copying: false },
	});
	return doc.save();
}

async function fingerprint(bytes: Uint8Array): Promise<string> {
	const view = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const digest = await globalThis.crypto.subtle.digest('SHA-256', view as BufferSource);
	return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, '0')).join('');
}

async function firstHighlight(bytes: Uint8Array, pageIndex = 0): Promise<{ ref: PDFRef; target: HighlightTarget }> {
	const candidate = (await findHighlightsAtPoint(bytes, pageIndex, { x: 52, y: 35 }))[0];
	if (!candidate?.target) throw new Error('Fixture does not have a recolorable highlight at the probe point.');
	const doc = await PDFDocument.load(bytes);
	const annots = doc.getPage(pageIndex).node.lookupMaybe(PDFName.of('Annots'), PDFArray)!;
	const ref = annots.asArray().find((value) => value instanceof PDFRef && value.objectNumber === candidate.target!.objectNumber && value.generationNumber === candidate.target!.generationNumber);
	if (!(ref instanceof PDFRef)) throw new Error('Fixture highlight target is not present in the page annotation array.');
	return { ref, target: candidate.target };
}

function readNormalAppearance(doc: PDFDocument, dict: PDFDict): { stream: PDFRawStream; text: string; ca: number; blendMode: string } {
	const ap = doc.context.lookup(dict.get(PDFName.of('AP'))!, PDFDict);
	const normal = ap.get(PDFName.of('N'))!;
	const stream = doc.context.lookup(normal) as PDFRawStream;
	const resources = doc.context.lookup(stream.dict.get(PDFName.of('Resources'))!, PDFDict);
	const graphicsStates = doc.context.lookup(resources.get(PDFName.of('ExtGState'))!, PDFDict);
	const gs = doc.context.lookup(graphicsStates.get(PDFName.of('GS0'))!, PDFDict);
	return {
		stream,
		text: stream.getContentsString(),
		ca: gs.lookup(PDFName.of('ca'), PDFNumber).asNumber(),
		blendMode: gs.get(PDFName.of('BM'))!.toString(),
	};
}

describe('safe PDF highlight recoloring', () => {
	it('recolors the exact annotation and preserves identity, quote, note, geometry, popup, flags, and unrelated annotations', async () => {
		let bytes = await addHighlightAnnotation(await fixture(), {
			pageIndex: 0, ...SLANTED, color: YELLOW, opacity: 0.4, quote: 'café — exact quote',
		});
		bytes = (await setHighlightNoteAt(bytes, {
			pageIndex: 0, box: { left: 50, right: 50, top: 35, bottom: 35 }, note: 'ünicode comment',
		})).bytes;

		const before = await PDFDocument.load(bytes);
		const field = before.getForm().createTextField('study-form-preservation');
		field.setText('keep this value');
		field.addToPage(before.getPage(0), { x: 250, y: 100, width: 120, height: 24 });
		const annotsBefore = before.getPage(0).node.lookupMaybe(PDFName.of('Annots'), PDFArray)!;
		const ref = annotsBefore.get(0) as PDFRef;
		const widgetRef = annotsBefore.asArray().find((value) => value instanceof PDFRef && before.context.lookup(value, PDFDict).get(PDFName.of('Subtype'))?.toString() === '/Widget');
		if (!(widgetRef instanceof PDFRef)) throw new Error('Fixture form field did not create a widget annotation.');
		const dictBefore = before.context.lookup(ref, PDFDict);
		dictBefore.set(PDFName.of('NM'), PDFHexString.fromText('study-id-α'));
		dictBefore.set(PDFName.of('F'), PDFNumber.of(132));
		dictBefore.set(PDFName.of('T'), PDFHexString.fromText('Study PDF reader'));
		dictBefore.set(PDFName.of('M'), PDFString.of("D:20261008120000+03'00'"));
		dictBefore.set(PDFName.of('StudyCustom'), PDFHexString.fromText('preserve-me'));
		const popupRef = before.context.register(before.context.obj({ Type: 'Annot', Subtype: 'Popup', Open: false, Rect: [100, 100, 120, 120] }));
		dictBefore.set(PDFName.of('Popup'), popupRef);
		const linkRef = before.context.register(before.context.obj({ Type: 'Annot', Subtype: 'Link', Rect: [300, 300, 320, 320], Border: [0, 0, 0] }));
		annotsBefore.push(linkRef);
		bytes = await before.save();

		const { target } = await firstHighlight(bytes);
		const changed = await setHighlightColorAt(bytes, { ...target, color: BLUE });
		expect(changed.updatedCount).toBe(1);

		const after = await PDFDocument.load(changed.bytes);
		const annotsAfter = after.getPage(0).node.lookupMaybe(PDFName.of('Annots'), PDFArray)!;
		expect(annotsAfter.size()).toBe(3);
		expect((annotsAfter.get(0) as PDFRef).objectNumber).toBe(target.objectNumber);
		expect((annotsAfter.get(0) as PDFRef).generationNumber).toBe(target.generationNumber);
		expect((annotsAfter.get(1) as PDFRef).toString()).toBe(widgetRef.toString());
		expect((annotsAfter.get(2) as PDFRef).toString()).toBe(linkRef.toString());

		const dict = after.context.lookup(annotsAfter.get(0), PDFDict);
		expect(dict.lookup(PDFName.of('C'), PDFArray).asArray().map((value) => Number(value.toString()))).toEqual([BLUE.r, BLUE.g, BLUE.b]);
		expect(dict.lookup(PDFName.of('Rect'), PDFArray).asArray().map((value) => Number(value.toString()))).toEqual([20, 20, 85, 50]);
		expect(dict.lookup(PDFName.of('QuadPoints'), PDFArray).asArray().map((value) => Number(value.toString()))).toEqual(SLANTED.quadPoints);
		expect(dict.lookup(PDFName.of('CA'), PDFNumber).asNumber()).toBe(0.4);
		expect((dict.lookup(PDFName.of('Contents')) as PDFHexString).decodeText()).toBe('ünicode comment');
		expect((dict.lookup(PDFName.of('StudyPDFQuote')) as PDFHexString).decodeText()).toBe('café — exact quote');
		expect((dict.lookup(PDFName.of('NM')) as PDFHexString).decodeText()).toBe('study-id-α');
		expect(dict.lookup(PDFName.of('F'), PDFNumber).asNumber()).toBe(132);
		expect((dict.lookup(PDFName.of('T')) as PDFHexString).decodeText()).toBe('Study PDF reader');
		expect((dict.lookup(PDFName.of('M')) as PDFString).decodeText()).toBe("D:20261008120000+03'00'");
		expect((dict.lookup(PDFName.of('StudyCustom')) as PDFHexString).decodeText()).toBe('preserve-me');
		expect((dict.get(PDFName.of('Popup')) as PDFRef).toString()).toBe(popupRef.toString());
		expect(after.getForm().getTextField('study-form-preservation').getText()).toBe('keep this value');
		const appearance = readNormalAppearance(after, dict);
		expect(appearance.text).toContain(`${BLUE.r} ${BLUE.g} ${BLUE.b} rg`);
		expect(appearance.text).toMatch(/0 20 m\n60 30 l\n65 10 l\n5 0 l\nh\nf/);
		expect(appearance.text).not.toContain(' re');
		expect(appearance.ca).toBe(0.4);
		expect(appearance.blendMode).toBe('/Multiply');
	});

	it('writes a custom RGB color to both /C and /AP when creating a highlight', async () => {
		const custom = { r: 0.21, g: 0.43, b: 0.65 };
		const bytes = await addHighlightAnnotation(await fixture(), { pageIndex: 0, ...SLANTED, color: custom });
		const doc = await PDFDocument.load(bytes);
		const annots = doc.getPage(0).node.lookupMaybe(PDFName.of('Annots'), PDFArray)!;
		const dict = doc.context.lookup(annots.get(0), PDFDict);
		expect(dict.lookup(PDFName.of('C'), PDFArray).asArray().map((value) => Number(value.toString()))).toEqual([custom.r, custom.g, custom.b]);
		expect(readNormalAppearance(doc, dict).text).toContain(`${custom.r} ${custom.g} ${custom.b} rg`);
	});

	it('returns exact input bytes on a same-color request and keeps the annotation reference across repeated recolors', async () => {
		const bytes = await addHighlightAnnotation(await fixture(), { pageIndex: 0, ...SLANTED, color: YELLOW });
		const { ref, target } = await firstHighlight(bytes);
		const originalObjectCount = (await PDFDocument.load(bytes)).context.enumerateIndirectObjects().length;
		const same = await setHighlightColorAt(bytes, { ...target, color: YELLOW });
		expect(same.updatedCount).toBe(0);
		expect(same.bytes).toBe(bytes);

		const first = await setHighlightColorAt(bytes, { ...target, color: BLUE });
		expect((await PDFDocument.load(first.bytes)).context.enumerateIndirectObjects().length).toBe(originalObjectCount);
		const secondColor = { r: 0.8, g: 0.2, b: 0.1 };
		const second = await setHighlightColorAt(first.bytes, { ...first.target, color: secondColor });
		expect(second.updatedCount).toBe(1);
		expect((await PDFDocument.load(second.bytes)).context.enumerateIndirectObjects().length).toBe(originalObjectCount);
		const { ref: afterRef } = await firstHighlight(second.bytes);
		expect(afterRef.toString()).toBe(ref.toString());
	});

	it('rejects a target copied from another PDF with the same annotation ref and refreshes it after recoloring', async () => {
		const firstBytes = await addHighlightAnnotation(await fixture(), { pageIndex: 0, ...SLANTED, color: YELLOW, quote: 'source A' });
		const secondBytes = await addHighlightAnnotation(await fixture(), { pageIndex: 0, ...SLANTED, color: YELLOW, quote: 'source B' });
		const first = await firstHighlight(firstBytes);
		const secondPdf = await PDFDocument.load(secondBytes);
		const secondRef = secondPdf.getPage(0).node.lookupMaybe(PDFName.of('Annots'), PDFArray)!.get(0) as PDFRef;
		expect(secondRef.toString()).toBe(first.ref.toString());
		await expect(setHighlightColorAt(secondBytes, { ...first.target, color: BLUE })).rejects.toThrow(/different PDF|earlier saved version/i);

		const recolored = await setHighlightColorAt(firstBytes, { ...first.target, color: BLUE });
		expect(recolored.target.sourceFingerprint).not.toBe(first.target.sourceFingerprint);
		const repeated = await setHighlightColorAt(recolored.bytes, { ...recolored.target, color: YELLOW });
		expect(repeated.updatedCount).toBe(1);
	});

	it('fingerprints only the byte range represented by a Uint8Array view', async () => {
		const documentBytes = await addHighlightAnnotation(await fixture(), { pageIndex: 0, ...SLANTED, color: YELLOW });
		const backing = new Uint8Array(documentBytes.length + 12);
		backing.set(documentBytes, 5);
		const view = backing.subarray(5, 5 + documentBytes.length);
		const { target } = await firstHighlight(view);
		const recolored = await setHighlightColorAt(view, { ...target, color: BLUE });
		expect(recolored.updatedCount).toBe(1);
	});

	it('recolors owner-password PDFs and rejects PDFs requiring a user password', async () => {
		const ownerEncrypted = await encryptedFixture();
		const highlighted = await addHighlightAnnotation(ownerEncrypted, { pageIndex: 0, ...SLANTED, color: YELLOW });
		const ownerProtectedDoc = await PDFDocument.load(highlighted);
		ownerProtectedDoc.encrypt({ ownerPassword: 'owner-secret', permissions: { modifying: false, annotating: false, copying: false } });
		const ownerProtected = await ownerProtectedDoc.save();
		const openedOwnerPdf = await PDFDocument.load(ownerProtected, { password: '' });
		const ownerRef = openedOwnerPdf.getPage(0).node.lookupMaybe(PDFName.of('Annots'), PDFArray)!.get(0) as PDFRef;
		const ownerTarget: HighlightTarget = {
			pageIndex: 0,
			objectNumber: ownerRef.objectNumber,
			generationNumber: ownerRef.generationNumber,
			sourceFingerprint: await fingerprint(ownerProtected),
		};
		const recolored = await setHighlightColorAt(ownerProtected, { ...ownerTarget, color: BLUE });
		expect(recolored.updatedCount).toBe(1);
		await expect(PDFDocument.load(recolored.bytes)).resolves.toBeDefined();

		const highlightedPlain = await addHighlightAnnotation(await fixture(), { pageIndex: 0, ...SLANTED, color: YELLOW });
		const protectedDoc = await PDFDocument.load(highlightedPlain);
		const firstPlainRef = protectedDoc.getPage(0).node.lookupMaybe(PDFName.of('Annots'), PDFArray)!.get(0) as PDFRef;
		protectedDoc.encrypt({ ownerPassword: 'owner-secret', userPassword: 'open-secret' });
		const userPasswordPdf = await protectedDoc.save();
		await expect(setHighlightColorAt(userPasswordPdf, {
			pageIndex: 0,
			objectNumber: firstPlainRef.objectNumber,
			generationNumber: firstPlainRef.generationNumber,
			sourceFingerprint: await fingerprint(userPasswordPdf),
			color: BLUE,
		})).rejects.toThrow(/password/i);
	});

	it('rejects a target assigned to the wrong page when the PDF has a second page', async () => {
		const bytes = await addHighlightAnnotation(await fixture(2), { pageIndex: 1, ...SLANTED, color: YELLOW });
		const { target } = await firstHighlight(bytes, 1);
		await expect(setHighlightColorAt(bytes, { ...target, pageIndex: 0, color: BLUE })).rejects.toThrow(/not found|missing/i);
	});

	it('returns each annotation once when the page Annots array repeats its ref', async () => {
		let bytes = await addHighlightAnnotation(await fixture(), { pageIndex: 0, ...SLANTED, color: YELLOW, quote: 'single ref' });
		const doc = await PDFDocument.load(bytes);
		const annots = doc.getPage(0).node.lookupMaybe(PDFName.of('Annots'), PDFArray)!;
		annots.push(annots.get(0)!);
		bytes = await doc.save();
		const direct = await findHighlightsAtPoint(bytes, 0, { x: 52, y: 35 });
		const indexed = findHighlightsInIndexAtPoint(await buildHighlightIndex(bytes), 0, { x: 52, y: 35 });
		expect(direct).toHaveLength(1);
		expect(indexed).toEqual(direct);
	});

	it('uses Annots order to break equal-area ties and keeps adjacent highlights separate', async () => {
		let bytes = await addHighlightAnnotation(await fixture(), {
			pageIndex: 0, quadPoints: [20, 40, 50, 40, 20, 20, 50, 20],
			box: { left: 20, right: 50, top: 40, bottom: 20 }, color: YELLOW, quote: 'left',
		});
		bytes = await addHighlightAnnotation(bytes, {
			pageIndex: 0, quadPoints: [20, 40, 50, 40, 20, 20, 50, 20],
			box: { left: 20, right: 50, top: 40, bottom: 20 }, color: BLUE, quote: 'same-area later',
		});
		const overlap = await findHighlightsAtPoint(bytes, 0, { x: 30, y: 30 });
		expect(overlap.map((item) => item.quote)).toEqual(['left', 'same-area later']);

		let adjacent = await addHighlightAnnotation(await fixture(), {
			pageIndex: 0, quadPoints: [20, 40, 50, 40, 20, 20, 50, 20],
			box: { left: 20, right: 50, top: 40, bottom: 20 }, color: YELLOW, quote: 'left edge',
		});
		adjacent = await addHighlightAnnotation(adjacent, {
			pageIndex: 0, quadPoints: [50, 40, 80, 40, 50, 20, 80, 20],
			box: { left: 50, right: 80, top: 40, bottom: 20 }, color: BLUE, quote: 'right edge',
		});
		expect((await findHighlightsAtPoint(adjacent, 0, { x: 35, y: 30 })).map((item) => item.quote)).toEqual(['left edge']);
		expect((await findHighlightsAtPoint(adjacent, 0, { x: 65, y: 30 })).map((item) => item.quote)).toEqual(['right edge']);
		expect((await findHighlightsAtPoint(adjacent, 0, { x: 50, y: 30 })).map((item) => item.quote)).toEqual(['left edge', 'right edge']);
	});

	it('preserves legacy rectangle appearance geometry when recoloring an old mark', async () => {
		let bytes = await addHighlightAnnotation(await fixture(), { pageIndex: 0, ...SLANTED, color: YELLOW });
		const doc = await PDFDocument.load(bytes);
		const annots = doc.getPage(0).node.lookupMaybe(PDFName.of('Annots'), PDFArray)!;
		const dict = doc.context.lookup(annots.get(0), PDFDict);
		const ap = doc.context.lookup(dict.get(PDFName.of('AP'))!, PDFDict);
		const originalStream = doc.context.lookup(ap.get(PDFName.of('N'))!) as PDFRawStream;
		const legacyContent = `/GS0 gs\n${YELLOW.r} ${YELLOW.g} ${YELLOW.b} rg\n0 0 65 30 re\nf`;
		const legacyDict = originalStream.dict.clone(doc.context);
		const encoded = new TextEncoder().encode(legacyContent);
		legacyDict.set(PDFName.of('Length'), PDFNumber.of(encoded.length));
		const legacyRef = doc.context.register(PDFRawStream.of(legacyDict, encoded));
		const legacyAp = ap.clone(doc.context);
		legacyAp.set(PDFName.of('N'), legacyRef);
		dict.set(PDFName.of('AP'), legacyAp);
		bytes = await doc.save();

		const { target } = await firstHighlight(bytes);
		const changed = await setHighlightColorAt(bytes, { ...target, color: BLUE });
		const saved = await PDFDocument.load(changed.bytes);
		const savedDict = saved.context.lookup(saved.getPage(0).node.lookupMaybe(PDFName.of('Annots'), PDFArray)!.get(0), PDFDict);
		const appearance = readNormalAppearance(saved, savedDict);
		expect(appearance.text).toContain(`${BLUE.r} ${BLUE.g} ${BLUE.b} rg`);
		expect(appearance.text).toContain('0 0 65 30 re');
		expect(appearance.text).not.toContain(' m');
	});

	it('returns all polygon hits ordered by area and annotation order, with no slanted bounding-box false positives', async () => {
		let bytes = await addHighlightAnnotation(await fixture(), {
			pageIndex: 0, quadPoints: [10, 40, 110, 40, 10, 10, 110, 10],
			box: { left: 10, right: 110, top: 40, bottom: 10 }, color: YELLOW, quote: 'large',
		});
		bytes = await addHighlightAnnotation(bytes, { pageIndex: 0, ...SLANTED, color: BLUE, quote: 'slanted small' });
		const index = await buildHighlightIndex(bytes);
		const point = { x: 52, y: 35 };
		const direct = await findHighlightsAtPoint(bytes, 0, point);
		expect(findHighlightsInIndexAtPoint(index, 0, point)).toEqual(direct);
		expect(direct.map((candidate) => candidate.quote)).toEqual(['slanted small', 'large']);
		const doc = await PDFDocument.load(bytes);
		const annots = doc.getPage(0).node.lookupMaybe(PDFName.of('Annots'), PDFArray)!;
		expect(direct[0]!.target?.objectNumber).toBe((annots.get(1) as PDFRef).objectNumber);
		expect(direct[0]!.currentColor).toEqual(BLUE);
		expect(direct[0]!.unsupportedReason).toBeNull();
		expect(await findHighlightsAtPoint(bytes, 0, { x: 22, y: 49 })).toEqual([]);
		expect((await findHighlightsAtPoint(bytes, 0, { x: 20, y: 40 })).map((candidate) => candidate.quote)).toContain('slanted small');
	});

	it('rejects stale, wrong-page, malformed-color, and direct-dictionary targets', async () => {
		const bytes = await addHighlightAnnotation(await fixture(), { pageIndex: 0, ...SLANTED, color: YELLOW });
		const { ref, target } = await firstHighlight(bytes);
		await expect(setHighlightColorAt(bytes, { ...target, objectNumber: target.objectNumber + 100, color: BLUE })).rejects.toThrow(/target|annotation/i);
		await expect(setHighlightColorAt(bytes, { ...target, pageIndex: 1, color: BLUE })).rejects.toThrow(/target|page|annotation/i);
		await expect(setHighlightColorAt(bytes, { ...target, color: { r: Number.NaN, g: 0, b: 0 } })).rejects.toThrow(/color/i);

		const doc = await PDFDocument.load(bytes);
		const page = doc.getPage(0);
		const annots = page.node.lookupMaybe(PDFName.of('Annots'), PDFArray)!;
		const dict = doc.context.lookup(annots.get(0), PDFDict);
		page.node.set(PDFName.of('Annots'), doc.context.obj([dict]));
		const directBytes = await doc.save();
		const candidate = await findHighlightsAtPoint(directBytes, 0, { x: 52, y: 35 });
		expect(candidate).toHaveLength(1);
		expect(candidate[0]!.target).toBeNull();
		expect(candidate[0]!.unsupportedReason).toMatch(/direct|indirect|reference/i);
		await expect(setHighlightColorAt(directBytes, { ...target, sourceFingerprint: await fingerprint(directBytes), color: BLUE })).rejects.toThrow(/target|reference|indirect/i);
	});

	it('preserves explicit zero opacity and an absent /CA while changing the appearance color', async () => {
		for (const opacity of [0, 0.4, undefined]) {
			let bytes = await addHighlightAnnotation(await fixture(), { pageIndex: 0, ...SLANTED, color: YELLOW, opacity });
			const doc = await PDFDocument.load(bytes);
			const annots = doc.getPage(0).node.lookupMaybe(PDFName.of('Annots'), PDFArray)!;
			const dict = doc.context.lookup(annots.get(0), PDFDict);
			if (opacity === undefined) dict.delete(PDFName.of('CA'));
			bytes = await doc.save();
			const { target } = await firstHighlight(bytes);
			const changed = await setHighlightColorAt(bytes, { ...target, color: BLUE });
			const saved = await PDFDocument.load(changed.bytes);
			const savedDict = saved.context.lookup(saved.getPage(0).node.lookupMaybe(PDFName.of('Annots'), PDFArray)!.get(0), PDFDict);
			if (opacity === undefined) expect(savedDict.get(PDFName.of('CA'))).toBeUndefined();
			else expect(savedDict.lookup(PDFName.of('CA'), PDFNumber).asNumber()).toBe(opacity);
			expect(readNormalAppearance(saved, savedDict).ca).toBe(opacity ?? 1);
			expect(readNormalAppearance(saved, savedDict).blendMode).toBe('/Multiply');
		}
	});

	it('rejects conflicting annotation and appearance opacity before recoloring', async () => {
		let bytes = await addHighlightAnnotation(await fixture(), { pageIndex: 0, ...SLANTED, color: YELLOW, opacity: 0.4 });
		const doc = await PDFDocument.load(bytes);
		const dict = doc.context.lookup(doc.getPage(0).node.lookupMaybe(PDFName.of('Annots'), PDFArray)!.get(0), PDFDict);
		const { stream } = readNormalAppearance(doc, dict);
		const resources = doc.context.lookup(stream.dict.get(PDFName.of('Resources'))!, PDFDict);
		const ext = doc.context.lookup(resources.get(PDFName.of('ExtGState'))!, PDFDict);
		const gs = doc.context.lookup(ext.get(PDFName.of('GS0'))!, PDFDict);
		gs.set(PDFName.of('ca'), PDFNumber.of(0.6));
		bytes = await doc.save();
		const { target } = await firstHighlight(bytes);
		await expect(setHighlightColorAt(bytes, { ...target, color: BLUE })).rejects.toThrow(/conflicting .*opacity/i);
	});

	it('rejects malformed or degenerate quadrilaterals and wrong-subtype targets', async () => {
		const bytes = await addHighlightAnnotation(await fixture(), { pageIndex: 0, ...SLANTED, color: YELLOW });
		const { target } = await firstHighlight(bytes);
		const malformedDoc = await PDFDocument.load(bytes);
		const malformedAnnots = malformedDoc.getPage(0).node.lookupMaybe(PDFName.of('Annots'), PDFArray)!;
		const malformedDict = malformedDoc.context.lookup(malformedAnnots.get(0), PDFDict);
		// Four collinear points, all inside the source /Rect: this exercises the
		// degeneracy check without also triggering the outside-Rect guard.
		malformedDict.set(PDFName.of('QuadPoints'), malformedDoc.context.obj([20, 20, 40, 25, 60, 30, 80, 35]));
		const malformedBytes = await malformedDoc.save();
		await expect(setHighlightColorAt(malformedBytes, { ...target, sourceFingerprint: await fingerprint(malformedBytes), color: BLUE })).rejects.toThrow(/degenerate|quadrilateral/i);

		const wrongTypeDoc = await PDFDocument.load(bytes);
		const wrongTypeAnnots = wrongTypeDoc.getPage(0).node.lookupMaybe(PDFName.of('Annots'), PDFArray)!;
		wrongTypeDoc.context.lookup(wrongTypeAnnots.get(0), PDFDict).set(PDFName.of('Subtype'), PDFName.of('Link'));
		const wrongTypeBytes = await wrongTypeDoc.save();
		await expect(setHighlightColorAt(wrongTypeBytes, { ...target, sourceFingerprint: await fingerprint(wrongTypeBytes), color: BLUE })).rejects.toThrow(/not a \/Highlight/i);
	});

	it('rejects missing, nonnumeric, and out-of-Rect QuadPoints', async () => {
		const bytes = await addHighlightAnnotation(await fixture(), { pageIndex: 0, ...SLANTED, color: YELLOW });
		const { target } = await firstHighlight(bytes);
		const mutations: Array<{ change: (dict: PDFDict, doc: PDFDocument) => void; reason: RegExp }> = [
			{
				change: (dict) => dict.delete(PDFName.of('QuadPoints')),
				reason: /no \/QuadPoints/i,
			},
			{
				change: (dict, doc) => dict.set(PDFName.of('QuadPoints'), doc.context.obj([20, 40, PDFName.of('not-a-number'), 50, 25, 20, 85, 30])),
				reason: /malformed \/QuadPoints/i,
			},
			{
				change: (dict, doc) => dict.set(PDFName.of('QuadPoints'), doc.context.obj([20, 40, 80, 50, 25, 20, 95, 30])),
				reason: /outside its \/Rect/i,
			},
		];
		for (const mutation of mutations) {
			const doc = await PDFDocument.load(bytes);
			const dict = doc.context.lookup(doc.getPage(0).node.lookupMaybe(PDFName.of('Annots'), PDFArray)!.get(0), PDFDict);
			mutation.change(dict, doc);
			const malformed = await doc.save();
			await expect(setHighlightColorAt(malformed, {
				...target,
				sourceFingerprint: await fingerprint(malformed),
				color: BLUE,
			})).rejects.toThrow(mutation.reason);
		}
	});

	it('reports /AS and soft-mask appearance states as unsupported', async () => {
		const bytes = await addHighlightAnnotation(await fixture(), { pageIndex: 0, ...SLANTED, color: YELLOW });
		for (const state of ['as', 'mask'] as const) {
			const doc = await PDFDocument.load(bytes);
			const dict = doc.context.lookup(doc.getPage(0).node.lookupMaybe(PDFName.of('Annots'), PDFArray)!.get(0), PDFDict);
			if (state === 'as') {
				dict.set(PDFName.of('AS'), PDFName.of('N'));
			} else {
				const appearance = readNormalAppearance(doc, dict);
				const resources = doc.context.lookup(appearance.stream.dict.get(PDFName.of('Resources'))!, PDFDict);
				const ext = doc.context.lookup(resources.get(PDFName.of('ExtGState'))!, PDFDict);
				const gs = doc.context.lookup(ext.get(PDFName.of('GS0'))!, PDFDict);
				const maskGroup = doc.context.register(doc.context.stream('q Q', {
					Type: 'XObject', Subtype: 'Form', FormType: 1, BBox: [0, 0, 1, 1], Resources: {},
				}));
				gs.set(PDFName.of('SMask'), doc.context.obj({ Type: 'Mask', S: 'Alpha', G: maskGroup }));
			}
			const unsupportedBytes = await doc.save();
			const { target } = await firstHighlight(unsupportedBytes);
			const candidates = await findHighlightsAtPoint(unsupportedBytes, 0, { x: 52, y: 35 });
			expect(candidates[0]!.unsupportedReason).toMatch(state === 'as' ? /appearance-state/i : /masks|graphics state/i);
			await expect(setHighlightColorAt(unsupportedBytes, { ...target, color: BLUE })).rejects.toThrow(/appearance-state|masks|graphics state/i);
		}
	});

	it('keeps a valid neighboring highlight when another Annots entry is malformed', async () => {
		let bytes = await addHighlightAnnotation(await fixture(), { pageIndex: 0, ...SLANTED, color: YELLOW, quote: 'malformed entry' });
		bytes = await addHighlightAnnotation(bytes, { pageIndex: 0, ...SLANTED, color: BLUE, quote: 'valid neighbor' });
		const doc = await PDFDocument.load(bytes);
		const annots = doc.getPage(0).node.lookupMaybe(PDFName.of('Annots'), PDFArray)!;
		annots.set(0, PDFName.of('not-an-annotation'));
		const candidates = await findHighlightsAtPoint(await doc.save(), 0, { x: 52, y: 35 });
		expect(candidates.map((candidate) => candidate.quote)).toEqual(['valid neighbor']);
		expect(candidates[0]!.unsupportedReason).toBeNull();
	});

	it('rejects a saved PDF that fails the post-save color verification', async () => {
		const bytes = await addHighlightAnnotation(await fixture(), { pageIndex: 0, ...SLANTED, color: YELLOW });
		const { target } = await firstHighlight(bytes);
		const saveSpy = vi.spyOn(PDFDocument.prototype, 'save').mockResolvedValueOnce(bytes);
		try {
			await expect(setHighlightColorAt(bytes, { ...target, color: BLUE })).rejects.toThrow(/saved highlight color or geometry did not verify/i);
		} finally {
			saveSpy.mockRestore();
		}
	});

	it('rejects a saved appearance whose ExtGState opacity changed during serialization', async () => {
		const originalDocBytes = await addHighlightAnnotation(await fixture(), { pageIndex: 0, ...SLANTED, color: YELLOW, opacity: 0.4 });
		const originalDoc = await PDFDocument.load(originalDocBytes);
		const originalAnnots = originalDoc.getPage(0).node.lookupMaybe(PDFName.of('Annots'), PDFArray)!;
		originalDoc.context.lookup(originalAnnots.get(0), PDFDict).delete(PDFName.of('CA'));
		const originalBytes = await originalDoc.save();
		const { ref, target } = await firstHighlight(originalBytes);

		const changedAppearanceBytes = await addHighlightAnnotation(await fixture(), { pageIndex: 0, ...SLANTED, color: BLUE, opacity: 0.6 });
		const changedAppearanceDoc = await PDFDocument.load(changedAppearanceBytes);
		const changedAnnots = changedAppearanceDoc.getPage(0).node.lookupMaybe(PDFName.of('Annots'), PDFArray)!;
		const changedRef = changedAnnots.get(0) as PDFRef;
		expect(changedRef.toString()).toBe(ref.toString());
		changedAppearanceDoc.context.lookup(changedRef, PDFDict).delete(PDFName.of('CA'));
		const serializedWithWrongAlpha = await changedAppearanceDoc.save();

		const saveSpy = vi.spyOn(PDFDocument.prototype, 'save').mockResolvedValueOnce(serializedWithWrongAlpha);
		try {
			await expect(setHighlightColorAt(originalBytes, { ...target, color: BLUE }))
				.rejects.toThrow(/saved appearance opacity or blend mode changed/i);
		} finally {
			saveSpy.mockRestore();
		}
	});

	it('returns an unsupported candidate instead of throwing on malformed typed fields', async () => {
		const bytes = await addHighlightAnnotation(await fixture(), { pageIndex: 0, ...SLANTED, color: YELLOW });
		const doc = await PDFDocument.load(bytes);
		const annots = doc.getPage(0).node.lookupMaybe(PDFName.of('Annots'), PDFArray)!;
		const dict = doc.context.lookup(annots.get(0), PDFDict);
		dict.set(PDFName.of('C'), PDFName.of('not-an-array'));
		const malformed = await doc.save();
		const candidates = await findHighlightsAtPoint(malformed, 0, { x: 52, y: 35 });
		expect(candidates).toHaveLength(1);
		expect(candidates[0]!.currentColor).toBeNull();
		expect(candidates[0]!.unsupportedReason).toMatch(/valid \/C/i);

		const badAnnotsDoc = await PDFDocument.load(bytes);
		badAnnotsDoc.getPage(0).node.set(PDFName.of('Annots'), PDFName.of('not-an-array'));
		expect(await findHighlightsAtPoint(await badAnnotsDoc.save(), 0, { x: 52, y: 35 })).toEqual([]);
	});

	it('does not alter another annotation that shares the original appearance stream', async () => {
		let bytes = await addHighlightAnnotation(await fixture(), { pageIndex: 0, ...SLANTED, color: YELLOW });
		bytes = await addHighlightAnnotation(bytes, {
			pageIndex: 0,
			quadPoints: [120, 40, 180, 40, 120, 20, 180, 20],
			box: { left: 120, right: 180, top: 40, bottom: 20 }, color: YELLOW,
		});
		const doc = await PDFDocument.load(bytes);
		const annots = doc.getPage(0).node.lookupMaybe(PDFName.of('Annots'), PDFArray)!;
		const firstDict = doc.context.lookup(annots.get(0), PDFDict);
		const secondDict = doc.context.lookup(annots.get(1), PDFDict);
		const originalAp = doc.context.lookup(firstDict.get(PDFName.of('AP'))!, PDFDict);
		const sharedAp = doc.context.register(originalAp.clone(doc.context));
		firstDict.set(PDFName.of('AP'), sharedAp);
		secondDict.set(PDFName.of('AP'), sharedAp);
		bytes = await doc.save();
		const { target } = await firstHighlight(bytes);
		const changed = await setHighlightColorAt(bytes, { ...target, color: BLUE });
		const after = await PDFDocument.load(changed.bytes);
		const afterAnnots = after.getPage(0).node.lookupMaybe(PDFName.of('Annots'), PDFArray)!;
		const changedDict = after.context.lookup(afterAnnots.get(0), PDFDict);
		const untouchedDict = after.context.lookup(afterAnnots.get(1), PDFDict);
		expect(changedDict.get(PDFName.of('AP'))?.toString()).not.toBe(untouchedDict.get(PDFName.of('AP'))?.toString());
		expect(readNormalAppearance(after, untouchedDict).text).toContain(`${YELLOW.r} ${YELLOW.g} ${YELLOW.b} rg`);
	});

	it('rebuilds a filtered appearance on recolor and keeps a shared original intact', async () => {
		const bytes = await addHighlightAnnotation(await fixture(), {
			pageIndex: 0, ...SLANTED, color: YELLOW, opacity: 0.4, quote: 'original quote',
		});
		const doc = await PDFDocument.load(bytes);
		const annots = doc.getPage(0).node.lookup(PDFName.of('Annots'), PDFArray);
		const ref = annots.get(0) as PDFRef;
		const highlight = doc.context.lookup(ref, PDFDict);
		highlight.set(PDFName.of('Contents'), PDFHexString.fromText('original note'));
		const original = readNormalAppearance(doc, highlight);
		const filtered = doc.context.flateStream(`q\n${original.text}\nQ`);
		for (const [key, value] of original.stream.dict.entries()) {
			if (key.toString() !== '/Length') filtered.dict.set(key, value);
		}
		const filteredRef = doc.context.register(filtered);
		const sharedAp = doc.context.register(doc.context.obj({ N: filteredRef }));
		highlight.set(PDFName.of('AP'), sharedAp);
		annots.push(doc.context.register(highlight.clone(doc.context)));
		const source = await doc.save();

		const probe = { x: 52, y: 35 };
		const candidates = findHighlightsInIndexAtPoint(await buildHighlightIndex(source), 0, probe);
		expect(candidates[0]).toMatchObject({ unsupportedReason: null });
		const target = candidates[0]!.target!;
		const same = await setHighlightColorAt(source, { ...target, color: YELLOW });
		expect(same.updatedCount).toBe(0);
		expect(same.bytes).toBe(source);

		const changed = await setHighlightColorAt(source, { ...target, color: BLUE });
		expect(changed.updatedCount).toBe(1);
		expect(changed.target.objectNumber).toBe(ref.objectNumber);
		const after = await PDFDocument.load(changed.bytes);
		const saved = after.context.lookup(ref, PDFDict);
		expect(saved.get(PDFName.of('QuadPoints'))?.toString()).toBe(highlight.get(PDFName.of('QuadPoints'))?.toString());
		expect((saved.get(PDFName.of('Contents')) as PDFHexString).decodeText()).toBe('original note');
		expect((saved.get(PDFName.of('StudyPDFQuote')) as PDFHexString).decodeText()).toBe('original quote');
		const appearance = readNormalAppearance(after, saved);
		expect(appearance.text).toContain(`${BLUE.r} ${BLUE.g} ${BLUE.b} rg`);
		expect(appearance.text).toMatch(/0 20 m\n60 30 l\n65 10 l\n5 0 l\nh\nf/);
		expect(appearance.ca).toBe(0.4);
		expect(appearance.stream.dict.has(PDFName.of('Filter'))).toBe(false);

		const neighbor = after.context.lookup(after.getPage(0).node.lookup(PDFName.of('Annots'), PDFArray).get(1), PDFDict);
		expect(neighbor.get(PDFName.of('AP'))).toBe(sharedAp);
		expect(readNormalAppearance(after, neighbor).stream.getContents()).toEqual(filtered.getContents());
		expect((await findHighlightsAtPoint(changed.bytes, 0, probe))[0]).toMatchObject({ unsupportedReason: null });
	});

	it('does not override a filtered appearance with an alternate state', async () => {
		const bytes = await addHighlightAnnotation(await fixture(), { pageIndex: 0, ...SLANTED, color: YELLOW });
		const doc = await PDFDocument.load(bytes);
		const ref = doc.getPage(0).node.lookup(PDFName.of('Annots'), PDFArray).get(0);
		const highlight = doc.context.lookup(ref, PDFDict);
		const ap = highlight.lookup(PDFName.of('AP'), PDFDict);
		const filteredRef = doc.context.register(doc.context.flateStream('q Q', { Type: 'XObject', Subtype: 'Form' }));
		ap.set(PDFName.of('N'), filteredRef);
		ap.set(PDFName.of('R'), filteredRef);
		const source = await doc.save();
		const [candidate] = await findHighlightsAtPoint(source, 0, { x: 52, y: 35 });
		expect(candidate!.unsupportedReason).toMatch(/alternate appearance states/);
		await expect(setHighlightColorAt(source, { ...candidate!.target!, color: BLUE }))
			.rejects.toThrow(/alternate appearance states/);
	});
});

describe('exact-target annotation actions', () => {
	const noteApi = () => Reflect.get(annotate, 'setHighlightNoteForTarget') as
		| ((bytes: Uint8Array, options: HighlightTarget & { note: string }) => Promise<{ bytes: Uint8Array; updatedCount: number; target: HighlightTarget }>)
		| undefined;
	const removeApi = () => Reflect.get(annotate, 'removeHighlightForTarget') as
		| ((bytes: Uint8Array, target: HighlightTarget) => Promise<{ bytes: Uint8Array; removedCount: number }>)
		| undefined;

	it('exposes exact-ref note and removal operations', () => {
		expect(noteApi()).toEqual(expect.any(Function));
		expect(removeApi()).toEqual(expect.any(Function));
	});

	it('changes Unicode and empty notes for only the chosen overlapping highlight and makes same-note a byte no-op', async () => {
		let bytes = await addHighlightAnnotation(await fixture(), {
			pageIndex: 0, quadPoints: [20, 40, 70, 40, 20, 20, 70, 20],
			box: { left: 20, right: 70, top: 40, bottom: 20 }, color: YELLOW, quote: 'first quote',
		});
		bytes = await addHighlightAnnotation(bytes, {
			pageIndex: 0, quadPoints: [20, 40, 70, 40, 20, 20, 70, 20],
			box: { left: 20, right: 70, top: 40, bottom: 20 }, color: BLUE, quote: 'second quote',
		});
		const setup = await PDFDocument.load(bytes);
		const setupAnnots = setup.getPage(0).node.lookupMaybe(PDFName.of('Annots'), PDFArray)!;
		const firstSetup = setup.context.lookup(setupAnnots.get(0), PDFDict);
		firstSetup.set(PDFName.of('NM'), PDFHexString.fromText('note-target-α'));
		firstSetup.set(PDFName.of('F'), PDFNumber.of(132));
		firstSetup.set(PDFName.of('StudyExtra'), PDFHexString.fromText('keep this metadata'));
		const linkRef = setup.context.register(setup.context.obj({ Type: 'Annot', Subtype: 'Link', Rect: [1, 1, 2, 2] }));
		setupAnnots.push(linkRef);
		bytes = await setup.save();
		const [first, second] = await findHighlightsAtPoint(bytes, 0, { x: 30, y: 30 });
		if (!first?.target || !second?.target) throw new Error('Fixture did not create overlapping targets.');
		const setNote = noteApi();
		if (!setNote) { expect(setNote).toEqual(expect.any(Function)); return; }
		await expect(setNote(bytes, { ...first.target, objectNumber: first.target.objectNumber + 100, note: 'wrong ref' }))
			.rejects.toThrow(/target|annotation|reference/i);
		await expect(setNote(bytes, { ...first.target, pageIndex: 1, note: 'wrong page' }))
			.rejects.toThrow(/page|target|annotation/i);

		const edited = await setNote(bytes, { ...first.target, note: '  café 🧪 note  ' });
		expect(edited.updatedCount).toBe(1);
		const afterEdit = await findHighlightsAtPoint(edited.bytes, 0, { x: 30, y: 30 });
		expect(afterEdit.find((item) => item.target?.objectNumber === first.target!.objectNumber)?.note).toBe('café 🧪 note');
		expect(afterEdit.find((item) => item.target?.objectNumber === second.target!.objectNumber)?.note).toBeNull();
		const editedDoc = await PDFDocument.load(edited.bytes);
		const editedAnnots = editedDoc.getPage(0).node.lookupMaybe(PDFName.of('Annots'), PDFArray)!;
		expect(editedAnnots.size()).toBe(3);
		expect(editedAnnots.get(2)?.toString()).toBe(linkRef.toString());
		const editedDict = editedDoc.context.lookup(editedAnnots.get(0), PDFDict);
		expect((editedDict.lookup(PDFName.of('NM')) as PDFHexString).decodeText()).toBe('note-target-α');
		expect(editedDict.lookup(PDFName.of('F'), PDFNumber).asNumber()).toBe(132);
		expect((editedDict.lookup(PDFName.of('StudyExtra')) as PDFHexString).decodeText()).toBe('keep this metadata');
		expect((editedDict.lookup(PDFName.of('StudyPDFQuote')) as PDFHexString).decodeText()).toBe('first quote');
		expect(editedDict.lookup(PDFName.of('CA'), PDFNumber).asNumber()).toBe(1);
		expect(editedDict.lookup(PDFName.of('Rect'), PDFArray).size()).toBe(4);
		expect(editedDict.lookup(PDFName.of('QuadPoints'), PDFArray).size()).toBe(8);
		expect(readNormalAppearance(editedDoc, editedDict).text).toContain(`${YELLOW.r} ${YELLOW.g} ${YELLOW.b} rg`);
		const same = await setNote(edited.bytes, { ...edited.target, note: 'café 🧪 note' });
		expect(same.updatedCount).toBe(0);
		expect(same.bytes).toBe(edited.bytes);

		const cleared = await setNote(edited.bytes, { ...edited.target, note: '   ' });
		expect(cleared.updatedCount).toBe(1);
		const afterClear = await findHighlightsAtPoint(cleared.bytes, 0, { x: 30, y: 30 });
		expect(afterClear.find((item) => item.target?.objectNumber === first.target!.objectNumber)?.note).toBeNull();
		expect(afterClear.find((item) => item.target?.objectNumber === second.target!.objectNumber)?.note).toBeNull();
	});

	it('rejects stale or wrong references and removes only the chosen overlapping annotation', async () => {
		let bytes = await addHighlightAnnotation(await fixture(), {
			pageIndex: 0, quadPoints: [20, 40, 70, 40, 20, 20, 70, 20],
			box: { left: 20, right: 70, top: 40, bottom: 20 }, color: YELLOW, quote: 'first quote',
		});
		bytes = await addHighlightAnnotation(bytes, {
			pageIndex: 0, quadPoints: [20, 40, 70, 40, 20, 20, 70, 20],
			box: { left: 20, right: 70, top: 40, bottom: 20 }, color: BLUE, quote: 'second quote',
		});
		const [first, second] = await findHighlightsAtPoint(bytes, 0, { x: 30, y: 30 });
		if (!first?.target || !second?.target) throw new Error('Fixture did not create overlapping targets.');
		const remove = removeApi();
		if (!remove) { expect(remove).toEqual(expect.any(Function)); return; }
		await expect(remove(bytes, { ...first.target, objectNumber: first.target.objectNumber + 100 }))
			.rejects.toThrow(/target|annotation|reference/i);
		await expect(remove(bytes, { ...first.target, pageIndex: 1 }))
			.rejects.toThrow(/page|target|annotation/i);
		const otherPdf = await addHighlightAnnotation(await fixture(), {
			pageIndex: 0, ...SLANTED, color: YELLOW,
		});
		const [other] = await findHighlightsAtPoint(otherPdf, 0, { x: 52, y: 35 });
		await expect(remove(bytes, other!.target!)).rejects.toThrow(/different PDF|earlier saved version/i);

		const doc = await PDFDocument.load(bytes);
		const annots = doc.getPage(0).node.lookupMaybe(PDFName.of('Annots'), PDFArray)!;
		const target = (await findHighlightsAtPoint(bytes, 0, { x: 30, y: 30 })).find((item) => item.quote === first.quote)!.target!;
		const linkRef = doc.context.register(doc.context.obj({ Type: 'Annot', Subtype: 'Link', Rect: [1, 1, 2, 2] }));
		annots.push(linkRef);
		bytes = await doc.save();
		const refreshed = (await findHighlightsAtPoint(bytes, 0, { x: 30, y: 30 })).find((item) => item.quote === first.quote)!.target!;
		const removed = await remove(bytes, refreshed);
		expect(removed.removedCount).toBe(1);
		const after = await PDFDocument.load(removed.bytes);
		const remainingAnnots = after.getPage(0).node.lookupMaybe(PDFName.of('Annots'), PDFArray)!;
		expect(remainingAnnots.size()).toBe(2);
		expect(remainingAnnots.asArray().some((value) => value instanceof PDFRef && value.objectNumber === refreshed.objectNumber)).toBe(false);
		expect(remainingAnnots.asArray().some((value) => value instanceof PDFRef && value.objectNumber === second.target!.objectNumber)).toBe(true);
		expect(remainingAnnots.get(1)?.toString()).toBe(linkRef.toString());
	});

	it('rejects ambiguous duplicate membership without changing the source bytes', async () => {
		const bytesWithOne = await addHighlightAnnotation(await fixture(), { pageIndex: 0, ...SLANTED, color: YELLOW });
		const [candidate] = await findHighlightsAtPoint(bytesWithOne, 0, { x: 52, y: 35 });
		const doc = await PDFDocument.load(bytesWithOne);
		const annots = doc.getPage(0).node.lookupMaybe(PDFName.of('Annots'), PDFArray)!;
		annots.push(annots.get(0)!);
		const duplicated = await doc.save();
		const originalDuplicateBytes = duplicated.slice();
		const duplicateTarget = (await findHighlightsAtPoint(duplicated, 0, { x: 52, y: 35 }))[0]!.target!;
		const remove = removeApi();
		const setNote = noteApi();
		if (!remove || !setNote) {
			expect(typeof remove).toBe('function');
			expect(typeof setNote).toBe('function');
			return;
		}
		await expect(remove(duplicated, duplicateTarget)).rejects.toThrow(/duplicate|ambiguous/i);
		await expect(setNote(duplicated, { ...duplicateTarget, note: 'no ambiguity' })).rejects.toThrow(/duplicate|ambiguous/i);
		expect(duplicated).toEqual(originalDuplicateBytes);
		expect((await findHighlightsAtPoint(duplicated, 0, { x: 52, y: 35 })).length).toBe(1);
		expect(candidate?.target?.objectNumber).toBe(duplicateTarget.objectNumber);
	});

	it('rejects a wrong-subtype target for exact note and removal', async () => {
		const bytes = await addHighlightAnnotation(await fixture(), { pageIndex: 0, ...SLANTED, color: YELLOW });
		const [candidate] = await findHighlightsAtPoint(bytes, 0, { x: 52, y: 35 });
		const doc = await PDFDocument.load(bytes);
		const annots = doc.getPage(0).node.lookupMaybe(PDFName.of('Annots'), PDFArray)!;
		doc.context.lookup(annots.get(0), PDFDict).set(PDFName.of('Subtype'), PDFName.of('Link'));
		const wrongTypeBytes = await doc.save();
		const wrongTypeTarget = { ...candidate!.target!, sourceFingerprint: await fingerprint(wrongTypeBytes) };
		const remove = removeApi();
		const setNote = noteApi();
		if (!remove || !setNote) {
			expect(typeof remove).toBe('function');
			expect(typeof setNote).toBe('function');
			return;
		}
		await expect(remove(wrongTypeBytes, wrongTypeTarget)).rejects.toThrow(/not a \/Highlight/i);
		await expect(setNote(wrongTypeBytes, { ...wrongTypeTarget, note: 'wrong subtype' })).rejects.toThrow(/not a \/Highlight/i);
	});
});


describe('imported rich-text comments', () => {
	it.each([
		{ contents: undefined, note: '' },
		{ contents: 'Old plain comment', note: '' },
		{ contents: 'Old plain comment', note: 'Replacement comment' },
		{ contents: 'Same comment', note: 'Same comment' },
	])('clears stale rich text for Contents=$contents, requested note=$note', async ({ contents, note }) => {
		const bytes = await addHighlightAnnotation(await fixture(), { pageIndex: 0, ...SLANTED, color: YELLOW });
		const doc = await PDFDocument.load(bytes);
		const annots = doc.getPage(0).node.lookupMaybe(PDFName.of('Annots'), PDFArray)!;
		const dict = doc.context.lookup(annots.get(0), PDFDict);
		dict.set(PDFName.of('RC'), PDFString.of('<body><p>Old rich comment</p></body>'));
		if (contents !== undefined) dict.set(PDFName.of('Contents'), PDFHexString.fromText(contents));
		dict.set(PDFName.of('StudyExtra'), PDFHexString.fromText('preserved metadata'));
		const neighbor = doc.context.register(doc.context.obj({ Type: 'Annot', Subtype: 'Text', Rect: [1, 1, 2, 2], RC: PDFString.of('<body>Unrelated rich note</body>') }));
		annots.push(neighbor);
		const imported = await doc.save();
		const { target } = await firstHighlight(imported);
		const result = await setHighlightNoteForTarget(imported, { ...target, note });
		expect(result.updatedCount).toBe(1);
		const after = await PDFDocument.load(result.bytes);
		const changed = after.context.lookup(PDFRef.of(target.objectNumber, target.generationNumber), PDFDict);
		expect(changed.get(PDFName.of('RC'))).toBeUndefined();
		expect(changed.get(PDFName.of('Contents'))?.toString()).toBe(note ? PDFHexString.fromText(note).toString() : undefined);
		expect(changed.get(PDFName.of('StudyExtra'))?.toString()).toBe(PDFHexString.fromText('preserved metadata').toString());
		expect(after.context.lookup(neighbor, PDFDict).get(PDFName.of('RC'))?.toString()).toBe(PDFString.of('<body>Unrelated rich note</body>').toString());
		const noop = await setHighlightNoteForTarget(result.bytes, { ...result.target, note });
		expect(noop.updatedCount).toBe(0);
		expect(noop.bytes).toBe(result.bytes);
	});

	it('removes rich text through the legacy geometry note setter too', async () => {
		const bytes = await addHighlightAnnotation(await fixture(), { pageIndex: 0, ...SLANTED, color: YELLOW });
		const doc = await PDFDocument.load(bytes);
		const annots = doc.getPage(0).node.lookupMaybe(PDFName.of('Annots'), PDFArray)!;
		doc.context.lookup(annots.get(0), PDFDict).set(PDFName.of('RC'), PDFString.of('<body>Old note</body>'));
		const edited = await setHighlightNoteAt(await doc.save(), { pageIndex: 0, box: SLANTED.box, note: '' });
		const after = await PDFDocument.load(edited.bytes);
		expect(after.context.lookup(annots.get(0), PDFDict).get(PDFName.of('RC'))).toBeUndefined();
	});

	it('continues preserving imported rich text when only the color changes', async () => {
		const bytes = await addHighlightAnnotation(await fixture(), { pageIndex: 0, ...SLANTED, color: YELLOW });
		const doc = await PDFDocument.load(bytes);
		const annots = doc.getPage(0).node.lookupMaybe(PDFName.of('Annots'), PDFArray)!;
		const rich = PDFString.of('<body>Keep note</body>');
		doc.context.lookup(annots.get(0), PDFDict).set(PDFName.of('RC'), rich);
		const imported = await doc.save();
		const { ref, target } = await firstHighlight(imported);
		const edited = await setHighlightColorAt(imported, { ...target, color: BLUE });
		const after = await PDFDocument.load(edited.bytes);
		expect(after.context.lookup(ref, PDFDict).get(PDFName.of('RC'))?.toString()).toBe(rich.toString());
	});
});
