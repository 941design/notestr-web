import { describe, expect, it } from "vitest";
import { normalizeBasePath } from "./base-path";

describe("normalizeBasePath", () => {
  it("returns an empty string when unset", () => {
    expect(normalizeBasePath(undefined)).toBe("");
  });

  it("returns an empty string for root", () => {
    expect(normalizeBasePath("/")).toBe("");
  });

  it("adds a leading slash when missing", () => {
    expect(normalizeBasePath("notestr")).toBe("/notestr");
  });

  it("removes trailing slashes", () => {
    expect(normalizeBasePath("/notestr/")).toBe("/notestr");
  });
});

