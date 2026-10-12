import { afterEach, describe, expect, it, vi } from 'vitest';
import { PDFDocument } from '@cantoo/pdf-lib';
import {
	addHighlightAnnotation,
	buildHighlightIndex,
	getVerifiedHighlightState,
	removeHighlightForTarget,
	setHighlightColorAt,
	setHighlightNoteForTarget,
	type HighlightIndex,
	type HighlightTarget,
} from '../src/annotate';
import { makeFixturePdfBytes } from './helpers/pdf-fixture';

const YELLOW = { r: 1, g: 0.92, b: 0.2 };
const BLUE = { r: 0.12, g: 0.34, b: 0.78 };
const FIRST = {
	pageIndex: 0,
	quadPoints: [20, 40, 80, 40, 20, 20, 80, 20],
	box: { left: 20, right: 80, top: 40, bottom: 20 },
};

async function fingerprint(bytes: Uint8Array): Promise<string> {
	const view = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const digest = await globalThis.crypto.subtle.digest('SHA-256', view as BufferSource);
	return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, '0')).join('');
}

async function highlight(bytes?: Uint8Array): Promise<{ bytes: Uint8Array; target: HighlightTarget }> {
	const input = bytes ?? await makeFixturePdfBytes();
	const highlighted = await addHighlightAnnotation(input, { ...FIRST, color: YELLOW });
	const target = firstTarget(await buildHighlightIndex(highlighted));
	return { bytes: highlighted, target };
}

function firstTarget(index: HighlightIndex): HighlightTarget {
	const target = [...index.values()].flat().find((entry) => entry.target)?.target;
	if (!target) throw new Error('Fixture does not contain a highlight target.');
	return target;
}

async function expectStateMatchesBytes(bytes: Uint8Array): Promise<void> {
	const state = getVerifiedHighlightState(bytes);
	expect(state).toBeDefined();
	if (!state) return;

	expect(state.fingerprint).toBe(await fingerprint(bytes));
	expect(state.index).toEqual(await buildHighlightIndex(bytes));
	for (const entries of state.index.values()) {
		for (const entry of entries) {
			if (entry.target) expect(entry.target.sourceFingerprint).toBe(state.fingerprint);
		}
	}
}

describe('verified highlight state', () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('caches the verified index for the exact bytes returned by add', async () => {
		const input = await makeFixturePdfBytes();
		const loadSpy = vi.spyOn(PDFDocument, 'load');
		const output = await addHighlightAnnotation(input, { ...FIRST, color: YELLOW });

		expect(loadSpy).toHaveBeenCalledTimes(2);
		expect(getVerifiedHighlightState(output)).toBeDefined();
		expect(getVerifiedHighlightState(new Uint8Array(output))).toBeUndefined();
		expect(getVerifiedHighlightState(output.subarray(0))).toBeUndefined();
		expect(getVerifiedHighlightState(new Uint8Array([1, 2, 3]))).toBeUndefined();
		await expectStateMatchesBytes(output);
	});

	it('caches the recolored index without parsing a third time', async () => {
		const { bytes, target } = await highlight();
		const loadSpy = vi.spyOn(PDFDocument, 'load');
		const result = await setHighlightColorAt(bytes, { ...target, color: BLUE });

		expect(loadSpy).toHaveBeenCalledTimes(2);
		const state = getVerifiedHighlightState(result.bytes);
		expect(state?.fingerprint).toBe(result.target.sourceFingerprint);
		await expectStateMatchesBytes(result.bytes);
	});

	it('caches the noted index without parsing a third time', async () => {
		const { bytes, target } = await highlight();
		const loadSpy = vi.spyOn(PDFDocument, 'load');
		const result = await setHighlightNoteForTarget(bytes, { ...target, note: 'review this passage' });

		expect(loadSpy).toHaveBeenCalledTimes(2);
		const state = getVerifiedHighlightState(result.bytes);
		expect(state?.fingerprint).toBe(result.target.sourceFingerprint);
		await expectStateMatchesBytes(result.bytes);
	});

	it('caches the remaining index after removing a target without parsing a third time', async () => {
		const first = await addHighlightAnnotation(await makeFixturePdfBytes(), { ...FIRST, color: YELLOW });
		const second = await addHighlightAnnotation(first, {
			pageIndex: 0,
			quadPoints: [20, 80, 80, 80, 20, 60, 80, 60],
			box: { left: 20, right: 80, top: 80, bottom: 60 },
			color: YELLOW,
		});
		const index = await buildHighlightIndex(second);
		const target = firstTarget(index);
		const loadSpy = vi.spyOn(PDFDocument, 'load');
		const result = await removeHighlightForTarget(second, target);

		expect(result.removedCount).toBe(1);
		expect(loadSpy).toHaveBeenCalledTimes(2);
		const state = getVerifiedHighlightState(result.bytes);
		expect(state?.index.get(0)).toHaveLength(1);
		await expectStateMatchesBytes(result.bytes);
	});
});
