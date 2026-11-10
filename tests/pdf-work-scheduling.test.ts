import { afterEach, describe, expect, it, vi } from 'vitest';
import { PDFDocument, ParseSpeeds } from '@cantoo/pdf-lib';
import {
	addHighlightAnnotation,
	configurePdfWorkScheduling,
	getStoredQuotes,
} from '../src/annotate';

const BOX = { left: 0, right: 10, top: 10, bottom: 0 };
const COLOR = { r: 1, g: 0.92, b: 0.2 };

afterEach(() => {
	vi.restoreAllMocks();
	configurePdfWorkScheduling(false);
});

async function onePagePdf(): Promise<Uint8Array> {
	const doc = await PDFDocument.create();
	doc.addPage([400, 300]);
	return doc.save();
}

async function ownerEncryptedPdf(): Promise<Uint8Array> {
	const doc = await PDFDocument.create();
	doc.addPage([400, 300]);
	doc.encrypt({ ownerPassword: 'scheduling-test-owner', permissions: { modifying: false } });
	return doc.save();
}

async function objectHeavyPdf(objectCount: number): Promise<Uint8Array> {
	const doc = await PDFDocument.create();
	doc.addPage([400, 300]);
	for (let index = 0; index < objectCount; index++) {
		doc.context.register(doc.context.obj({ Index: index }));
	}
	return doc.save({ useObjectStreams: false, objectsPerTick: Infinity });
}

function watchPdfWorkOptions(): {
	loadSpeeds: Array<number | undefined>;
	saveBatchSizes: Array<number | undefined>;
} {
	const loadSpeeds: Array<number | undefined> = [];
	const saveBatchSizes: Array<number | undefined> = [];
	const originalLoad = PDFDocument.load.bind(PDFDocument);
	const originalSave = PDFDocument.prototype.save;
	vi.spyOn(PDFDocument, 'load').mockImplementation(async (input, options) => {
		loadSpeeds.push(options?.parseSpeed);
		return originalLoad(input, options);
	});
	vi.spyOn(PDFDocument.prototype, 'save').mockImplementation(function (options) {
		saveBatchSizes.push(options?.objectsPerTick);
		return originalSave.call(this, options);
	});
	return { loadSpeeds, saveBatchSizes };
}

describe('platform-aware PDF work scheduling', () => {
	it('caps parse, verification, and save work on iOS, then restores desktop scheduling', async () => {
		const bytes = await onePagePdf();
		const { loadSpeeds, saveBatchSizes } = watchPdfWorkOptions();

		configurePdfWorkScheduling(true);
		await addHighlightAnnotation(bytes, {
			pageIndex: 0,
			quadPoints: [0, 10, 10, 10, 0, 0, 10, 0],
			box: BOX,
			color: COLOR,
		});
		expect(loadSpeeds).toEqual([ParseSpeeds.Medium, ParseSpeeds.Medium]);
		expect(saveBatchSizes).toEqual([500]);

		configurePdfWorkScheduling(false);
		await addHighlightAnnotation(bytes, {
			pageIndex: 0,
			quadPoints: [0, 10, 10, 10, 0, 0, 10, 0],
			box: BOX,
			color: COLOR,
		});
		expect(loadSpeeds.slice(2)).toEqual([ParseSpeeds.Fastest, ParseSpeeds.Fastest]);
		expect(saveBatchSizes.slice(1)).toEqual([Infinity]);
	});

	it('uses the finite parse cap for the encrypted-PDF fallback too', async () => {
		const bytes = await ownerEncryptedPdf();
		const { loadSpeeds, saveBatchSizes } = watchPdfWorkOptions();
		configurePdfWorkScheduling(true);

		await addHighlightAnnotation(bytes, {
			pageIndex: 0,
			quadPoints: [0, 10, 10, 10, 0, 0, 10, 0],
			box: BOX,
			color: COLOR,
		});

		expect(loadSpeeds).toEqual([ParseSpeeds.Medium, ParseSpeeds.Medium, ParseSpeeds.Medium]);
		expect(saveBatchSizes).toEqual([500]);
	});

	it('lets a timer run while loading a small but object-heavy PDF', async () => {
		const bytes = await objectHeavyPdf(1200);
		expect(bytes.byteLength).toBeLessThan(8 * 1024 * 1024);
		configurePdfWorkScheduling(true);

		let timerTicks = 0;
		const timerId = setTimeout(() => { timerTicks++; }, 0);
		await getStoredQuotes(bytes);
		const parserYieldedToTimer = timerTicks > 0;
		clearTimeout(timerId);

		expect(parserYieldedToTimer).toBe(true);
	});
});
