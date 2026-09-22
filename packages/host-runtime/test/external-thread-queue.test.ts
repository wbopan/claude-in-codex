import { describe, expect, it } from "vitest";

import { ExternalQueueError, ExternalThreadQueue } from "../src/external-thread-queue.js";

function text(value: string) {
  return { type: "text", text: value };
}

function add(queue: ExternalThreadQueue, threadId: string, value: string, clientId = value) {
  return queue.add(threadId, { input: [text(value)], clientUserMessageId: clientId });
}

describe("External Thread message queue", () => {
  it("keeps submissions per Thread in insertion order and echoes their identity", () => {
    const queue = new ExternalThreadQueue();
    const first = add(queue, "a", "first", "client-1");
    const second = add(queue, "a", "second", "client-2");
    add(queue, "b", "other");
    expect(first.id).not.toBe(second.id);
    expect(queue.size("a")).toBe(2);
    expect(queue.list("a", {})).toEqual({
      data: [
        { id: first.id, input: [text("first")], clientUserMessageId: "client-1" },
        { id: second.id, input: [text("second")], clientUserMessageId: "client-2" },
      ],
      nextCursor: null,
    });
    expect(queue.take("a")?.text).toBe("first");
    expect(queue.take("a", second.id)?.text).toBe("second");
    expect(queue.take("a")).toBeUndefined();
    expect(queue.size("b")).toBe(1);
  });

  it("rejects submissions without text or identity and bounds the queue", () => {
    const queue = new ExternalThreadQueue(2);
    expect(() => queue.add("a", { input: [text("x")] })).toThrow(ExternalQueueError);
    expect(() => queue.add("a", { input: [], clientUserMessageId: "c" })).toThrow(
      "Queued submissions require input",
    );
    expect(() =>
      queue.add("a", { input: [{ type: "image", url: "data:" }], clientUserMessageId: "c" }),
    ).toThrow("Queued submissions require text input");
    expect(() => queue.add("a", { input: [text("   ")], clientUserMessageId: "c" })).toThrow(
      "Queued submissions require text input",
    );
    add(queue, "a", "1");
    add(queue, "a", "2");
    expect(() => add(queue, "a", "3")).toThrow("External Thread message queue is full");
  });

  it("paginates with an offset cursor", () => {
    const queue = new ExternalThreadQueue();
    for (const value of ["1", "2", "3"]) add(queue, "a", value);
    const first = queue.list("a", { limit: 2 });
    expect(first.data.map((entry) => entry.clientUserMessageId)).toEqual(["1", "2"]);
    expect(first.nextCursor).toBe("2");
    const second = queue.list("a", { cursor: first.nextCursor, limit: 2 });
    expect(second.data.map((entry) => entry.clientUserMessageId)).toEqual(["3"]);
    expect(second.nextCursor).toBeNull();
    expect(() => queue.list("a", { cursor: "later" })).toThrow("cursor is invalid");
    expect(() => queue.list("a", { limit: -1 })).toThrow("non-negative integer");
  });

  it("updates, deletes and reorders by submission id", () => {
    const queue = new ExternalThreadQueue();
    const first = add(queue, "a", "first");
    const second = add(queue, "a", "second");
    const updated = queue.update("a", { queuedSubmissionId: first.id, input: [text("edited")] });
    expect(updated.id).toBe(first.id);
    expect(updated.text).toBe("edited");
    expect(updated.clientUserMessageId).toBe("first");
    expect(() => queue.update("a", { queuedSubmissionId: "missing", input: [text("x")] })).toThrow(
      "queued submission not found",
    );
    expect(() => queue.reorder("a", [first.id])).toThrow(
      "queue reorder must include every queued submission exactly once",
    );
    expect(() => queue.reorder("a", [first.id, first.id])).toThrow(ExternalQueueError);
    queue.reorder("a", [second.id, first.id]);
    expect(queue.list("a", {}).data.map((entry) => entry.id)).toEqual([second.id, first.id]);
    expect(queue.delete("a", second.id)).toBe(true);
    expect(queue.delete("a", second.id)).toBe(false);
    expect(() => queue.delete("a", 5)).toThrow("require queuedSubmissionId");
    expect(() => queue.take("a", "missing")).toThrow("queued submission not found");
    queue.restore("a", second);
    expect(queue.list("a", {}).data.map((entry) => entry.id)).toEqual([second.id, first.id]);
    queue.clear("a");
    expect(queue.size("a")).toBe(0);
    expect(() => queue.take("a", second.id)).toThrow("queued submission not found");
  });
});
