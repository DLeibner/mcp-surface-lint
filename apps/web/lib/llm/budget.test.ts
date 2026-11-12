import { describe, expect, it } from "vitest";
import { budgetState, charge, cycleWindow, gate } from "./budget";

const iso = (date: Date) => date.toISOString().slice(0, 10);

describe("cycleWindow", () => {
  it("runs from the anchor day to the next one", () => {
    const window = cycleWindow(new Date("2026-10-16T12:00:00Z"), 1);
    expect(iso(window.start)).toBe("2026-10-01");
    expect(iso(window.end)).toBe("2026-11-01");
    expect(window.day).toBe(16);
    expect(window.days).toBe(31);
  });

  it("starts in the previous month before the anchor day", () => {
    const window = cycleWindow(new Date("2026-10-16T12:00:00Z"), 20);
    expect(iso(window.start)).toBe("2026-09-20");
    expect(iso(window.end)).toBe("2026-10-20");
    expect(window.day).toBe(27);
  });

  it("clamps an anchor past the month's end and crosses the year", () => {
    expect(iso(cycleWindow(new Date("2026-02-28T00:00:00Z"), 31).start)).toBe("2026-02-28");
    const january = cycleWindow(new Date("2026-01-05T00:00:00Z"), 17);
    expect(iso(january.start)).toBe("2025-12-17");
    expect(iso(january.end)).toBe("2026-01-17");
  });
});

describe("gate", () => {
  const now = new Date("2026-10-16T12:00:00Z");

  it("runs everything under the soft stop", () => {
    const state = budgetState({ now, spentUsd: 50, pendingUsd: 10 });
    expect(gate(state, "directory", 1).allowed).toBe(true);
  });

  it("keeps only protected tiers between the soft and the hard stop", () => {
    const state = budgetState({ now, spentUsd: 88, pendingUsd: 2.5 });
    expect(state.level).toBe("soft-stop");
    expect(gate(state, "directory", 0.1).allowed).toBe(false);
    expect(gate(state, "claimed", 0.1).allowed).toBe(false);
    expect(gate(state, "paid", 0.1).allowed).toBe(true);
    expect(gate(state, "showcase", 0.1).allowed).toBe(true);
  });

  it("counts the job's own estimate, so a job cannot cross a stop", () => {
    const state = budgetState({ now, spentUsd: 89.95, pendingUsd: 0 });
    expect(gate(state, "directory", 0.01).allowed).toBe(true);
    expect(gate(state, "directory", 0.1).allowed).toBe(false);
    expect(gate(state, "showcase", 5.5).allowed).toBe(false);
  });

  it("defers everything past the hard stop or once the credit is gone", () => {
    expect(gate(budgetState({ now, spentUsd: 95, pendingUsd: 0 }), "showcase", 0).allowed).toBe(false);
    const exhausted = budgetState({ now, spentUsd: 3, pendingUsd: 0, exhausted: true });
    expect(gate(exhausted, "showcase", 0).allowed).toBe(false);
  });

  it("sees each job's cost once it is charged", () => {
    let state = budgetState({ now, spentUsd: 89.5, pendingUsd: 0 });
    state = charge(state, 0.3);
    state = charge(state, 0.3, true);
    expect(state.spentUsd).toBe(89.8);
    expect(state.pendingUsd).toBe(0.3);
    expect(state.level).toBe("soft-stop");
  });
});

describe("budgetState", () => {
  it("projects the cycle's run rate to its last day", () => {
    const state = budgetState({ now: new Date("2026-10-11T00:00:00Z"), spentUsd: 20, pendingUsd: 0 });
    // Ten days elapsed in a 31-day cycle.
    expect(state.projectedUsd).toBe(62);
  });
});
