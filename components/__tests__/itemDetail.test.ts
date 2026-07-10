/**
 * Pure-logic tests for stripItemDescriptionHtml — the sanitizer that turns
 * ddragon's HTML-ish item description markup into plain readable text for
 * the item-detail popover. No JSX rendering, no network — plain function.
 */
import { describe, it, expect } from "vitest";
import { stripItemDescriptionHtml } from "../itemDetail";

describe("stripItemDescriptionHtml", () => {
  it("returns empty string for undefined/null/empty input", () => {
    expect(stripItemDescriptionHtml(undefined)).toBe("");
    expect(stripItemDescriptionHtml(null)).toBe("");
    expect(stripItemDescriptionHtml("")).toBe("");
  });

  it("converts <br> tags to newlines", () => {
    expect(stripItemDescriptionHtml("Line one<br>Line two")).toBe("Line one\nLine two");
    expect(stripItemDescriptionHtml("Line one<br/>Line two")).toBe("Line one\nLine two");
    expect(stripItemDescriptionHtml("Line one<br />Line two")).toBe("Line one\nLine two");
  });

  it("strips every other tag but keeps its text content", () => {
    const raw = "<mainText><stats><attention>40</attention> Attack Damage</stats></mainText>";
    expect(stripItemDescriptionHtml(raw)).toBe("40 Attack Damage");
  });

  it("strips real Blade of the Ruined King markup down to readable text with preserved line breaks", () => {
    const raw =
      "<mainText><stats><attention>40</attention> Attack Damage<br><attention>25%</attention> Attack Speed<br><attention>10%</attention> Life Steal</stats><br><br><passive>Mist's Edge</passive><br>Attacks deal <physicalDamage>a percentage</physicalDamage> of enemy's current Health as <physicalDamage>bonus physical damage</physicalDamage> <OnHit>On-Hit</OnHit>.<br><br><passive>Clawing Shadows</passive><br>Attacking a champion 3 times <status>Slows</status> them by 30% for 1 second.</mainText>";
    const out = stripItemDescriptionHtml(raw);
    expect(out).not.toMatch(/[<>]/);
    expect(out).toContain("40 Attack Damage");
    expect(out).toContain("25% Attack Speed");
    expect(out).toContain("Mist's Edge");
    expect(out).toContain("Slows");
  });

  it("unescapes the common HTML entities ddragon emits", () => {
    expect(stripItemDescriptionHtml("A&amp;B")).toBe("A&B");
    expect(stripItemDescriptionHtml("A&nbsp;B")).toBe("A B");
    expect(stripItemDescriptionHtml("&lt;tag&gt;")).toBe("<tag>");
  });

  it("collapses 3+ consecutive newlines down to a max of one blank line", () => {
    expect(stripItemDescriptionHtml("A<br><br><br><br>B")).toBe("A\n\nB");
  });

  it("trims leading/trailing whitespace", () => {
    expect(stripItemDescriptionHtml("<br>  Hello  <br>")).toBe("Hello");
  });
});
