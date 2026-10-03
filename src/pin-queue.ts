/**
 * Pin writes in order, and the wait that keeps them out of a rescan's way.
 *
 * Lives here, with the code that reads pins, rather than in `view.ts` so that every
 * rescan path settles it by construction. `refresh` is reached both from the view and
 * from the command palette's "Rescan projects", and a pin written during one of those
 * was read back before it landed.
 *
 * No `obsidian` import, deliberately: `node --test` cannot load that package, so a
 * module that imports it is a module with no tests. Same as `pin-menu-plan.ts`.
 */

/**
 * The tail of each project's pin writes, by project name.
 *
 * One entry per project, not one per write, because writes for one project must not
 * interleave: `applyPin` puts a failed write's row back at the rank the previous write
 * left, which is only safe when nothing newer for that project is in flight. Two writes
 * for one project could otherwise land the first one's rollback after the second had
 * succeeded, so the panel and the note would disagree.
 *
 * Writes for *different* projects still run concurrently: there is nothing to order
 * them against, and one project's slow note should not hold up another's.
 */
export class PinQueue {
	private readonly tails = new Map<string, Promise<void>>();

	/** How many projects have a write in flight. Zero is the only settled state. */
	get inFlight(): number {
		return this.tails.size;
	}

	/**
	 * Queue one write for one project, behind whatever is already writing it.
	 *
	 * `write` runs later, so anything it reads is read when it runs rather than when it
	 * was queued: a `p` pressed twice has to read the rank the first press left, not the
	 * one on screen when the second key went down.
	 *
	 * Returns a promise for *this* write, which rejects if the write throws. The stored
	 * tail never rejects: a rejected tail would leave the next pin for this project
	 * queued behind a promise that never settles, so it would silently never run.
	 */
	queue(name: string, write: () => Promise<void>): Promise<void> {
		const previous = this.tails.get(name) ?? Promise.resolve();
		const queued = previous.then(write);
		const tail = queued.catch(() => {});
		this.tails.set(name, tail);
		void tail.then(() => {
			// Identity, not an unconditional delete. By the time this write settles, a
			// newer one for the same project may already own the entry, and deleting it
			// then would drop that newer write out of the queue: the next pin would not
			// wait for it, and `settle` would stop waiting for it too. That is the race
			// this queue exists to prevent, reintroduced through its own bookkeeping.
			if (this.tails.get(name) === tail) this.tails.delete(name);
		});
		return queued;
	}

	/**
	 * Wait until no pin write is in flight.
	 *
	 * `refresh` reads every pin back out of the notes, so a write that has not landed
	 * yet is read as absent: the rescan builds new project objects, so the panel shows
	 * the rescanned rank while the write lands against an object the panel is no longer
	 * drawing. Settling first means no write is ever in flight across a rescan.
	 *
	 * Loops because a pin can be queued while the first batch is being awaited, and one
	 * snapshot would leave that write racing the scan.
	 *
	 * The exit condition is the entry count, and an entry is only removed by the write
	 * that owns it settling. Were entries never removed, the count would stay at one
	 * from the first pin onwards and this loop would re-arm on already-resolved
	 * promises without ever yielding to the task queue: timers never fire and `refresh`
	 * never reaches the scan. In a single-threaded renderer that is the whole
	 * application frozen, not a stuck panel.
	 */
	async settle(): Promise<void> {
		while (this.tails.size > 0) {
			await Promise.all([...this.tails.values()]);
		}
	}
}

/**
 * The one field a pin write touches. Structural rather than `Project`, so the tests
 * can drive the ordering and the rollback without building a project.
 */
export interface PinTarget {
	pin: number;
}

/** What a pin write is allowed to do to the outside world. */
export interface PinWriteHooks<T extends PinTarget> {
	/** Put the write to the note. Resolves false when it did not land. */
	save(target: T): Promise<boolean>;
	/** The panel changed, so redraw. Called before the write and again after a rollback. */
	onChange(): void;
}

/**
 * One pin write: draw it, write it, and put the row back if the write failed. Returns
 * whether the write landed; reporting that to the user is a `Notice`, which is
 * Obsidian's, so it stays with the caller.
 *
 * The rollback is safe because `PinQueue` only reaches this with the previous write for
 * the project already settled: `previous` is the rank the last write actually landed
 * rather than the one on screen when this was queued, and there is no newer write in
 * flight for it to overwrite.
 */
export async function applyPin<T extends PinTarget>(
	target: T,
	pin: number,
	hooks: PinWriteHooks<T>,
): Promise<boolean> {
	const previous = target.pin;
	target.pin = pin;
	hooks.onChange();
	if (await hooks.save(target)) return true;
	target.pin = previous;
	hooks.onChange();
	return false;
}