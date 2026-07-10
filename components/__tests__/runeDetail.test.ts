/**
 * Pure-logic tests for stripRuneDescriptionHtml — the sanitizer that turns
 * CommunityDragon's perks.json tooltip markup into plain readable text for
 * the rune-detail popover. No JSX rendering, no network — plain function.
 * Fixtures below are lifted verbatim from a live perks.json fetch
 * (2026-07-10) so the tests exercise real tag shapes, not guessed ones.
 */
import { describe, it, expect } from "vitest";
import { stripRuneDescriptionHtml } from "../runeDetail";

describe("stripRuneDescriptionHtml", () => {
  it("returns empty string for undefined/null/empty input", () => {
    expect(stripRuneDescriptionHtml(undefined)).toBe("");
    expect(stripRuneDescriptionHtml(null)).toBe("");
    expect(stripRuneDescriptionHtml("")).toBe("");
  });

  it("converts <br> tags to newlines", () => {
    expect(stripRuneDescriptionHtml("Line one<br>Line two")).toBe("Line one\nLine two");
    expect(stripRuneDescriptionHtml("Line one<br/>Line two")).toBe("Line one\nLine two");
    expect(stripRuneDescriptionHtml("Line one<br />Line two")).toBe("Line one\nLine two");
  });

  it("keeps real numeric values from Unflinching's longDesc (the placeholder-free case this migration exists for)", () => {
    const raw = "Gain 10 Armor and Magic Resist when crowd controlled and for 2 seconds after.";
    const out = stripRuneDescriptionHtml(raw);
    expect(out).toBe("Gain 10 Armor and Magic Resist when crowd controlled and for 2 seconds after.");
    expect(out).toMatch(/\d/);
  });

  it("strips <lol-uikit-tooltipped-keyword>, <font color=...>, and other real perks.json tags but keeps their text", () => {
    const raw =
      "Hitting a champion with 3 <b>separate</b> attacks or abilities within 3s deals bonus <lol-uikit-tooltipped-keyword key='LinkTooltip_Description_AdaptiveDmg'><font color='#48C4B7'>adaptive damage</font></lol-uikit-tooltipped-keyword>.<br><br>Damage: 70 - 240 (+0.1 bonus AD, +0.05 AP) damage.<br>Cooldown: 20s";
    const out = stripRuneDescriptionHtml(raw);
    expect(out).not.toMatch(/[<>]/);
    expect(out).toContain("separate");
    expect(out).toContain("adaptive damage");
    expect(out).toContain("Damage: 70 - 240 (+0.1 bonus AD, +0.05 AP) damage.");
    expect(out).toContain("Cooldown: 20s");
  });

  it("turns <li> list items (Grasp of the Undying's longDesc) into their own bulleted lines", () => {
    const raw =
      "Every 4s in combat, your next basic attack on a champion will:<li>Deal bonus magic damage equal to 3.5% of your max health<li>Heal you for 1.3% of your max health<li>Permanently increase your health by 5<br><rules><i>Ranged Champions:</i> Damage, healing, and permanent health gained are 40% effective.</rules>";
    const out = stripRuneDescriptionHtml(raw);
    expect(out).not.toMatch(/[<>]/);
    const lines = out.split("\n");
    expect(lines).toContain("• Deal bonus magic damage equal to 3.5% of your max health");
    expect(lines).toContain("• Heal you for 1.3% of your max health");
    expect(lines).toContain("• Permanently increase your health by 5");
    expect(out).toContain("Ranged Champions:");
  });

  it("converts <hr> (flavor-quote divider, e.g. Triumph/Celestial Body) to a newline break", () => {
    const raw = "Takedowns restore 5% of your missing health.<br><br><hr><br><i>'Flavor quote.'</i>";
    const out = stripRuneDescriptionHtml(raw);
    expect(out).not.toMatch(/[<>]/);
    expect(out).toContain("Takedowns restore 5% of your missing health.");
    expect(out).toContain("Flavor quote.");
  });

  it("replaces a leftover @Variable@ placeholder with an ellipsis while keeping the rest of the real text (Unsealed Spellbook)", () => {
    const raw =
      "Each unique Summoner Spell you swap to permanently decreases your swap cooldown by 25s (initial swap cooldown is @f3@ seconds).";
    const out = stripRuneDescriptionHtml(raw);
    expect(out).not.toContain("@f3@");
    expect(out).toContain("…");
    expect(out).toContain("25s");
  });

  it("unescapes the common HTML entities perks.json could emit", () => {
    expect(stripRuneDescriptionHtml("A&amp;B")).toBe("A&B");
    expect(stripRuneDescriptionHtml("A&nbsp;B")).toBe("A B");
    expect(stripRuneDescriptionHtml("&lt;tag&gt;")).toBe("<tag>");
  });

  it("collapses 3+ consecutive newlines down to a max of one blank line", () => {
    expect(stripRuneDescriptionHtml("A<br><br><br><br>B")).toBe("A\n\nB");
  });

  it("trims leading/trailing whitespace", () => {
    expect(stripRuneDescriptionHtml("<br>  Hello  <br>")).toBe("Hello");
  });
});
