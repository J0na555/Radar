import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { applyPin, PinQueue } from "./pin-queue.ts";

/** A write the test can hold open, so the interleavings can be arranged by hand. */
interface Write {
	/** Settle this write, and wait for the queue to be done with it. */
	finish(succeeds: boolean): Promise<void>;
	/** True once the write has been asked to run at all. */
	started(): boolean;
	/** Rejects if the write throws, so `assert.rejects` can be pointed at it. */
	result(): Promise<void>;
}

/**
 * Queue a write for one project and hand back the levers.
 *
 * The gate is created before the write is queued, so `finish` is callable on the
 * handle straight away rather than having to wait for the write to start.
 */
function deferred(queue: PinQueue, name: string): Write {
	let release: (succeeds: boolean) => void = () => {};
	const gate = new Promise<boolean>((resolve) => {
		release = resolve;
	});
	let started = false;
	const result = queue.queue(name, async () => {
		started = true;
		await gate;
	});
	return {
		finish: async (succeeds) => {
			release(succeeds);
			await result;
			await tick();
		},
		started: () => started,
		result: () => result,
	};
}

/** One turn of the event loop, so queued microtasks and tail bookkeeping run. */
function tick(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
}

/**
 * Let microtasks run without ever awaiting the queue.
 *
 * The livelock is a promise that never resolves, and awaiting it is what turns a
 * regression into a hung test runner. This counts turns instead of waiting on it, so
 * a queue that forgets to clear its entries fails in milliseconds instead.
 */
async function pump(turns = 50): Promise<void> {
	for (let i = 0; i < turns; i++) await Promise.resolve();
}

describe("settle", () => {
	it("clears a project's entry when its own write settles", async () => {
		// The root cause of the livelock, checked without awaiting the queue so a
		// regression fails here first instead of hanging the runner. `settle`'s exit
		// condition is this count reaching zero, so an entry that outlives its write is
		// the bug, and a settle that cannot exit is only its symptom.
		const queue = new PinQueue();
		await queue.queue("api-ai", async () => {});
		await pump();
		assert.equal(queue.inFlight, 0, "the entry outlived the write that owned it");
	});

	// The timeout is the point of it. A livelock in here hangs forever, and a test
	// runner that hangs is worse than one that fails.
	it("returns once the last write finishes", { timeout: 5000 }, async () => {
		const queue = new PinQueue();
		const first = deferred(queue, "api-ai");
		const second = deferred(queue, "dashboard");
		assert.equal(queue.inFlight, 2);

		let settled = false;
		const waiting = queue.settle().then(() => {
			settled = true;
		});
		await tick();
		assert.equal(settled, false, "settle returned while writes were still in flight");

		await first.finish(true);
		await tick();
		assert.equal(settled, false, "settle returned with the second project's write open");

		await second.finish(true);
		await waiting;
		assert.equal(settled, true, "settle never returned after the last write landed");
		assert.equal(queue.inFlight, 0);
	});

	it("lets timers fire while it waits, instead of starving the event loop", { timeout: 5000 }, async () => {
		// The symptom, not the cause. Awaiting settled promises resolves in the
		// microtask queue, so a settle that cannot exit never yields to the task queue.
		// In Obsidian, a single-threaded renderer, that is the whole application
		// frozen: no timers, no click handling, no input.
		const queue = new PinQueue();
		deferred(queue, "api-ai").finish(true);
		let fired = false;
		setImmediate(() => {
			fired = true;
		});
		await queue.settle();
		await tick();
		assert.equal(fired, true, "a macrotask never ran across settle, so the loop was starved");
	});

	it("is a no-op, and returns at once, when nothing is queued", async () => {
		// A rescan with no pin in flight must not pay for the queue or wait on anything.
		const queue = new PinQueue();
		let settled = false;
		const waiting = queue.settle().then(() => {
			settled = true;
		});
		await tick();
		assert.equal(settled, true, "settle waited with an empty queue");
		await waiting;
		assert.equal(queue.inFlight, 0);
	});

	it("returns at once for a write that has already landed", async () => {
		// The shape the bug took in practice: press `p`, let it land, press `r`.
		const queue = new PinQueue();
		await queue.queue("api-ai", async () => {});
		let settled = false;
		void queue.settle().then(() => {
			settled = true;
		});
		await tick();
		assert.equal(settled, true, "settle hung on a write that had already landed");
		assert.equal(queue.inFlight, 0);
	});

	it("waits for a write queued while it is already waiting", async () => {
		// One snapshot would leave the second write racing the scan, which is the race
		// the queue is for. It returns when the user stops pinning.
		const queue = new PinQueue();
		const first = deferred(queue, "api-ai");
		let settled = false;
		const waiting = queue.settle().then(() => {
			settled = true;
		});
		await tick();

		// Queued mid-wait, the way a second `p` is.
		const second = deferred(queue, "api-ai");
		await first.finish(true);
		assert.equal(settled, false, "settle returned with the second write still open");

		await second.finish(true);
		await waiting;
		assert.equal(settled, true);
		assert.equal(queue.inFlight, 0);
	});
});

describe("ordering", () => {
	it("runs a second write after the first and still tracks it in the queue", { timeout: 5000 }, async () => {
		// The identity check in `queue`. When the first write's tail settles it removes
		// itself from the map, and by then the second write owns the entry. Removing it
		// unconditionally would drop the second write out of the queue: the third pin
		// would not wait for it and `settle` would not wait for it either, which is the
		// original race back again through the bookkeeping.
		const queue = new PinQueue();
		const first = deferred(queue, "api-ai");
		const second = deferred(queue, "api-ai");
		const third = deferred(queue, "api-ai");
		assert.equal(queue.inFlight, 1);

		await first.finish(true);
		assert.equal(second.started(), true, "the second write did not run after the first settled");
		assert.equal(queue.inFlight, 1, "the queue forgot the second write when the first settled");

		await tick();
		assert.equal(third.started(), false, "the third write ran before the second finished");

		await second.finish(true);
		assert.equal(third.started(), true, "the third write did not run after the second settled");
		assert.equal(queue.inFlight, 1, "the queue forgot the third write when the second settled");

		await third.finish(true);
		assert.equal(queue.inFlight, 0);
	});

	it("keeps writes for different projects off each other's way", async () => {
		// Nothing orders two projects against each other, and one slow note should not
		// hold up another project's row.
		const queue = new PinQueue();
		const a = deferred(queue, "api-ai");
		const b = deferred(queue, "dashboard");
		await tick();
		assert.equal(a.started(), true, "the first project did not start");
		assert.equal(b.started(), true, "the second project waited on the first");
		assert.equal(queue.inFlight, 2);

		await a.finish(true);
		await b.finish(true);
		assert.equal(queue.inFlight, 0);
	});

	it("does not let a failed write poison the queue", async () => {
		// The stored tail must never reject, or the next pin for that project queues
		// behind a promise that never settles and silently never runs.
		const queue = new PinQueue();
		const order: string[] = [];
		await assert.rejects(
			() =>
				queue.queue("api-ai", async () => {
					order.push("failed write");
					throw new Error("note is read-only");
				}),
			/read-only/,
		);
		await tick();
		assert.equal(queue.inFlight, 0, "a rejected write stayed in the queue");

		await queue.queue("api-ai", async () => {
			order.push("next write");
		});
		assert.deepEqual(order, ["failed write", "next write"]);
		await tick();
		assert.equal(queue.inFlight, 0);
	});
});

describe("two writes for one project", () => {
	/**
	 * Drive two writes at one project through the real queue and the real write, then
	 * report whether the panel and the note ended up saying the same thing.
	 *
	 * `succeeds` is what each write's save resolves to, in order. The panel's rank is
	 * the project object; the note's rank is what the fake vault stored.
	 */
	async function outcome(succeeds: [boolean, boolean]): Promise<{ panel: number; note: number }> {
		const queue = new PinQueue();
		const project = { pin: 0 };
		const note = { rank: 0 };
		let index = 0;
		const write = async (pin: number): Promise<void> => {
			await applyPin(project, pin, {
				save: async () => {
					const landed = succeeds[index++];
					// A successful save is what the note ends up saying. A failed one
					// leaves the note as it was, which is the disagreement to catch.
					if (landed) note.rank = project.pin;
					return landed;
				},
				onChange: () => {},
			});
		};

		// Both queued before either runs, so they interleave unless the queue stops it.
		const first = queue.queue("api-ai", () => write(1));
		const second = queue.queue("api-ai", () => write(2));
		await queue.settle();
		await Promise.all([first, second]);
		return { panel: project.pin, note: note.rank };
	}

	it("agrees when both writes land", async () => {
		// B lands last, so both sides must say 2.
		assert.deepEqual(await outcome([true, true]), { panel: 2, note: 2 });
	});

	it("agrees when the first write fails and the second lands", async () => {
		// A rolls back to 0, then B pins at 2. Anything else means B's write ran before
		// A's rollback finished, and the note ends up holding a rank the panel is not
		// showing.
		assert.deepEqual(await outcome([false, true]), { panel: 2, note: 2 });
	});

	it("agrees when the first write lands and the second fails", async () => {
		// B rolls back to whatever the last landed write left, which is A's 1. With the
		// two interleaved, the row went back to 0 while the note said 1.
		assert.deepEqual(await outcome([true, false]), { panel: 1, note: 1 });
	});

	it("agrees when both writes fail", async () => {
		// Two rollbacks, ending where the project started.
		assert.deepEqual(await outcome([false, false]), { panel: 0, note: 0 });
	});

	it("reads the target rank when the write runs, not when it was queued", async () => {
		// `p` pressed twice on an unpinned project, which is what the queue is for. The
		// target is a function because the second press has to read the rank the first
		// press left: unpinned -> top of the pinned group, pinned -> 0. Read at queue
		// time instead, the second press would compute its target from a project that
		// had not been pinned yet and would pin the row at the top again, so the second
		// press did nothing at all.
		const queue = new PinQueue();
		const project = { pin: 0 };
		const note = { rank: 0 };
		const topRank = 5;
		const written: number[] = [];
		const toggle = (): number => (project.pin > 0 ? 0 : topRank);
		const write = async (pin: number): Promise<void> => {
			await applyPin(project, pin, {
				save: async () => {
					written.push(project.pin);
					note.rank = project.pin;
					return true;
				},
				onChange: () => {},
			});
		};

		const first = queue.queue("api-ai", () => write(toggle()));
		const second = queue.queue("api-ai", () => write(toggle()));
		await queue.settle();
		await Promise.all([first, second]);

		assert.deepEqual(written, [5, 0], "the second press read its target too early");
		assert.deepEqual({ panel: project.pin, note: note.rank }, { panel: 0, note: 0 });
	});
});

describe("applyPin", () => {
	it("draws before the write and again after a rollback", async () => {
		// What the user sees either matches the note or says why it does not, which is
		// two draws on a failure.
		const target = { pin: 4 };
		const seen: number[] = [];
		const saved = await applyPin(target, 2, {
			save: async () => false,
			onChange: () => seen.push(target.pin),
		});
		assert.equal(saved, false);
		assert.deepEqual(seen, [2, 4], "drew the new pin, then drew the rollback");
		assert.equal(target.pin, 4);
	});

	it("leaves the pin alone on success and draws once", async () => {
		const target = { pin: 4 };
		const seen: number[] = [];
		const saved = await applyPin(target, 2, {
			save: async () => true,
			onChange: () => seen.push(target.pin),
		});
		assert.equal(saved, true);
		assert.deepEqual(seen, [2]);
		assert.equal(target.pin, 2);
	});

	it("hands the write the target itself, not a copy", async () => {
		// The vault writes the object it is given, so it has to be the one the panel is
		// drawing. A copy would leave the note written and the row unchanged.
		const target = { pin: 0 };
		let written: number | null = null;
		await applyPin(target, 9, {
			save: async (given) => {
				written = given.pin;
				return true;
			},
			onChange: () => {},
		});
		assert.equal(written, 9);
	});
});