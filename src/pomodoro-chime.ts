/** Quiet generated tones: no downloaded audio, perpetual playback, or background
 * audio tricks. Arm from a user click to satisfy mobile autoplay policies. */
export class PomodoroChime {
	private context: AudioContext | null = null;
	private owner: Window | null = null;
	private disposed = false;
	arm(win: Window): Promise<void> {
		if (this.disposed) return Promise.resolve();
		try {
			if (!this.context || this.context.state === 'closed' || this.owner?.closed) {
				const Constructor = (win as Window & { AudioContext?: typeof AudioContext }).AudioContext;
				if (!Constructor) return Promise.resolve();
				this.context = new Constructor();
				this.owner = win;
			}
			if (this.context.state === 'suspended') return this.context.resume().catch(() => undefined);
		} catch { /* The visible timer remains functional if audio is unavailable. */ }
		return Promise.resolve();
	}
	play(volume: number, muted: boolean): void {
		const context = this.context;
		if (this.disposed || muted || volume <= 0 || !context || context.state !== 'running' || this.owner?.closed) return;
		try {
			const start = context.currentTime;
			// A soft gong-like strike: inharmonic modes bloom together and decay
			// at different rates, with a slight downward pitch settling.
			const modes = [
				{ ratio: 1, weight: 0.40, decay: 3.8 },
				{ ratio: 1.48, weight: 0.25, decay: 3.1 },
				{ ratio: 2.11, weight: 0.16, decay: 2.5 },
				{ ratio: 2.77, weight: 0.10, decay: 2.0 },
				{ ratio: 3.92, weight: 0.06, decay: 1.5 },
				{ ratio: 5.41, weight: 0.03, decay: 1.1 },
			];
			for (const mode of modes) {
				const tone = context.createOscillator();
				const envelope = context.createGain();
				tone.type = 'sine';
				tone.frequency.setValueAtTime(196 * mode.ratio * 1.012, start);
				tone.frequency.exponentialRampToValueAtTime(196 * mode.ratio, start + 0.5);
				envelope.gain.setValueAtTime(0.0001, start);
				envelope.gain.exponentialRampToValueAtTime(Math.max(0.0001, Math.min(1, volume) * 0.18 * mode.weight), start + 0.02);
				envelope.gain.exponentialRampToValueAtTime(0.0001, start + mode.decay);
				tone.connect(envelope);
				envelope.connect(context.destination);
				tone.onended = () => { tone.disconnect(); envelope.disconnect(); };
				tone.start(start);
				tone.stop(start + mode.decay + 0.05);
			}
		} catch { /* Sleep/background audio restrictions must not interrupt rounds. */ }
	}
	dispose(): void {
		this.disposed = true;
		if (this.context) void this.context.close().catch(() => undefined);
		this.context = null;
		this.owner = null;
	}
}
