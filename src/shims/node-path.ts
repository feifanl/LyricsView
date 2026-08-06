/**
 * Browser stand-in for Node's `path`, aliased in vite.config.ts.
 *
 * kuromoji's dictionary loader does `require("path")` and calls `path.join` to
 * build the URL of each dictionary file. Vite externalizes Node builtins for the
 * browser, which leaves `path` as a stub that throws `path.join is not a
 * function` — so kuroshiro never initializes and Japanese romaji and furigana
 * both fail silently, caught by the loader's own try/catch.
 *
 * Only `join` is needed, and only ever on URL paths. This is not a general
 * `path` polyfill: no drive letters, no `..` resolution, no Windows separators.
 * Anything else that reaches for `path` in the browser should get a proper
 * polyfill rather than an extension of this.
 */
export function join(...parts: string[]): string {
  const joined = parts.filter((p) => p.length > 0).join("/");
  // Collapse the doubled separators that come from joining "/dir" with "file",
  // while leaving a leading "//" (protocol-relative URL) alone.
  return joined.replace(/(?<!^)\/{2,}/g, "/");
}

export default { join };
