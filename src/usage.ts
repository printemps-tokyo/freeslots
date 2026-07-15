/**
 * Helpers for turning an argument-parsing failure into a clean, actionable
 * message. `parseArgs` throws on unknown or malformed options with a terse
 * message and no guidance; these helpers add a pointer to the relevant --help.
 */

/** parseArgs tags its errors with a `code` like ERR_PARSE_ARGS_UNKNOWN_OPTION. */
export function isParseArgsError(err: unknown): err is Error {
  if (!(err instanceof Error)) return false;
  const code = (err as Error & { code?: unknown }).code;
  return typeof code === "string" && code.startsWith("ERR_PARSE_ARGS");
}

/**
 * Format a parse failure as two lines: the original message and a hint that
 * points at the given command's help (e.g. "cronpeek" or "vshrink shrink").
 */
export function usageError(err: unknown, helpTarget: string): string {
  const message = err instanceof Error ? err.message : String(err);
  return `error: ${message}\nrun '${helpTarget} --help' for usage.\n`;
}
