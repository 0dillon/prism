import { describe, expect, it } from "vitest";
import { mapWithConcurrency } from "@/lib/async";

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("mapWithConcurrency", () => {
  it("returns results in input order even when tasks finish out of order", async () => {
    const result = await mapWithConcurrency([30, 5, 20, 1], 4, async (ms, i) => {
      await delay(ms);
      return `${i}:${ms}`;
    });
    expect(result).toEqual(["0:30", "1:5", "2:20", "3:1"]);
  });

  it("never runs more than the limit at once", async () => {
    let running = 0;
    let peak = 0;
    await mapWithConcurrency(
      Array.from({ length: 20 }, (_, i) => i),
      4,
      async () => {
        running++;
        peak = Math.max(peak, running);
        await delay(3);
        running--;
      },
    );
    expect(peak).toBe(4);
  });

  it("uses fewer workers than the limit for fewer items", async () => {
    let peak = 0;
    let running = 0;
    await mapWithConcurrency([1, 2], 4, async () => {
      running++;
      peak = Math.max(peak, running);
      await delay(2);
      running--;
    });
    expect(peak).toBe(2);
  });

  it("handles an empty list", async () => {
    expect(await mapWithConcurrency([], 4, async () => 1)).toEqual([]);
  });

  it("rethrows the first error and stops starting new work", async () => {
    const started: number[] = [];
    await expect(
      mapWithConcurrency(
        Array.from({ length: 10 }, (_, i) => i),
        2,
        async (i) => {
          started.push(i);
          await delay(2);
          if (i === 1) throw new Error("boom");
          return i;
        },
      ),
    ).rejects.toThrow("boom");
    expect(started.length).toBeLessThan(10);
  });

  it.each([0, -1, 1.5, NaN])("rejects an invalid limit of %s", async (limit) => {
    await expect(mapWithConcurrency([1], limit, async (x) => x)).rejects.toThrow(
      /positive integer/,
    );
  });

  it("passes the index to the task", async () => {
    expect(await mapWithConcurrency(["a", "b"], 2, async (_, i) => i)).toEqual([0, 1]);
  });
});
