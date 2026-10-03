/**
 * Writes that must not overlap, one at a time.
 *
 * `PinQueue` already orders pin writes per project, but it deliberately lets writes for
 * *different* projects run concurrently. That was free while a pin went into its own note:
 * two projects meant two files, and no write could see the other's. Pin ranks are machine
 * state now, so every pin write serialises the whole settings file, and two overlapping
 * `saveData` calls can interleave so the later one writes a snapshot taken before the
 * earlier one finished.
 *
 * `main.saveSettings` routes every settings write through one of these. It is a separate
 * class from `PinQueue` rather than a reuse of it: that one keys by project so that ordering
 * which only matters per project costs nothing, while this one has no key and has to be
 * strictly serial. Two classes because the two invariants are not the same invariant.
 *
 * No `obsidian` import, so `node --test` loads it directly. Same rule as `pin-queue.ts`.
 */
export class WriteChain {
	private tail: Promise<unknown> = Promise.resolve();
	private queued = 0;

	/** How many writes are queued or running. Zero is the only settled state. */
	get pending(): number {
		return this.queued;
	}

	/**
	 * Queue one write, behind whatever is already queued.
	 *
	 * Returns a promise for *this* write, which rejects if it throws. The stored tail never
	 * rejects: a rejected tail would leave every later write queued behind a promise that never
	 * settles, so they would silently never run and the settings file would stop changing. Same
	 * reasoning as `PinQueue`, and for the same reason.
	 */
	run<T>(write: () => Promise<T>): Promise<T> {
		this.queued += 1;
		const queued = this.tail.then(write);
		// The count falls in the same turn the tail settles, rather than in a reaction chained
		// off it: a caller that awaits its own write and then reads the count must see it settled,
		// and one extra microtask of lag would report a finished write as still pending.
		this.tail = queued.then(
			() => this.settled(),
			() => this.settled(),
		);
		return queued;
	}

	/** One write has finished, whichever way it went. The only place the count falls. */
	private settled(): void {
		this.queued -= 1;
	}

	/**
	 * Wait until nothing is queued or in flight.
	 *
	 * Not needed before reading the in-memory state, because a queued write has already mutated
	 * it. It is here for a caller that has to be sure the file on disk matches, and it exists
	 * mostly so the failure mode is a resolved promise rather than a hang.
	 */
	async settle(): Promise<void> {
		while (this.queued > 0) {
			await this.tail.catch(() => undefined);
		}
	}
}
