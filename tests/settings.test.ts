import { describe, expect, it, vi } from 'vitest';
import * as palette from '../src/color-palette';

function normalize(raw: unknown) {
	return palette.normalizePdfHighlighterSettings(raw);
}

function convertHex(hex: string) {
	return palette.hexToRgbColor(hex);
}

describe('normalizePdfHighlighterSettings', () => {
	it('provides the five existing colors with stable IDs and Yellow as default', () => {
		expect(palette.DEFAULT_SETTINGS).toEqual({
			colors: [
				{ id: 'yellow', name: 'Yellow', hex: '#ffff00' },
				{ id: 'red', name: 'Red', hex: '#ff0000' },
				{ id: 'orange', name: 'Orange', hex: '#ff8000' },
				{ id: 'green', name: 'Green', hex: '#00ff00' },
				{ id: 'purple', name: 'Purple', hex: '#a22cff' },
			],
			defaultColorId: 'yellow',
		});
		expect(palette.getDefaultColor(normalize(null))).toEqual({
			id: 'yellow',
			name: 'Yellow',
			hex: '#ffff00',
		});
	});

	it('preserves a valid custom color and its selected default ID', () => {
		const settings = normalize({
			colors: [
				{ id: 'yellow', name: 'Yellow', hex: '#ffff00' },
				{ id: 'ocean-blue', name: 'Ocean', hex: ' #1289AB ' },
			],
			defaultColorId: 'ocean-blue',
		});

		expect(settings.colors).toEqual([
			{ id: 'yellow', name: 'Yellow', hex: '#ffff00' },
			{ id: 'ocean-blue', name: 'Ocean', hex: '#1289ab' },
		]);
		expect(palette.getDefaultColor(settings)).toEqual({
			id: 'ocean-blue',
			name: 'Ocean',
			hex: '#1289ab',
		});
	});

	it('keeps IDs and the selected default stable through rename, recolor, and reorder', () => {
		const original = normalize({
			colors: [
				{ id: 'primary', name: 'Ocean', hex: '#123456' },
				{ id: 'accent', name: 'Sand', hex: '#c0a080' },
			],
			defaultColorId: 'primary',
		});
		const edited = normalize({
			colors: [
				{ id: 'accent', name: 'Amber', hex: '#d08030' },
				{ id: 'primary', name: 'Deep ocean', hex: '#204060' },
			],
			defaultColorId: original.defaultColorId,
		});

		expect(original.colors).toEqual([
			{ id: 'primary', name: 'Ocean', hex: '#123456' },
			{ id: 'accent', name: 'Sand', hex: '#c0a080' },
		]);
		expect(edited.colors).toEqual([
			{ id: 'accent', name: 'Amber', hex: '#d08030' },
			{ id: 'primary', name: 'Deep ocean', hex: '#204060' },
		]);
		expect(edited.defaultColorId).toBe(original.defaultColorId);
		expect(palette.getDefaultColor(edited)).toEqual({
			id: 'primary',
			name: 'Deep ocean',
			hex: '#204060',
		});
	});

	it('drops invalid hex colors instead of partially parsing them', () => {
		const settings = normalize({
			colors: [
				{ id: 'good', name: 'Good', hex: '#123456' },
				{ id: 'bad', name: 'Bad', hex: '#12zz56' },
				{ id: 'short', name: 'Short', hex: '#abc' },
			],
			defaultColorId: 'bad',
		});

		expect(settings.colors).toEqual([{ id: 'good', name: 'Good', hex: '#123456' }]);
		expect(settings.defaultColorId).toBe('good');
	});

	it('repairs empty and duplicate IDs without taking a later valid ID', () => {
		const settings = normalize({
			colors: [
				{ id: '', name: 'Generated', hex: '#101010' },
				{ id: 'color-1', name: 'Reserved later', hex: '#202020' },
				{ id: 'same', name: 'First holder', hex: '#303030' },
				{ id: 'same', name: 'Duplicate holder', hex: '#404040' },
				{ name: 'Missing ID', hex: '#505050' },
			],
			defaultColorId: 'same',
		});

		expect(settings.colors.map(({ id }) => id)).toEqual([
			'color-1-1',
			'color-1',
			'same',
			'color-4',
			'color-5',
		]);
		expect(settings.defaultColorId).toBe('same');
	});

	it('trims names and deterministically disambiguates duplicates', () => {
		const settings = normalize({
			colors: [
				{ id: 'one', name: '  Sky  ', hex: '#111111' },
				{ id: 'two', name: 'Sky', hex: '#222222' },
				{ id: 'three', name: 'Sky (2)', hex: '#333333' },
				{ id: 'four', name: '   ', hex: '#444444' },
			],
			defaultColorId: 'one',
		});

		expect(settings.colors.map(({ name }) => name)).toEqual([
			'Sky',
			'Sky (3)',
			'Sky (2)',
			'Color 4',
		]);
	});

	it('uses the first remaining color when the saved default is missing or removed', () => {
		const colors = [
			{ id: 'one', name: 'One', hex: '#111111' },
			{ id: 'two', name: 'Two', hex: '#222222' },
		];
		expect(normalize({ colors }).defaultColorId).toBe('one');
		expect(
			normalize({ colors, defaultColorId: 'removed' }).defaultColorId,
		).toBe('one');
	});

	it('migrates a legacy default name only when no canonical default ID exists', () => {
		const legacy = normalize({
			colors: [
				{ id: 'first', name: 'First', hex: '#111111' },
				{ id: 'second', name: 'Second', hex: '#222222' },
			],
			defaultColorName: 'Second',
		});
		const modern = normalize({
			colors: [
				{ id: 'first', name: 'First', hex: '#111111' },
				{ id: 'second', name: 'Second', hex: '#222222' },
			],
			defaultColorId: 'first',
			defaultColorName: 'Second',
		});

		expect(legacy.defaultColorId).toBe('second');
		expect(modern.defaultColorId).toBe('first');
		expect(legacy).not.toHaveProperty('defaultColorName');
	});

	it('uses the legacy name when a saved default ID is invalid', () => {
		const settings = normalize({
			colors: [
				{ id: 'first', name: 'First', hex: '#111111' },
				{ id: 'second', name: 'Second', hex: '#222222' },
			],
			defaultColorId: 'missing',
			defaultColorName: 'Second',
		});

		expect(settings.defaultColorId).toBe('second');
		expect(settings).not.toHaveProperty('defaultColorName');
	});

	it('preserves unknown top-level and color-row fields for forward compatibility', () => {
		const raw = {
			colors: [{ id: 'one', name: 'One', hex: '#123456', metadata: { source: 'future' } }],
			defaultColorId: 'one',
			futureOption: { enabled: true },
		};
		const settings = normalize(raw);

		expect(settings).toMatchObject({
			colors: [{ id: 'one', name: 'One', hex: '#123456', metadata: { source: 'future' } }],
			defaultColorId: 'one',
			futureOption: { enabled: true },
		});
	});

	it('preserves JSON __proto__ fields without changing object prototypes', () => {
		const raw: unknown = JSON.parse(
			`{"colors":[{"id":"one","name":"One","hex":"#123456","__proto__":{"polluted":true}}],"defaultColorId":"one","__proto__":{"polluted":true}}`,
		);
		const settings = normalize(raw);
		const color = settings.colors[0]!;

		expect(Object.getPrototypeOf(settings)).toBe(Object.prototype);
		expect(Object.getPrototypeOf(color)).toBe(Object.prototype);
		expect(Object.prototype.hasOwnProperty.call(settings, '__proto__')).toBe(true);
		expect(Object.prototype.hasOwnProperty.call(color, '__proto__')).toBe(true);
		expect(Object.getOwnPropertyDescriptor(settings, '__proto__')?.value).toEqual({ polluted: true });
		expect(Object.getOwnPropertyDescriptor(color, '__proto__')?.value).toEqual({ polluted: true });
	});

	it('does not request a save when no settings data exists', () => {
		expect(palette.normalizePdfHighlighterSettingsForLoad(null).shouldPersist).toBe(false);
		expect(palette.normalizePdfHighlighterSettingsForLoad(undefined).shouldPersist).toBe(false);
	});

	it('requests a legacy migration save once, then treats the saved result as canonical', () => {
		const legacy = {
			colors: [
				{ id: 'first', name: 'First', hex: '#111111' },
				{ id: 'second', name: 'Second', hex: '#222222' },
			],
			defaultColorName: 'Second',
		};
		const migrated = palette.normalizePdfHighlighterSettingsForLoad(legacy);
		const saved = palette.normalizePdfHighlighterSettingsForLoad(migrated.settings);

		expect(migrated.shouldPersist).toBe(true);
		expect(migrated.settings.defaultColorId).toBe('second');
		expect(migrated.settings).not.toHaveProperty('defaultColorName');
		expect(saved.shouldPersist).toBe(false);
	});

	it('saves repaired missing and duplicate IDs once, then loads them as canonical', async () => {
		const raw = {
			colors: [
				{ name: 'Missing ID', hex: '#111111' },
				{ id: 'same', name: 'First holder', hex: '#222222' },
				{ id: 'same', name: 'Duplicate holder', hex: '#333333' },
			],
			defaultColorId: 'same',
		};
		let savedData: unknown;
		const save = vi.fn(async (settings: unknown) => {
			savedData = settings;
		});

		const firstLoad = palette.normalizePdfHighlighterSettingsForLoad(raw);
		expect(firstLoad.shouldPersist).toBe(true);
		expect(await palette.persistPdfHighlighterSettingsIfNeeded(firstLoad, save)).toBe(true);
		expect(save).toHaveBeenCalledTimes(1);
		expect(firstLoad.settings.colors.map(({ id }) => id)).toEqual(['color-1', 'same', 'color-3']);

		const nextLoad = palette.normalizePdfHighlighterSettingsForLoad(savedData);
		expect(nextLoad.shouldPersist).toBe(false);
		expect(await palette.persistPdfHighlighterSettingsIfNeeded(nextLoad, save)).toBe(true);
		expect(save).toHaveBeenCalledTimes(1);
	});

	it('keeps repaired settings available when their migration save fails', async () => {
		const result = palette.normalizePdfHighlighterSettingsForLoad({
			colors: [{ name: 'Missing ID', hex: '#111111' }],
		});

		await expect(
			palette.persistPdfHighlighterSettingsIfNeeded(result, async () => {
				throw new Error('write failed');
			}),
		).resolves.toBe(false);
		expect(result.settings.colors).toEqual([{ id: 'color-1', name: 'Missing ID', hex: '#111111' }]);
	});

	it('does not request a save for canonical data with unknown fields', () => {
		const canonical = {
			colors: [{ id: 'one', name: 'One', hex: '#123456', metadata: { source: 'future' } }],
			defaultColorId: 'one',
			futureOption: { enabled: true },
		};

		expect(palette.normalizePdfHighlighterSettingsForLoad(canonical).shouldPersist).toBe(false);
	});

	it('falls back to cloned defaults for primitives, malformed arrays, or no valid colors', () => {
		for (const raw of [null, undefined, 7, 'settings', [], { colors: 'not an array' }]) {
			expect(normalize(raw)).toEqual(palette.DEFAULT_SETTINGS);
		}
		expect(
			normalize({ colors: [{ id: 'bad', name: 'Bad', hex: 'blue' }] }),
		).toEqual(palette.DEFAULT_SETTINGS);
	});

	it('is deterministic, idempotent, and does not mutate inputs or defaults', () => {
		const raw = {
			colors: [
				{ id: '', name: 'Custom', hex: '#A0B0C0' },
				{ id: 'same', name: 'Custom', hex: '#D0E0F0' },
			],
			defaultColorName: 'Custom',
		};
		const original = structuredClone(raw);
		const beforeDefaults = structuredClone(palette.DEFAULT_SETTINGS);
		const first = normalize(raw);
		const second = normalize(first);
		const third = normalize(raw);

		expect(first).toEqual(second);
		expect(third).toEqual(first);
		expect(raw).toEqual(original);
		expect(palette.DEFAULT_SETTINGS).toEqual(beforeDefaults);
		expect(first).not.toBe(second);
		expect(first.colors).not.toBe(second.colors);
	});

	it('returns independent copies of the defaults for separate repairs', () => {
		const first = normalize(null);
		const second = normalize(null);
		first.colors[0]!.name = 'Changed';

		expect(second.colors[0]!.name).toBe('Yellow');
		expect(palette.DEFAULT_SETTINGS.colors[0]!.name).toBe('Yellow');
	});
});

describe('hexToRgbColor', () => {
	it('converts black, white, and uppercase hex to normalized RGB values', () => {
		expect(convertHex('#000000')).toEqual({ r: 0, g: 0, b: 0 });
		expect(convertHex('#FFFFFF')).toEqual({ r: 1, g: 1, b: 1 });
		expect(convertHex('#1289AB')).toEqual({ r: 18 / 255, g: 137 / 255, b: 171 / 255 });
	});

	it('rejects malformed hex values', () => {
		for (const hex of ['blue', '#abc', '#12zz56', '#12345678', '123456']) {
			expect(() => palette.hexToRgbColor(hex)).toThrow(TypeError);
		}
	});
});
