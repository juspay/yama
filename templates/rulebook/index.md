# Review rulebook

This file is read FIRST by every Yama run, and everything it links to is read after it.
Keep it short and keep it true: a rule nobody follows teaches the reviewer to distrust
the rest of this directory.

## How this repository wants to be reviewed

_Describe the posture in a sentence or two. "Sceptical about anything touching auth,
relaxed about formatting" is more useful than "review carefully"._

## Rules

Each rule gets an id, a statement a reviewer can actually check, and — where it matters —
a severity. Findings cite these ids as evidence.

- `no-secrets-in-logs` — Never log a token, key, password or session id, at any level.
  Severity: CRITICAL.
- `test-new-behaviour` — New behaviour ships with a test that would fail without it.
  Severity: MAJOR.

## What this rulebook does NOT cover

_List the gaps. A reviewer told where the rulebook is silent will say so instead of
inventing a house style._
