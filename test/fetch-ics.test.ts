import { describe, expect, it } from "vitest";
import { describeUrl, fetchIcs, fetchUrlFor, isCalendarUrl } from "../src/fetch-ics.js";

const SECRET =
  "https://calendar.google.com/calendar/ical/me%40example.com/private-0123456789abcdef/basic.ics";
const ICS = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR\r\n";

function fake(body: string | Uint8Array, init: ResponseInit = {}): { fn: typeof fetch; urls: string[] } {
  const urls: string[] = [];
  const fn = (async (url: string) => {
    urls.push(url);
    return new Response(body, init);
  }) as unknown as typeof fetch;
  return { fn, urls };
}

describe("calendar URLs", () => {
  it("tells URLs from files", () => {
    expect(isCalendarUrl(SECRET)).toBe(true);
    expect(isCalendarUrl("webcal://example.com/a.ics")).toBe(true);
    expect(isCalendarUrl("HTTP://example.com/a.ics")).toBe(true);
    expect(isCalendarUrl("./https.ics")).toBe(false);
    expect(isCalendarUrl("calendar.ics")).toBe(false);
  });

  it("fetches webcal as https", () => {
    expect(fetchUrlFor("webcal://example.com/a.ics")).toBe("https://example.com/a.ics");
  });

  it("never shows the path, where a private link keeps its secret", () => {
    expect(describeUrl(SECRET)).toBe("https://calendar.google.com/...");
    expect(describeUrl("not a url")).toBe("(a calendar URL)");
  });
});

describe("fetchIcs", () => {
  it("returns the calendar text", async () => {
    const f = fake(ICS, { headers: { "content-type": "text/calendar" } });
    expect(await fetchIcs("webcal://example.com/a.ics", { fetchFn: f.fn })).toBe(ICS);
    expect(f.urls).toEqual(["https://example.com/a.ics"]);
  });

  it("accepts a byte order mark", async () => {
    const f = fake(`${String.fromCharCode(0xfeff)}${ICS}`);
    await expect(fetchIcs(SECRET, { fetchFn: f.fn })).resolves.toContain("VCALENDAR");
  });

  it("explains an HTTP error without leaking the secret", async () => {
    const f = fake("nope", { status: 404 });
    const err = (await fetchIcs(SECRET, { fetchFn: f.fn }).catch((e: unknown) => e)) as Error;
    expect(err.message).toMatch(/^cannot fetch https:\/\/calendar\.google\.com\/\.\.\.: HTTP 404 \(for Google Calendar/);
    expect(err.message).not.toContain("private-0123");
  });

  it("rejects an HTML page served with 200", async () => {
    const f = fake("<!doctype html><title>Sign in</title>", { headers: { "content-type": "text/html" } });
    await expect(fetchIcs(SECRET, { fetchFn: f.fn })).rejects.toThrow(/did not return an iCalendar \(text\/html\)/);
  });

  it("stops at the size limit", async () => {
    const f = fake(ICS + "X".repeat(100));
    await expect(fetchIcs(SECRET, { fetchFn: f.fn, maxBytes: 64 })).rejects.toThrow(/larger than 64 bytes/);
  });

  it("reports a network failure by host", async () => {
    const fn = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    await expect(fetchIcs(SECRET, { fetchFn: fn })).rejects.toThrow(
      "cannot fetch https://calendar.google.com/...: fetch failed",
    );
  });
});
