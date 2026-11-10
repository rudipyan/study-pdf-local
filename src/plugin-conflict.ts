export interface PluginConfigurationReader {
	read(path: string): Promise<string>;
}

/** Returns a blocking notice when the original Study PDF plugin is enabled or
 * the community plugin list cannot be checked safely. This function is read-only. */
export async function inspectStudyPdfPluginConflict(
	configDir: string,
	reader: PluginConfigurationReader,
): Promise<string | null> {
	const slashedConfigDir = configDir.replace(/\\/g, '/').replace(/\/+$/, '');
	const configSegments = slashedConfigDir.split('/').filter((segment) => segment !== '' && segment !== '.');
	if (!slashedConfigDir || slashedConfigDir.startsWith('/') || /^[A-Za-z]:/.test(slashedConfigDir) ||
		configSegments.length === 0 || configSegments.includes('..')) {
		return 'Could not verify installed PDF plugins because the Obsidian config path is invalid.';
	}
	const path = `${configSegments.join('/')}/community-plugins.json`;
	let contents: string;
	try {
		contents = await reader.read(path);
	} catch {
		return 'Could not read community-plugins.json, so plugin startup was stopped safely.';
	}
	let value: unknown;
	try {
		value = JSON.parse(contents);
	} catch {
		return 'Could not parse community-plugins.json, so plugin startup was stopped safely.';
	}
	if (!Array.isArray(value) || !value.every((id) => typeof id === 'string')) {
		return 'community-plugins.json must contain an array of string plugin IDs.';
	}
	if (value.includes('study-pdf')) {
		return 'Disable the original Study PDF plugin before enabling Rudi\'s Study PDF.';
	}
	return null;
}
