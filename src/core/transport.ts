// T1.2. Documents to and from refs/huddle/* on the shared remote.
//
// The hard rules in plan.md §3 apply to every call made here. core/git.ts
// already covers prompting, timeouts, gc and optional locks when `network: true`
// is passed. This module is responsible for the rest:
//   - no local refs, no FETCH_HEAD, no index, no working tree: build the commit
//     with hash-object -w / mktree / commit-tree, list with ls-remote, fetch by
//     name with --no-write-fetch-head (and --no-tags, and an empty --refmap so
//     git does not opportunistically update tracking refs);
//   - push with --no-verify, so a user's pre-push hook never runs for huddle;
//   - fetched text goes through parseDoc(text, ref) from docs.ts and nowhere else.

import { todo } from "./io.ts";
import type { Doc, Expect, FetchResult, PublishResult, Ref, Sha, Transport } from "./types.ts";

export interface TransportOptions {
  /** Any directory inside the clone. */
  cwd: string;
  /** Name of the git remote (config.remote). */
  remote: string;
  /** Per network call. Defaults to the 10 s in core/git.ts. */
  timeoutMs?: number;
}

/**
 * publish: "own" force-updates, "absent" creates only if the ref is missing,
 * a Sha replaces only if the ref is still at that Sha. Lost compare-and-swap
 * is "lost-race"; unreachable remote or timeout is "offline"; the remote
 * refusing the push for any other reason is "denied".
 *
 * fetchAll: lists refs/huddle/*, fetches the docs whose sha differs from
 * `known`, and reports the refs in `known` that are gone. A ref whose content
 * does not parse is reported with doc: null.
 *
 * remove: deletes the ref only if it is still at `expect`.
 *
 * None of the three ever throws.
 */
export function createTransport(opts: TransportOptions): Transport {
  return {
    publish: (ref: Ref, doc: Doc, expect: Expect): Promise<PublishResult> => {
      void opts;
      void ref;
      void doc;
      void expect;
      return todo("transport.publish");
    },
    fetchAll: (known: Map<Ref, Sha>): Promise<FetchResult> => {
      void known;
      return todo("transport.fetchAll");
    },
    remove: (ref: Ref, expect: Sha): Promise<PublishResult> => {
      void ref;
      void expect;
      return todo("transport.remove");
    },
  };
}
