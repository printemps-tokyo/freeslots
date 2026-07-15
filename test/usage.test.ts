import { describe, expect, it } from "vitest";
import { parseArgs } from "node:util";
import { isParseArgsError, usageError } from "../src/usage.js";

describe("isParseArgsError", () => {
  it("recognizes a parseArgs unknown-option failure", () => {
    let caught: unknown;
    try {
      parseArgs({ args: ["--nope"], options: {} });
    } catch (err) {
      caught = err;
    }
    expect(isParseArgsError(caught)).toBe(true);
  });

  it("rejects ordinary errors", () => {
    expect(isParseArgsError(new Error("boom"))).toBe(false);
    expect(isParseArgsError("boom")).toBe(false);
  });
});

describe("usageError", () => {
  it("prints the message and a hint pointing at --help", () => {
    const out = usageError(new Error("Unknown option '--foo'"), "freeslots");
    expect(out).toContain("error: Unknown option '--foo'");
    expect(out).toContain("run 'freeslots --help' for usage.");
    expect(out.endsWith("\n")).toBe(true);
  });
});
