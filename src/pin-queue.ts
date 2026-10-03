/**
 * Pin writes in order, and the wait that keeps them out of a rescan's way.
 *
 * Out of `view.ts`, and that move is the fix rather than the tidying. The queue used
 * to live in the view, so only the view's own `refresh` could settle it, and the
 * plugin's `refresh` is also reached from the command palette's "Rescan projects". A
 * pin written while that rescan was running was read back before it landed, which is
 * the race the queue exists to prevent, still reachable through one of the two doors
 * into it. The queue now sits with the code that reads pins, so every rescan path
 * settles it by construction rather than by remembering to.
 *
 * No `obsidian` import, deliberately: `node --test` cannot load that package, so a
 * module that imports it is a module with no tests. Same reasoning as
 * `pin-menu-plan.ts`. Everything here is a promise and a `Map`.
 */

/**
 * The tail of each project's pin writes, by project name.
 *
 * One entry per project, not one per write, because writes for one project must not
 * interleave. `applyPin` puts a failed write's row back at the rank the previous
 * write left, which is only safe when nothing newer for that project is in flight.
 * Two writes for one project used to interleave, and the first one's rollback could
 * land after the second one succeeded: a pin at 1 opening while a pin at 2 was
 * already in flight, the 2 landed, the rollback put the row back at 0, and the note
 * said 2. Queued in order instead, every outcome leaves the panel and the note
 * saying the same thing, including both writes failing.
 *
 * Writes for *different* projects still run concurrently. There is nothing to order
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
	 * `write` runs later, so anything it reads is read when it runs rather than when
	 * it was queued: a `p` pressed twice has to read the rank the first press left,
	 * not the one that was on screen when the second key went down.
	 *
	 * Returns a promise for *this* write, which rejects if the write throws. The
	 * stored tail never rejects: a rejected tail would leave the next pin for this
	 * project queued behind a promise that never settles, so it would silently never
	 * run. Callers report their own failures.
	 */
	queue(name: string, write: () => Promise<void>): Promise<void> {
		const previous = this.tails.get(name) ?? Promise.resolve();
		const queued = previous.then(write);
		const tail = queued.catch(() => {});
		this.tails.set(name, tail);
		void tail.then(() => {
			// Identity, not an unconditional delete. By the time this write settles, a
			// newer one for the same project may already own the entry, and deleting it
			// then would drop the newer write out of the queue: the next pin for this
			// project would not wait for it, and `settle` would stop waiting for it too.
			// That is the race this queue exists to prevent, reintroduced through its
			// own bookkeeping. The test "runs a second write after the first and still
			// tracks it in the queue" is this line, and it fails without the comparison.
			if (this.tails.get(name) === tail) this.tails.delete(name);
		});
		return queued;
	}

	/**
	 * Wait until no pin write is in flight.
	 *
	 * `refresh` reads every pin back out of the notes, so a write that has not landed
	 * yet is read as absent: the rescan builds new project objects, so the panel
	 * shows the rescanned rank while the write then lands against an object the panel
	 * is no longer drawing. Settling first means no write is ever in flight across a
	 * rescan, whichever of the two paths started it.
	 *
	 * Loops because a pin can be queued while the first batch is being awaited, and
	 * one snapshot would leave that write racing the scan. It returns as soon as the
	 * user stops pinning; holding `p` down keeps the rescan waiting, which is the
	 * right way round.
	 *
	 * The exit condition is the entry count, and an entry is only removed by the
	 * write that owns it settling. An earlier version never removed anything, so the
	 * count stayed at one from the first pin onwards and this loop re-armed itself on
	 * already-resolved promises forever: awaiting settled promises resolves in the
	 * microtask queue, so the loop never yields to the task queue, timers never fire,
	 * and `refresh` never got as far as the scan. In a single-threaded renderer that
	 * is the whole application frozen, not a stuck panel.
	 */
	async settle(): Promise<void> {
		while (this.tails.size > 0) {
			await Promise.all([...this.tails.values()]);
		}
	}
}

/**
 * The one field a pin write touches.
 *
 * Structural rather than `Project`, so the tests can drive the ordering and the
 * rollback without building a project. `Project` satisfies it unchanged.
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
 * One pin write: draw it, write it, and put the row back if the write failed.
 *
 * Returns whether the write landed. Reporting that to the user is a `Notice`, which
 * is Obsidian's, so it stays with the caller.
 *
 * The rollback is safe because `PinQueue` only reaches this with the previous write
 * for the project already settled: `previous` is the rank the last write actually
 * landed rather than the rank that happened to be on screen when this one was
 * queued, and there is no newer write in flight for it to overwrite.
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