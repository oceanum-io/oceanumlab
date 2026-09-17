/**
 * An address typed into a setting, checked before anything uses it.
 *
 * A setting is typed in by hand, so anything that is not an http(s) URL falls
 * back to the default rather than ending up in an iframe's `src` or a
 * request's address.
 */

/** `value` as an http(s) URL, or `fallback` when it is empty or not one. */
export function validHttpUrl(
  value: string | null | undefined,
  fallback: string
): URL {
  try {
    const parsed = new URL((value ?? '').trim());
    if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
      return parsed;
    }
  } catch {
    // Empty or not a URL: the default below.
  }
  return new URL(fallback);
}
