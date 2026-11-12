// T1.3. Glob matching for claims. Pure.
//
//   *   any run of characters except "/"
//   **  any run of characters including "/" ("**/" also matches zero directories)
//   ?   one character except "/"
// Everything else is literal. Paths are repo-relative with forward slashes.

import { todo } from "./io.ts";

export function globToRegExp(pattern: string): RegExp {
  void pattern;
  return todo("glob.globToRegExp");
}

export function globMatch(pattern: string, path: string): boolean {
  void pattern;
  void path;
  return todo("glob.globMatch");
}
