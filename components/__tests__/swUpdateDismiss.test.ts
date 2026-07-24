import { describe, expect, it } from "vitest";
import { isUpdateDismissed } from "../swUpdateDismiss";

describe("isUpdateDismissed", () => {
  it("is not dismissed when there is no waiting worker at all", () => {
    expect(isUpdateDismissed(null, null)).toBe(false);
    expect(isUpdateDismissed("/sw.js?v=0.51.0", null)).toBe(false);
  });

  it("is not dismissed when nothing has ever been dismissed", () => {
    expect(isUpdateDismissed(null, "/sw.js?v=0.51.1")).toBe(false);
  });

  it("is dismissed when the stored version exactly matches the waiting worker", () => {
    expect(isUpdateDismissed("/sw.js?v=0.51.1", "/sw.js?v=0.51.1")).toBe(true);
  });

  it("re-surfaces once a genuinely different (newer) version is waiting", () => {
    // The core bug-fix case: dismissing v0.51.1 must never silence v0.51.2.
    expect(isUpdateDismissed("/sw.js?v=0.51.1", "/sw.js?v=0.51.2")).toBe(false);
  });
});
