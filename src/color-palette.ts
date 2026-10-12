import type { RgbColor } from './annotate';

export interface HighlightColorOption {
	id: string;
	name: string;
	/** A normalized six-digit hex color, such as "#ff8000". */
	hex: string;
}

export interface PdfHighlighterSettings {
	colors: HighlightColorOption[];
	defaultColorId: string;
}

export interface ReadonlyPdfHighlighterSettings {
	readonly colors: readonly Readonly<HighlightColorOption>[];
	readonly defaultColorId: string;
}

export const DEFAULT_SETTINGS: ReadonlyPdfHighlighterSettings = Object.freeze({
	colors: Object.freeze([
		Object.freeze({ id: 'yellow', name: 'Yellow', hex: '#ffff00' }),
		Object.freeze({ id: 'red', name: 'Red', hex: '#ff0000' }),
		Object.freeze({ id: 'orange', name: 'Orange', hex: '#ff8000' }),
		Object.freeze({ id: 'green', name: 'Green', hex: '#00ff00' }),
		Object.freeze({ id: 'purple', name: 'Purple', hex: '#a22cff' }),
	]),
	defaultColorId: 'yellow',
});

interface ValidColorCandidate {
	index: number;
	id: string;
	name: string;
	originalName: string | undefined;
	hex: string;
	extraFields: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeHex(value: unknown): string | null {
	if (typeof value !== 'string') return null;
	const hex = value.trim();
	return /^#[\da-f]{6}$/i.test(hex) ? hex.toLowerCase() : null;
}

function uniqueDisplayName(
	base: string,
	fromInput: boolean,
	usedNames: Set<string>,
	reservedNames: Set<string>,
): string {
	const key = (name: string) => name.toLowerCase();
	if (!usedNames.has(key(base)) && (fromInput || !reservedNames.has(key(base)))) {
		usedNames.add(key(base));
		return base;
	}

	let suffix = 2;
	while (true) {
		const candidate = `${base} (${suffix})`;
		const candidateKey = key(candidate);
		if (!usedNames.has(candidateKey) && !reservedNames.has(candidateKey)) {
			usedNames.add(candidateKey);
			return candidate;
		}
		suffix++;
	}
}

function generatedId(index: number, reservedIds: Set<string>, usedIds: Set<string>): string {
	const base = `color-${index + 1}`;
	let candidate = base;
	let suffix = 1;
	while (reservedIds.has(candidate) || usedIds.has(candidate)) {
		candidate = `${base}-${suffix}`;
		suffix++;
	}
	return candidate;
}

function cloneDefaultColors(): HighlightColorOption[] {
	return DEFAULT_SETTINGS.colors.map((color) => ({ ...color }));
}

/**
 * Repairs persisted settings without mutating the input or the defaults.
 * Invalid color rows are discarded; if none remain, the built-in palette is
 * cloned. Generated IDs are deterministic so repaired settings can be saved
 * once and remain stable through later edits and reorderings.
 */
export function normalizePdfHighlighterSettings(raw: unknown): PdfHighlighterSettings {
	const data = isRecord(raw) ? raw : undefined;
	const rawColors = Array.isArray(data?.colors) ? data.colors : [];
	const candidates: ValidColorCandidate[] = [];

	rawColors.forEach((rawColor, index) => {
		if (!isRecord(rawColor)) return;
		const hex = normalizeHex(rawColor.hex);
		if (!hex) return;

		const id = typeof rawColor.id === 'string' ? rawColor.id.trim() : '';
		const originalName = typeof rawColor.name === 'string' ? rawColor.name.trim() : '';
		const extraFields: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(rawColor)) {
			if (key !== 'id' && key !== 'name' && key !== 'hex') {
				Object.defineProperty(extraFields, key, {
					value,
					enumerable: true,
					configurable: true,
					writable: true,
				});
			}
		}
		candidates.push({
			index,
			id,
			name: originalName || `Color ${index + 1}`,
			originalName: originalName || undefined,
			hex,
			extraFields,
		});
	});

	let colors: HighlightColorOption[];
	const legacyNameIds = new Map<string, string>();
	if (candidates.length === 0) {
		colors = cloneDefaultColors();
		for (const color of colors) legacyNameIds.set(color.name, color.id);
	} else {
		const reservedIds = new Set(candidates.map((candidate) => candidate.id).filter(Boolean));
		const reservedNames = new Set(
			candidates
				.map((candidate) => candidate.originalName?.toLowerCase())
				.filter((name): name is string => name !== undefined),
		);
		const usedIds = new Set<string>();
		const usedNames = new Set<string>();
		colors = candidates.map((candidate) => {
			const id = candidate.id && !usedIds.has(candidate.id)
				? candidate.id
				: generatedId(candidate.index, reservedIds, usedIds);
			usedIds.add(id);

			const name = uniqueDisplayName(
				candidate.name,
				candidate.originalName !== undefined,
				usedNames,
				reservedNames,
			);
			if (candidate.originalName && !legacyNameIds.has(candidate.originalName)) {
				legacyNameIds.set(candidate.originalName, id);
			}
			return { ...candidate.extraFields, id, name, hex: candidate.hex };
		});
	}

	const firstColorId = colors[0]!.id;
	let defaultColorId = firstColorId;
	let hasSelectedDefault = false;
	if (data && Object.prototype.hasOwnProperty.call(data, 'defaultColorId')) {
		if (typeof data.defaultColorId === 'string') {
			const requestedId = data.defaultColorId.trim();
			if (colors.some((color) => color.id === requestedId)) {
				defaultColorId = requestedId;
				hasSelectedDefault = true;
			}
		}
	}
	if (!hasSelectedDefault && typeof data?.defaultColorName === 'string') {
		const legacyName = data.defaultColorName.trim();
		const migratedId = legacyNameIds.get(legacyName);
		if (migratedId && colors.some((color) => color.id === migratedId)) defaultColorId = migratedId;
	}

	const settings: PdfHighlighterSettings = { colors, defaultColorId };
	if (data) {
		for (const [key, value] of Object.entries(data)) {
			if (key !== 'colors' && key !== 'defaultColorId' && key !== 'defaultColorName') {
				Object.defineProperty(settings, key, {
					value,
					enumerable: true,
					configurable: true,
					writable: true,
				});
			}
		}
	}
	return settings;
}

function isCanonicalSettingsData(raw: unknown, normalized: PdfHighlighterSettings): boolean {
	if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return false;
	const data = raw as Record<string, unknown>;
	const savedColors = data.colors;
	if (
		!Object.prototype.hasOwnProperty.call(data, 'colors') ||
		!Object.prototype.hasOwnProperty.call(data, 'defaultColorId') ||
		Object.prototype.hasOwnProperty.call(data, 'defaultColorName') ||
		data.defaultColorId !== normalized.defaultColorId ||
		!Array.isArray(savedColors) ||
		savedColors.length !== normalized.colors.length
	) {
		return false;
	}

	const canonicalColors = savedColors as unknown[];
	return normalized.colors.every((color, index) => {
		const saved: unknown = canonicalColors[index];
		if (typeof saved !== 'object' || saved === null || Array.isArray(saved)) return false;
		const savedColor = saved as Record<string, unknown>;
		return savedColor.id === color.id && savedColor.name === color.name && savedColor.hex === color.hex;
	});
}

export interface PdfHighlighterSettingsLoadResult {
	settings: PdfHighlighterSettings;
	shouldPersist: boolean;
}

/** Normalizes loaded settings and reports whether the repaired result should be saved. */
export function normalizePdfHighlighterSettingsForLoad(raw: unknown): PdfHighlighterSettingsLoadResult {
	const settings = normalizePdfHighlighterSettings(raw);
	return {
		settings,
		shouldPersist: raw !== null && raw !== undefined && !isCanonicalSettingsData(raw, settings),
	};
}

/** Attempts a required migration save without making settings loading fail. */
export async function persistPdfHighlighterSettingsIfNeeded(
	result: PdfHighlighterSettingsLoadResult,
	save: (settings: PdfHighlighterSettings) => Promise<void>,
): Promise<boolean> {
	if (!result.shouldPersist) return true;
	try {
		await save(result.settings);
		return true;
	} catch {
		return false;
	}
}

export function getDefaultColor(settings: PdfHighlighterSettings): HighlightColorOption {
	return (
		settings.colors.find((color) => color.id === settings.defaultColorId) ??
		settings.colors[0] ??
		{ ...DEFAULT_SETTINGS.colors[0]! }
	);
}

export function hexToRgbColor(hex: string): RgbColor {
	if (typeof hex !== 'string' || !/^#[\da-f]{6}$/i.test(hex.trim())) {
		throw new TypeError('Expected a six-digit hex color such as #ff8000');
	}
	const normalized = hex.trim().slice(1);
	return {
		r: parseInt(normalized.slice(0, 2), 16) / 255,
		g: parseInt(normalized.slice(2, 4), 16) / 255,
		b: parseInt(normalized.slice(4, 6), 16) / 255,
	};
}
