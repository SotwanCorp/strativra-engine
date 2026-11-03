import assert from "node:assert/strict";
import { test } from "node:test";
import { memQueue } from "./helpers.test-util.ts";

const input = (n = 1) => ({ url: `https://e${n}.com/`, emailHash: "e", ipHash: "i", domain: "d" });

test("enqueue, claim, complete", () => {
  const { queue } = memQueue();
  const { id, reportId } = queue.enqueue(input());
  assert.equal(queue.get(id)?.status, "queued");
  const job = queue.claim(2)!;
  assert.equal(job.id, id);
  assert.equal(job.status, "running");
  assert.equal(job.attempts, 1);
  assert.equal(queue.claim(2), undefined);
  queue.complete(id, { tokenHash: "h", expiresAt: Date.now() + 1000 });
  assert.equal(queue.get(id)?.status, "done");
  assert.equal(queue.reportByTokenHash("h")?.id, reportId);
});

test("claim respects concurrency and FIFO order", () => {
  const { queue } = memQueue();
  const ids = [1, 2, 3].map((n) => queue.enqueue(input(n)).id);
  assert.equal(queue.claim(2)?.id, ids[0]);
  assert.equal(queue.claim(2)?.id, ids[1]);
  assert.equal(queue.claim(2), undefined);
  queue.fail(ids[0], "boom");
  assert.equal(queue.get(ids[0])?.status, "failed");
  assert.equal(queue.claim(2)?.id, ids[2]);
});

test("crash recovery: requeue once, then fail", () => {
  let t = 1_000_000;
  const { queue } = memQueue(() => t);
  const { id } = queue.enqueue(input());
  queue.claim(2);
  t += 5 * 60_000;
  assert.deepEqual(queue.recover(), [0, 0]); // not stale yet
  t += 6 * 60_000;
  assert.deepEqual(queue.recover(), [1, 0]);
  assert.equal(queue.get(id)?.status, "queued");
  queue.claim(2);
  t += 11 * 60_000;
  assert.deepEqual(queue.recover(), [0, 1]);
  assert.equal(queue.get(id)?.status, "failed");
  assert.equal(queue.get(id)?.error, "worker_crashed");
});

test("finishing a job drops the transient encrypted email", () => {
  const { queue } = memQueue();
  const { id } = queue.enqueue({ ...input(), emailEnc: "secret" });
  queue.claim(2);
  queue.fail(id, "x");
  assert.equal(queue.get(id)?.email_enc, null);
});

test("position and depth", () => {
  const { queue } = memQueue();
  const a = queue.enqueue(input(1)).id;
  const b = queue.enqueue(input(2)).id;
  assert.equal(queue.depth(), 2);
  assert.equal(queue.position(queue.get(a)!), 0);
  assert.equal(queue.position(queue.get(b)!), 1);
});
