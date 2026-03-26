import { describe, it, expect } from "vitest";
import { MessageQueue } from "./message-queue.js";

describe("MessageQueue", () => {
  it("executes tasks sequentially per thread", async () => {
    const queue = new MessageQueue();
    const order: string[] = [];

    const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

    queue.enqueue("thread_1", async () => {
      await delay(50);
      order.push("A");
    });

    queue.enqueue("thread_1", async () => {
      order.push("B");
    });

    await queue.enqueue("thread_1", async () => {
      order.push("C");
    });

    expect(order).toEqual(["A", "B", "C"]);
  });

  it("executes different threads concurrently", async () => {
    const queue = new MessageQueue();
    const order: string[] = [];

    const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

    const p1 = queue.enqueue("thread_1", async () => {
      await delay(50);
      order.push("thread_1");
    });

    const p2 = queue.enqueue("thread_2", async () => {
      order.push("thread_2");
    });

    await Promise.all([p1, p2]);

    expect(order).toEqual(["thread_2", "thread_1"]);
  });

  it("continues queue after error", async () => {
    const queue = new MessageQueue();
    const errors: Error[] = [];
    const results: string[] = [];

    queue.enqueue(
      "thread_1",
      async () => { throw new Error("boom"); },
      (err) => errors.push(err)
    );

    await queue.enqueue("thread_1", async () => {
      results.push("after_error");
    });

    expect(errors).toHaveLength(1);
    expect(errors[0].message).toBe("boom");
    expect(results).toEqual(["after_error"]);
  });
});
