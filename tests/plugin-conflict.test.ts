import { describe, expect, it, vi } from 'vitest';
import { inspectStudyPdfPluginConflict } from '../src/plugin-conflict';

describe('Study PDF conflict guard', () => {
	it('allows startup only when community plugin IDs are valid and Study PDF is disabled', async () => {
		const paths: string[] = [];
		await expect(inspectStudyPdfPluginConflict('.obsidian', {
			read: async (path) => { paths.push(path); return '["pdf-plus","study-pdf-local"]'; },
		})).resolves.toBeNull();
		expect(paths).toEqual(['.obsidian/community-plugins.json']);
	});

	it('blocks startup when the original Study PDF plugin is enabled', async () => {
		await expect(inspectStudyPdfPluginConflict('.obsidian', {
			read: async () => '["study-pdf","study-pdf-local"]',
		})).resolves.toMatch(/disable the original Study PDF/i);
	});

	it('blocks missing, malformed, or non-string plugin lists without writing them', async () => {
		const missing = await inspectStudyPdfPluginConflict('.obsidian', { read: async () => { throw new Error('missing'); } });
		const malformed = await inspectStudyPdfPluginConflict('.obsidian', { read: async () => '{not json' });
		const invalid = await inspectStudyPdfPluginConflict('.obsidian', { read: async () => '["good", 4]' });
		expect(missing).toMatch(/could not read/i);
		expect(malformed).toMatch(/could not parse/i);
		expect(invalid).toMatch(/string plugin IDs/i);
	});

	it('rejects config directories that traverse outside the vault', async () => {
		const read = vi.fn(async () => '[]');
		await expect(inspectStudyPdfPluginConflict('../.obsidian', { read })).resolves.toMatch(/invalid/i);
		expect(read).not.toHaveBeenCalled();
	});
});
