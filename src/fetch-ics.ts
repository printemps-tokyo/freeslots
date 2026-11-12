/**
 * Reading a calendar from a URL: a published or "secret address in iCal
 * format" link from Google Calendar, or any other .ics feed. The only
 * network access freeslots makes, and only when it is given a URL.
 */

/** Whether a command-line input names a calendar URL rather than a file. */
export function isCalendarUrl(input: string): boolean {
  return /^(https?|webcal):\/\//i.test(input);
}

/** The URL to fetch: webcal:// is the https feed under another name. */
export function fetchUrlFor(input: string): string {
  return input.replace(/^webcal:\/\//i, "https://");
}

/**
 * A URL as shown in messages: scheme and host only. Private calendar links
 * carry their secret in the path, so the path is never printed.
 */
export function describeUrl(input: string): string {
  try {
    const u = new URL(fetchUrlFor(input));
    return `${u.protocol}//${u.host}/...`;
  } catch {
    return "(a calendar URL)";
  }
}

export const DEFAULT_TIMEOUT_MS = 30_000;
/** Calendars are text; a feed larger than this is not one we should parse. */
export const MAX_BYTES = 20 * 1024 * 1024;

export interface FetchIcsOptions {
  fetchFn?: typeof fetch;
  timeoutMs?: number;
  maxBytes?: number;
}

/** Download an .ics feed. Throws with a message that names the host only. */
export async function fetchIcs(input: string, opts: FetchIcsOptions = {}): Promise<string> {
  const fetchFn = opts.fetchFn ?? fetch;
  const maxBytes = opts.maxBytes ?? MAX_BYTES;
  const where = describeUrl(input);
  let res: Response;
  try {
    res = await fetchFn(fetchUrlFor(input), {
      headers: { accept: "text/calendar, text/plain;q=0.5, */*;q=0.1" },
      redirect: "follow",
      signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
  } catch (err) {
    const why = (err as Error).name === "TimeoutError" ? "timed out" : (err as Error).message;
    throw new Error(`cannot fetch ${where}: ${why}`, { cause: err });
  }
  if (!res.ok) {
    const hint =
      res.status === 404 || res.status === 403
        ? " (for Google Calendar, use the calendar's public address or its secret address in iCal format)"
        : "";
    throw new Error(`cannot fetch ${where}: HTTP ${res.status}${hint}`);
  }

  const length = Number(res.headers.get("content-length"));
  if (Number.isFinite(length) && length > maxBytes) {
    throw new Error(`${where} is larger than ${maxBytes} bytes`);
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  if (res.body) {
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error(`${where} is larger than ${maxBytes} bytes`);
      }
      chunks.push(value);
    }
  }
  const text = new TextDecoder("utf-8").decode(Buffer.concat(chunks));
  // A login or error page comes back as HTML with status 200.
  if (!/^\uFEFF?\s*BEGIN:VCALENDAR/i.test(text)) {
    const type = res.headers.get("content-type") ?? "no content type";
    throw new Error(`${where} did not return an iCalendar (${type})`);
  }
  return text;
}
