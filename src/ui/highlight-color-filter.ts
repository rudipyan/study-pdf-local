import type { HighlightEntry } from '../pdf-highlights';

export interface HighlightColorCount {
	colorCss: string;
	count: number;
}

/** Preserve first-seen color order and count only the in-memory scan result. */
export function collectHighlightColors(entries: readonly HighlightEntry[]): HighlightColorCount[] {
	const counts = new Map<string, number>();
	for (const entry of entries) counts.set(entry.colorCss, (counts.get(entry.colorCss) ?? 0) + 1);
	return [...counts].map(([colorCss, count]) => ({ colorCss, count }));
}

/** An empty selection means all colors; multiple selected colors use OR. */
export function filterHighlightsByColor<T extends { colorCss: string }>(
	entries: readonly T[],
	selectedColors: ReadonlySet<string>,
): T[] {
	if (selectedColors.size === 0) return [...entries];
	return entries.filter((entry) => selectedColors.has(entry.colorCss));
}
