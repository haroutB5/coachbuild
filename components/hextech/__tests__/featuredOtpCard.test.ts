import { describe, expect, it } from "vitest";
import { featuredOtpRequestInputs } from "../featuredOtpRequest";

describe("featuredOtpRequestInputs", () => {
  it("changes the effect input when the champion key changes", () => {
    const first = featuredOtpRequestInputs({ id: 103, key: "Ahri" }, "16.14.1");
    const changedKey = featuredOtpRequestInputs({ id: 103, key: "AhriAlternate" }, "16.14.1");

    expect(first).toEqual({ champId: 103, champKey: "Ahri", ver: "16.14.1" });
    expect(changedKey).not.toEqual(first);
  });
});
