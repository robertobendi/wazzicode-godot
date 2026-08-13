import { describe, expect, it, vi } from "vitest";
import { settleTaskQueue } from "./taskQueue";

describe("task queue settlement", () => {
  it("persists a completed task before advancing", async () => {
    const order: string[] = [];

    await settleTaskQueue({
      outcome: "completed",
      persist: async () => {
        order.push("persist");
      },
      advance: async () => {
        order.push("advance");
        return true;
      },
      pause: vi.fn(),
    });

    expect(order).toEqual(["persist", "advance"]);
  });

  it.each(["failed", "stopped"] as const)(
    "preserves and pauses the queue after a %s task",
    async (outcome) => {
      const advance = vi.fn().mockResolvedValue(true);
      const pause = vi.fn();

      await settleTaskQueue({ outcome, advance, pause });

      expect(advance).not.toHaveBeenCalled();
      expect(pause).toHaveBeenCalledOnce();
      expect(pause.mock.calls[0][0]).toMatch(
        outcome === "stopped" ? /stopped/i : /review the error/i,
      );
    },
  );

  it("still persists an agent-reported failure before pausing", async () => {
    const order: string[] = [];

    await settleTaskQueue({
      outcome: "failed",
      persist: async () => {
        order.push("persist");
      },
      advance: async () => {
        order.push("advance");
        return true;
      },
      pause: () => order.push("pause"),
    });

    expect(order).toEqual(["persist", "pause"]);
  });
});
