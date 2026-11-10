export interface NoteMarkerPosition { x: number; y: number }
export interface StoredNoteMarkerPosition extends NoteMarkerPosition { space: 'pdf' }

interface PositionAdapter {
	exists(path: string): Promise<boolean>;
	read(path: string): Promise<string>;
	write(path: string, value: string): Promise<void>;
}

const MAX_POSITIONS = 2000;
const MAX_FILE_SIZE = 1024 * 1024;

function validPosition(value: unknown): value is StoredNoteMarkerPosition {
	if (!value || typeof value !== 'object') return false;
	const point = value as Partial<StoredNoteMarkerPosition>;
	return typeof point.x === 'number' && typeof point.y === 'number' &&
		Number.isFinite(point.x) && Number.isFinite(point.y) &&
		Math.abs(point.x) <= 10000000 && Math.abs(point.y) <= 10000000 && point.space === 'pdf';
}

/** Small UI-only sidecar. Reads once on plugin load, writes only after a drop;
 * never rewrites or reparses the article to move a comment icon. */
export class NoteMarkerPositions {
	private readonly positions = new Map<string, StoredNoteMarkerPosition>();
	private tail = Promise.resolve();
	private writable = true;

	constructor(private readonly adapter: PositionAdapter, private readonly path: string, private readonly onError: () => void) {}

	async load(): Promise<void> {
		try {
			if (!await this.adapter.exists(this.path)) return;
			const raw = await this.adapter.read(this.path);
			if (raw.length > MAX_FILE_SIZE) throw new Error('Marker positions file is too large.');
			const data = JSON.parse(raw) as { version?: unknown; positions?: unknown };
			if (data.version !== 1 || !Array.isArray(data.positions)) throw new Error('Invalid marker positions.');
			for (const entry of data.positions.slice(-MAX_POSITIONS) as unknown[]) {
				if (!Array.isArray(entry) || typeof entry[0] !== 'string' || entry[0].length > 4096 || !validPosition(entry[1])) continue;
				this.positions.set(entry[0], { ...entry[1] });
			}
		} catch {
			this.writable = false; // Preserve unreadable existing data instead of overwriting it.
			this.onError();
		}
	}

	get(file: string, page: number, marker: string): StoredNoteMarkerPosition | undefined {
		return this.positions.get(JSON.stringify([file, page, marker]));
	}

	set(file: string, page: number, marker: string, position: StoredNoteMarkerPosition): void {
		if (!validPosition(position)) return;
		const key = JSON.stringify([file, page, marker]);
		if (key.length > 4096) return;
		this.positions.delete(key);
		this.positions.set(key, { ...position });
		while (this.positions.size > MAX_POSITIONS) this.positions.delete(this.positions.keys().next().value!);
		this.save();
	}

	private save(): void {
		if (!this.writable) return;
		const entries = [...this.positions];
		const sizes = entries.map((entry) => JSON.stringify(entry).length + 1);
		let size = 64 + sizes.reduce((sum, value) => sum + value, 0);
		let start = 0;
		while (size > MAX_FILE_SIZE && start < entries.length) {
			this.positions.delete(entries[start]![0]);
			size -= sizes[start++]!;
		}
		const serialized = JSON.stringify({ version: 1, positions: entries.slice(start) });
		this.tail = this.tail.then(() => this.adapter.write(this.path, serialized)).catch(() => this.onError());
	}
}
