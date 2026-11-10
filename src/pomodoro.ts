export type PomodoroPhase = 'study' | 'break';
export interface PomodoroState {
	studyMinutes: number;
	breakMinutes: number;
	autoRepeat: boolean;
	muted: boolean;
	volume: number;
	phase: PomodoroPhase;
	running: boolean;
	remainingMs: number;
	endsAt: number;
	completedRounds: number;
}
export interface PomodoroSnapshot extends PomodoroState { remainingSeconds: number }
interface TimerStorage {
	exists(path: string): Promise<boolean>;
	read(path: string): Promise<string>;
	write(path: string, value: string): Promise<void>;
}
const DEFAULT: PomodoroState = { studyMinutes: 25, breakMinutes: 5, autoRepeat: false, muted: false, volume: 0.25,
	phase: 'study', running: false, remainingMs: 25 * 60000, endsAt: 0, completedRounds: 0 };
const bounded = (value: unknown, min: number, max: number): value is number =>
	typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;

/** One wall-clock timer per plugin instance. Tick updates subscribers only; PDF
 * views, parsing, selection, and file mutation are never involved. */
export class PomodoroTimer {
	private state = { ...DEFAULT };
	private readonly listeners = new Set<(snapshot: PomodoroSnapshot) => void>();
	private interval = 0;
	private tail = Promise.resolve();
	private disposed = false;
	private writable = true;
	private readonly onVisible = () => { if (this.win.document.visibilityState === 'visible') this.tick(); };
	constructor(private readonly win: Window, private readonly storage: TimerStorage, private readonly path: string,
		private readonly onTransition: (phase: PomodoroPhase, caughtUp: boolean) => void,
		private readonly onStorageError: () => void) {}

	async load(): Promise<void> {
		try {
			if (await this.storage.exists(this.path)) {
				const raw = await this.storage.read(this.path);
				if (raw.length > 10000) throw new Error('Invalid timer data');
				const data = JSON.parse(raw) as Partial<PomodoroState> | null;
				if (!data || !bounded(data.studyMinutes, 1, 180) || !Number.isInteger(data.studyMinutes) ||
					!bounded(data.breakMinutes, 1, 60) || !Number.isInteger(data.breakMinutes) ||
					(data.autoRepeat !== undefined && typeof data.autoRepeat !== 'boolean') ||
					!bounded(data.volume, 0, 1) || typeof data.muted !== 'boolean' || typeof data.running !== 'boolean' ||
					(data.phase !== 'study' && data.phase !== 'break') || !bounded(data.remainingMs, 0, 10800000) ||
					!bounded(data.endsAt, 0, 8640000000000000) || !bounded(data.completedRounds, 0, 1000000000) ||
					!Number.isInteger(data.completedRounds)) throw new Error('Invalid timer data');
				this.state = { studyMinutes: data.studyMinutes, breakMinutes: data.breakMinutes,
					autoRepeat: data.autoRepeat ?? false, volume: data.volume, muted: data.muted, running: data.running, phase: data.phase,
					remainingMs: data.remainingMs, endsAt: data.endsAt, completedRounds: data.completedRounds };
				if (this.state.running && (!this.state.endsAt || this.state.endsAt > Date.now() + 10860000)) {
					this.state.running = false;
					this.state.remainingMs = this.duration();
				}
			}
		} catch { this.writable = false; this.onStorageError(); }
		if (this.disposed) return;
		this.advance(Date.now(), false);
		this.win.document.addEventListener('visibilitychange', this.onVisible);
		this.schedule();
	}

	snapshot(): PomodoroSnapshot {
		return { ...this.state, remainingSeconds: Math.max(0, Math.ceil(
			(this.state.running ? this.state.endsAt - Date.now() : this.state.remainingMs) / 1000)) };
	}
	subscribe(listener: (snapshot: PomodoroSnapshot) => void): () => void {
		this.listeners.add(listener);
		listener(this.snapshot());
		return () => this.listeners.delete(listener);
	}
	toggle(): void {
		if (this.disposed) return;
		const wasRunning = this.state.running;
		this.advance(Date.now());
		if (wasRunning) {
			if (this.state.running) this.state.remainingMs = Math.max(0, this.state.endsAt - Date.now());
			this.state.running = false;
		} else {
			this.state.endsAt = Date.now() + this.state.remainingMs;
			this.state.running = true;
		}
		this.changed();
	}
	reset(): void {
		if (this.disposed) return;
		this.state.phase = 'study';
		this.state.running = false;
		this.state.remainingMs = this.duration();
		this.state.endsAt = 0;
		this.state.completedRounds = 0;
		this.changed();
	}
	skipBreak(): void {
		if (this.disposed) return;
		this.advance(Date.now());
		if (this.state.phase !== 'break') { this.emit(); return; }
		this.state.phase = 'study';
		this.state.remainingMs = this.duration();
		if (this.state.running) this.state.endsAt = Date.now() + this.state.remainingMs;
		this.changed();
	}
	configure(values: Partial<Pick<PomodoroState, 'studyMinutes' | 'breakMinutes' | 'volume' | 'muted' | 'autoRepeat'>>): void {
		if (this.disposed) return;
		this.advance(Date.now());
		const previousDuration = this.duration();
		let durationsChanged = false;
		for (const key of ['studyMinutes', 'breakMinutes'] as const) {
			const value = values[key];
			if (bounded(value, 1, key === 'studyMinutes' ? 180 : 60) && Number.isInteger(value) && value !== this.state[key]) {
				this.state[key] = value;
				durationsChanged = true;
			}
		}
		if (bounded(values.volume, 0, 1)) this.state.volume = values.volume;
		if (typeof values.muted === 'boolean') this.state.muted = values.muted;
		if (typeof values.autoRepeat === 'boolean') this.state.autoRepeat = values.autoRepeat;
		if (durationsChanged && !this.state.running && this.duration() !== previousDuration) this.state.remainingMs = this.duration();
		this.changed();
	}
	private duration(): number { return (this.state.phase === 'study' ? this.state.studyMinutes : this.state.breakMinutes) * 60000; }
	private advance(now: number, notify = true): void {
		if (!this.state.running || now < this.state.endsAt) return;
		let transitions = 0;
		const flip = () => {
			const finishedBreak = this.state.phase === 'break';
			if (this.state.phase === 'study') this.state.completedRounds++;
			this.state.phase = this.state.phase === 'study' ? 'break' : 'study';
			this.state.remainingMs = this.duration();
			if (finishedBreak && !this.state.autoRepeat) {
				this.state.running = false;
				this.state.endsAt = 0;
			} else this.state.endsAt += this.state.remainingMs;
			transitions++;
		};
		flip();
		// Skip whole cycles arithmetically after suspension; never replay a queue
		// of old alarms or run an unbounded catch-up loop on the UI thread.
		const cycle = (this.state.studyMinutes + this.state.breakMinutes) * 60000;
		const cycles = this.state.autoRepeat && this.state.running ? Math.max(0, Math.floor((now - this.state.endsAt) / cycle)) : 0;
		this.state.endsAt += cycles * cycle;
		this.state.completedRounds += cycles;
		if (cycles) transitions += cycles * 2;
		while (this.state.running && now >= this.state.endsAt) flip(); // At most two further boundaries.
		if (!this.state.running) this.schedule();
		this.persist();
		if (notify) this.onTransition(this.state.phase, transitions > 1);
	}
	private tick(): void {
		if (this.disposed || !this.state.running) return;
		this.advance(Date.now());
		this.emit();
	}
	private schedule(): void {
		if (this.interval) this.win.clearInterval(this.interval);
		this.interval = this.state.running && !this.disposed ? this.win.setInterval(() => this.tick(), 1000) : 0;
	}
	private changed(): void { this.persist(); this.schedule(); this.emit(); }
	private emit(): void { const snapshot = this.snapshot(); for (const listener of this.listeners) listener(snapshot); }
	private persist(): void {
		if (!this.writable) return;
		const serialized = JSON.stringify(this.state);
		this.tail = this.tail.then(() => this.storage.write(this.path, serialized)).catch(() => this.onStorageError());
	}
	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		if (this.interval) this.win.clearInterval(this.interval);
		this.win.document.removeEventListener('visibilitychange', this.onVisible);
		this.listeners.clear();
	}
}

export function formatPomodoroTime(seconds: number): string {
	return `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`;
}
