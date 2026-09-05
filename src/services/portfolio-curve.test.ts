import { describe, expect, it } from "vitest";
import { equalWeightIndex } from "./portfolio-curve-service";

describe("the equal-weight benchmark", () => {
  /** A $10 stock doubling and a $1,000 stock halving average out to 1.25, not to the expensive one's move. */
  it("weights every member the same, whatever its price", () => {
    const idx = equalWeightIndex(
      [
        [10, 15, 20],
        [1000, 750, 500],
      ],
      3,
    );
    expect(idx).not.toBeNull();
    expect(idx!.members).toBe(2);
    expect(idx!.points[0]).toBe(1);
    expect(idx!.points[2]).toBeCloseTo(1.25, 10);
  });

  /** A feed with no history for the window, or a zero start, is left out rather than dragging the index to zero. */
  it("skips a series that cannot be normalised and says how many were counted", () => {
    const idx = equalWeightIndex([[100, 110], [0, 5], [50]], 2);
    expect(idx!.members).toBe(1);
    expect(idx!.points).toEqual([1, 1.1]);
    expect(equalWeightIndex([], 2)).toBeNull();
  });
});
