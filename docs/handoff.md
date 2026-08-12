# skoleintra-ha-bridge — Handoff Status

> **Privacy note:** placeholders only in this file (`<school>`, `<username>`,
> `Child A`). Real values live in `options.json` and `tmp/.env`, both gitignored.

Full technical spec: `skoleintra-ha-bridge.md` in this folder. Read this first
for "where we actually are", then the spec for architecture and reasoning.

## What this project is

A Home Assistant App that pulls homework from SkoleIntra (ForældreIntra) for two
children and syncs it into per-child HA `todo` lists — checkable, with due
dates, updated when a teacher edits an entry, with an audit trail.

## Where we are

The SkoleIntra half is **built and verified against the live account**. The
Home Assistant half is **written but entirely unverified**, because no HA
instance has been reachable from the dev machine yet.

```bash
npm test          # 25 tests: reconciler + Lektiebog parser
npm run dry-run   # fetches real homework, writes nothing anywhere
```

## Settled — do not re-derive these

1. **The original data source was wrong.** The `skoleintra` package scrapes the
   **Ugeplaner** module, which this school has never published to — the site
   states "Der er ingen ugeplaner for `<class>` i skoleåret `<year>`", and a
   sweep of a full term returned zero lessons for both children. Every request
   was succeeding and correctly returning an empty plan. That is what made this
   look broken for so long.

2. **Homework lives in the Lektiebog tab**, a diary with a numeric id per class,
   at `…item/weeklyplansandhomework/diary/notes/{diaryId}`. One request returns
   a period of days. The package has no method for it, so it is used for
   **login only**.

3. **One login covers both children**, and switching between them by URL path
   works on a single session with no re-login and no session pinning. Verified
   by reading `SelectedPlan.ClassOrGroup` back per child — each returns their
   own class. Assert on that field, not on homework text: text can't distinguish
   "the switch worked" from "we got a fallback page that parsed as empty".

4. **There is no separator before `item` in the path.** `parent/{childId}/{name}`
   is followed directly by `item/weeklyplansandhomework/...`. It looks malformed
   and is correct — the site's own menu emits it. Adding the "missing" slash
   returns a hard 404. This was hypothesised as a library bug and disproved by
   testing it.

5. **Child paths are real ids, not indices** — `parent/{realId}/{realName}`,
   captured from the browser per child. Not derivable.

6. **Session reuse works and is worth keeping.** After one login, every
   subsequent run reused the cookie string with no re-auth. No
   automation-protection block was seen across roughly 45 requests, so that
   concern looks overstated — though that is not a long-run sample.

7. **`skoleintra` is CommonJS.** Importing it from ESM needs
   `SkoleIntraModule.default ?? SkoleIntraModule`, or `new SkoleIntra(...)`
   fails with "is not a constructor".

8. **The package's week-number calculation is not ISO 8601** —
   `ceil(days-since-Jan-1 / 7)`, which drifts from the real ISO week. A
   correction was written and verified across a full year (correct on 358/365
   days; fails only in the week-53 window at the ISO year boundary). **It is now
   moot**, since the bridge no longer calls `getWeeklyPlan()`. Kept in the git
   history in case Ugeplaner is ever used.

## What's built

```
src/skoleintra.js   login (via the package) + Lektiebog fetch and parse
src/reconcile.js    pure diff logic + sanity brake — fully tested
src/ha.js           HA todo REST client — UNVERIFIED, every assumption tagged
src/verify-ha.js    checks those assumptions against a real HA instance
src/store.js        todo-map, cookie and activity-log persistence
src/config.js       options.json + env overrides
src/index.js        poll cycle, --once, --dry-run, cron
```

## Next steps, in order

1. **Create one Local To-do list per child in HA** (Settings → Devices &
   services → Add integration → Local to-do). Note the entity IDs and put them
   in `options.json`.

2. **Run `npm run verify-ha -- <entity_id>`** from a machine that can reach HA.
   It creates and removes one throwaway item and reports PASS/FAIL for each
   assumption in `src/ha.js`: the title field name (`item` vs `summary`),
   `due_date` support and round-tripping, the `get_items` response shape, and
   whether `remove_item` takes a uid. **Fix `src/ha.js` for anything that
   fails** — everything else on the HA side is blocked behind this.

3. Run one real poll for a single child, confirm items appear with due dates.

4. Verify a content edit produces remove + add rather than a duplicate, and
   resets completion.

5. Check the Logbook attributes the bridge's calls distinguishably from a
   person's.

6. Add the second child, then cron scheduling.

7. Dockerfile + GitHub Actions multi-arch build + GHCR publish.

8. `ha_addon/config.yaml` + root `repository.yaml`; switch from the long-lived
   token to `SUPERVISOR_TOKEN` and confirm `homeassistant_api: true` alone is
   enough for `todo.*` calls.

## Known risks

**The parser's table assumption is the main fragility.** A diary note is
free-form rich text a teacher typed into CKEditor; the current classes happen to
use a two-column FAG/LEKTIER table, but that is a convention, not a schema. A
reformat changes what gets parsed.

Because content edits are handled as remove-then-recreate, a parser regression
could look like "every item was edited" and wipe every checkmark. The sanity
brake exists for exactly this: a cycle that would replace more than half the
tracked items, or that fetches nothing while items are tracked, is abandoned and
logged as `SANITY_BRAKE`. That turns data loss into a log line — but it still
needs a human to look.

**`todo-map-{slug}.json` is the only record** of what has already been created.
If it is lost, the next poll duplicates everything. `/data` is covered by HA's
own backups once this runs as an App.

## Security

The account password was pasted in plaintext during earlier chat-based planning
and **has not been rotated** — deliberately deferred while getting the
proof of concept working. Rotate it via ForældreIntra before this runs
unattended, then update `tmp/.env` and `options.json`.

Git history is clean: it contains placeholder values only. Real values exist
only in gitignored files (`tmp/`, `options.json`, `data/`). Keep docs and source
comments free of them — scrub before committing.
