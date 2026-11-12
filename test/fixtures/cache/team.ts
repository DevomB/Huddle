// Loads team.json: a cache.json as sync would leave it for a five-clone team.
//
// At NOW, alice (40s ago), bob (2m ago) and the viewer's second session
// (10s ago) are live; dave was last seen exactly ttlMinutes (15) ago, so he is
// not. One ref holds no valid doc, one holds a doc that names another actor,
// and one is not a huddle ref at all. bob's decision supersedes one of alice's.
// Tasks: one open, three claimed by live sessions, one claimed by dave, one done.

import { readFileSync } from "node:fs";
import type { ActorDoc, Cache, Session } from "../../../src/core/types.ts";

/** The clock the fixture is written for. */
export const NOW = new Date("2026-11-12T12:00:00.000Z");

/** The viewer: the first of two sessions in clone "selfself". */
export const ME = { actor: "selfself", session: "sess-me" };

/** A fresh copy on every call, so a test may edit it. */
export function loadTeam(): Cache {
  return JSON.parse(readFileSync(new URL("./team.json", import.meta.url), "utf8")) as Cache;
}

export function makeSession(overrides: Partial<Session> & { id: string }): Session {
  return {
    agent: "claude-code",
    branch: "main",
    intent: "",
    intentSource: "none",
    files: [],
    claims: [],
    startedAt: "2026-11-12T11:00:00.000Z",
    seenAt: "2026-11-12T11:59:00.000Z",
    ...overrides,
  };
}

/** A cache holding one actor doc per entry, each under its own ref. */
export function cacheOf(actors: Array<{ actor: string; user: string; sessions: Session[] }>): Cache {
  const cache: Cache = { fetchedAt: "2026-11-12T11:59:48.000Z", refs: {} };
  for (const { actor, user, sessions } of actors) {
    const doc: ActorDoc = { v: 0, kind: "actor", actor, user, host: `${user}-host`, updatedAt: "2026-11-12T11:59:00.000Z", sessions };
    cache.refs[`refs/huddle/actors/${actor}`] = { sha: "0".repeat(40), doc };
  }
  return cache;
}
