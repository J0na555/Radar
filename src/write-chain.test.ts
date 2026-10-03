import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { WriteChain } from "./write-chain.ts";

/** A write the test can hold open, so the interleavings can be arranged by hand. */
interface Write {
	finish(succeeds: boolean): Promise<void>;
	started(): boolean;
	result(): Promise<void>;
}

function deferred(chain: WriteChain): Write {
	let release: (succeeds: boolean) => void = () => {};
	const gate = new Promise<boolean>((resolve) => {
		release = resolve;
	});
	let started = false;
	const result = chain.run(async () => {
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

function tick(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
}

/**
 * Let microtasks run without ever awaiting the chain.
 *
 * The failure this guards against is a promise that never resolves, and awaiting it turns a
 * regression into a hung test runner instead of a failed one.
 */
async function pump(turns = 50): Promise<void> {
	for (let i = 0; i < turns; i++) await Promise.resolve();
}

describe("WriteChain", () => {
	// The race this exists for: two pins for two different projects are written concurrently by
	// design, and each one serialises the whole settings file. Overlapping them can write a
	// snapshot taken before the other change landed, which loses one of the two.
	it("never runs two writes at the same time", async () => {
		const chain = new WriteChain();
		let running = 0;
		let maxRunning = 0;

		const write = () =>
			chain.run(async () => {
				running += 1;
				maxRunning = Math.max(maxRunning, running);
				await tick();
				running -= 1;
			});

		await Promise.all([write(), write(), write(), write()]);
		assert.equal(maxRunning, 1, "two settings writes overlapped");
		assert.equal(chain.pending, 0);
	});

	it("returns each write's own result, in order", async () => {
		const chain = new WriteChain();
		const order: number[] = [];

		const first = chain.run(async () => {
			await tick();
			order.push(1);
			return "first";
		});
		const second = chain.run(async () => {
			order.push(2);
			return "second";
		});

		assert.equal(await first, "first");
		assert.equal(await second, "second");
		assert.deepEqual(order, [1, 2]);
	});

	it("counts a queued write immediately, not when it runs", async () => {
		const chain = new WriteChain();
		const write = deferred(chain);
		assert.equal(chain.pending, 1);
		await write.finish(true);
		assert.equal(chain.pending, 0);
	});

	// A rejected tail would leave every later write queued behind a promise that never settles,
	// so they would silently never run and the settings file would stop changing for good. The
	// next save has to work even though the one before it failed.
	it("keeps running after a write throws", async () => {
		const chain = new WriteChain();
		await assert.rejects(
			chain.run(async () => {
				throw new Error("disk full");
			}),
		);
		assert.equal(await chain.run(async () => "still works"), "still works");
		assert.equal(chain.pending, 0);
	});

	it("settles once nothing is queued", async () => {
		const chain = new WriteChain();
		const first = deferred(chain);
		const second = deferred(chain);
		await tick();
		assert.equal(chain.pending, 2);

		let settled = false;
		const waiting = chain.settle().then(() => {
			settled = true;
		});

		await first.finish(true);
		await tick();
		assert.equal(settled, false, "settled with one write still in flight");
		await second.finish(true);
		await waiting;
		assert.equal(settled, true);
	});

	// The exit condition of `settle` is the count, and the count only falls when a write settles.
	// An entry that outlived its write would make `settle` re-arm on already-resolved promises
	// forever without ever yielding, which in a single-threaded renderer is the whole
	// application frozen rather than a stuck panel.
	it("clears its count when a write settles", async () => {
		const chain = new WriteChain();
		await chain.run(async () => {});
		await pump();
		assert.equal(chain.pending, 0, "the count outlived the write that owned it");
	});

	it("settles after a write that threw", async () => {
		const chain = new WriteChain();
		await assert.rejects(
			chain.run(async () => {
				throw new Error("nope");
			}),
		);
		await chain.settle();
		assert.equal(chain.pending, 0);
	});

	it("passes a write's value back to the caller that queued it", async () => {
		const chain = new WriteChain();
		const value = await chain.run(async () => ({ saved: true }));
		assert.deepEqual(value, { saved: true });
	});
});
