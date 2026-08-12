# skoleintra-ha-bridge — Technical Spec

> **Privacy note:** this document uses placeholders (`<school>`, `<username>`,
> `Child A`, `parent/{childId}/{name}`, `<class>`) throughout. Real credentials,
> child IDs and entity names live only in `options.json` and `tmp/.env`, both of
> which are gitignored. Keep it that way — do not paste real values into docs.

## Purpose

Pull homework for two or more children from SkoleIntra (ForældreIntra) and
surface it in Home Assistant as per-child to-do lists — checkable per item, with
due dates, updated in place when a teacher edits an entry, and with an audit
trail so "I already did that" can be checked against what actually happened.

## Status

| Area | State |
| --- | --- |
| SkoleIntra login + session reuse | **Verified** against the live account |
| Per-child switching | **Verified** — distinct classes returned per child |
| Homework fetch + parse | **Verified** — real items for both children |
| Reconciliation + sanity brake | **Verified** by tests (`npm test`) |
| Home Assistant `todo.*` calls | **Unverified** — no reachable HA instance yet |
| Docker / GHCR / App packaging | Not started |

## The data source — this is the part the original spec got wrong

The original design was built around the `skoleintra` npm package's
`getWeeklyPlan()`, which scrapes the **Ugeplaner** ("weekly plans") module.

**That module is empty for this school and always has been.** The site says so
directly — "Der er ingen ugeplaner for `<class>` i skoleåret `<year>`" — and a
sweep of a full term's ISO weeks returned zero lessons for every child. Every
request was succeeding and correctly returning an empty plan, which is what made
this look like a bug for so long.

The homework actually lives in the **Lektiebog** ("homework book") tab, a
sibling of Ugeplaner under the same menu item. It is a diary with a numeric id
per class:

```
/parent/{childId}/{name}item/weeklyplansandhomework/diary            # landing page, carries the diary id
/parent/{childId}/{name}item/weeklyplansandhomework/diary/{diaryId}/{yyyy-mm-dd}   # one day
/parent/{childId}/{name}item/weeklyplansandhomework/diary/notes/{diaryId}          # a period of days in one request
```

The bridge uses the `notes/{diaryId}` form: one request per child per poll
returns every note in the site's current period (observed: roughly the
surrounding fortnight), rather than one request per date.

The `skoleintra` package therefore has **no usable data method** for this
project. It is kept for **login only**, because it correctly handles the SAML +
noscript form dance, which is the fiddly part of authenticating.

### Two URL quirks that will otherwise waste your time

**There is no separator before `item`.** The path is
`parent/{childId}/{name}` immediately followed by `item/weeklyplansandhomework/...`,
producing something that looks malformed:

```
/parent/{childId}/{name}item/weeklyplansandhomework/diary/notes/{diaryId}
```

This is correct. The site's own navigation emits exactly this shape. Inserting
the "missing" slash returns a hard IIS 404. The `skoleintra` package's
`tryNavigate()` builds `${baseUrl}/${childUrl}${targetUrl}` for the same reason.

**Child paths are not positional indices.** They are `parent/{realId}/{realName}`,
captured from the browser URL after switching to that child, with the base URL
and trailing `/Index` stripped. The id cannot be derived or guessed. The package's
shipped default (`parent/0/navn`) is a placeholder, not a pattern.

### Child switching — confirmed working

Assigning `childUrl` (or, in this bridge, simply building the path) switches
child cleanly on a single authenticated session, with no re-login and no session
pinning. Confirmed by requesting each child's path in turn and reading
`SelectedPlan.ClassOrGroup` back — each child returns their own class.

That field is the right thing to assert on. Comparing homework text can't
distinguish "the override worked" from "we got a fallback page that happened to
parse as empty"; the class designation can.

Note `authenticate()` overwrites `childUrl` from the post-login redirect as a
side effect, so an override set *before* the first authenticated request is
silently clobbered. The bridge builds each URL explicitly per request and so
sidesteps this entirely.

## Content shape — and why the parser is defensive

A diary note is **free-form rich text a teacher typed into CKEditor**. The
current classes happen to use a two-column table:

| FAG | LEKTIER |
| --- | --- |
| DANSK | *(blank)* |
| MATEMATIK | Multi grundbog s. 8-9 opg. 6+7+8 |

The markup is hand-authored — inline `bgcolor`, and a `widht="80%"` typo
preserved in the live page. **Nothing guarantees this format.** A different
teacher, class or school year may write prose, a different table, or a list.

So `itemsFromNote()`:

1. Parses a two-column table into one item per subject that has homework.
2. Skips the header row and subjects with an empty homework cell.
3. If a table exists but yields no items (start of term, "no homework today"),
   **removes the table** and keeps whatever prose surrounds it — otherwise the
   empty grid of subject names ends up in the to-do description.
4. If there is no usable table at all, keeps the note whole as a single
   `Lektier` item rather than returning nothing.

Point 4 matters: silently returning nothing on a format change is exactly what
would trigger a mass-removal, so the fallback is a safety feature, not a nicety.

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│  skoleintra-ha-bridge                                         │
│                                                                │
│  node-cron ──▶ Poller (per cycle, per child)                  │
│                 - load cookies.txt                             │
│                 - skoleintra pkg: authenticate if needed       │
│                 - GET diary/notes/{diaryId}                    │
│                 - parse notes -> {date, subject, homework}     │
│                 - save cookies.txt                             │
│                          │                                     │
│                 Reconciler (pure, tested)                      │
│                 - key  = `${date}::${subject}`                 │
│                 - hash = sha256(trim(homework))                │
│                 - diff vs todo-map-{slug}.json                 │
│                 - SANITY BRAKE on mass change / empty fetch    │
│                          │                                     │
│              new / changed          unchanged                  │
│                          │              └─ lastSeen only       │
│                 HA REST client                                 │
│                 todo.add_item / todo.remove_item               │
│                          │                                     │
│                 activity.log (capped audit trail)              │
└──────────────────────────┼───────────────────────────────────┘
                            ▼
              todo.homework_<child>  (Local To-do)
```

Polling is unavoidable — no webhook exists. Everything downstream uses HA's own
mechanisms: completion state lives on the `todo` entity, deadlines on
`due_date`, and change signalling on HA's native `todo.item_added` /
`item_completed` / `item_removed` triggers. No MQTT, no custom entity.

## Reconciliation

```
for each parsed item:
    key  = `${date}::${subject}`
    hash = sha256(trim(homework))

    key unseen              -> todo.add_item, record { uid, contentHash, lastSeen }
    hash differs            -> todo.remove_item(oldUid); todo.add_item; re-record
    hash matches            -> update lastSeen only, no HA call
    tracked but not fetched -> leave alone (v1)
```

**Why remove-then-recreate rather than `todo.update_item`:** HA has no native
"item content changed" trigger, so an in-place edit would need a custom signal
to notify on. Removing and re-adding turns a content edit into an
`item_removed` + `item_added` pair, both of which existing automations can
already trigger on. It also resets the item to `needs_action` for free, which is
the wanted behaviour when a teacher changes the assignment.

Trade-off: HA's Logbook shows "removed, then added" rather than "edited" for
that item. The audit log fills in the why.

Items that disappear from the fetch are **not** auto-removed in v1 — "gone from
this fetch" could mean cancelled, or merely outside the returned period.

### The sanity brake

Remove-then-recreate is destructive by design: it resets completion. That is
correct for a real teacher edit and catastrophic for a *parser regression*,
which would make every item look edited at once and wipe every checkmark.

So a cycle is abandoned, and logged as `SANITY_BRAKE`, when either:

- **`EMPTY_FETCH`** — the fetch returned nothing while items are tracked.
- **`MASS_CHANGE`** — replacements exceed `max(min_changes, tracked × max_change_ratio)`.

Adds are never blocked: a fresh week of homework is not a regression. Both paths
are covered by tests, including the case that must *not* trip — one teacher
editing one entry among many.

Defaults: `enabled: true`, `min_changes: 3`, `max_change_ratio: 0.5`.

## Home Assistant integration — **unverified**

Nothing in `src/ha.js` has been confirmed against a real instance. Each
assumption is tagged `ASSUMPTION` in the source and checked by
`npm run verify-ha -- <entity_id>`, which creates and removes one throwaway item
and reports PASS/FAIL per assumption. **Run it before trusting the bridge.**

Open questions it settles:

- Title field: `item` vs `summary` (varies by HA version).
- Whether Local To-do advertises `SET_DUE_DATE_ON_ITEM`, and whether `due_date`
  round-trips.
- The `todo.get_items` response shape, and the reported 500 without
  `?return_response`.
- Whether `todo.remove_item` accepts a uid in `item`, or expects the summary.

### A problem in the original design

The original spec stored the uid "from the response" of `todo.add_item`.
**`todo.add_item` does not return one.** The reconciler needs a uid to remove the
item later, so `addItem()` reads the list back and matches on summary + due date.
That costs one extra call per genuinely-new item.

If `verify-ha` shows uids aren't usable, the fallback is tracking summaries
instead — weaker, because two items sharing a summary on one date would collide.

### Auth

Inside an HA App, `homeassistant_api: true` makes the Supervisor inject
`SUPERVISOR_TOKEN`; calls go to `http://supervisor/core/api/...`. No
user-created token, and only Core API access. For local development,
`HA_BASE_URL` + `HA_TOKEN` (a Long-Lived Access Token) are used instead.
`HomeAssistantClient.fromEnv()` prefers the Supervisor token when present.

## Config

Inside an HA App the Supervisor writes the config form's values to
`/data/options.json`, so the generated form **is** the config UI — there is no
reason to build one. Locally, a hand-written `options.json` stands in.
Credentials may also come from the environment, which overrides the file.

```json
{
  "poll_cron": "0 6,13,17 * * 1-5",
  "base_url": "https://<school>.m.skoleintra.dk",
  "username": "<username>",
  "password": "<password>",
  "data_dir": "/data",
  "sanity_brake": { "enabled": true, "min_changes": 3, "max_change_ratio": 0.5 },
  "children": [
    {
      "slug": "child-one",
      "name": "Child A",
      "child_path_segment": "parent/{childId}/{name}",
      "ha_todo_entity": "todo.homework_child_one"
    }
  ]
}
```

One credential pair covers all children — they share a single login, so one
cookie jar and one session per cycle, not one per child.

`ha_todo_entity` must reference a **Local To-do** list created manually in HA
first (Settings → Devices & services → Add integration → Local to-do). The
integration doesn't expose list creation over the API.

`diary_id` may optionally be pinned per child; otherwise it is discovered each
cycle at the cost of one request, which avoids silent breakage at a class change.

## State (`data_dir`)

```
cookies.txt              session reuse — reduces automation-protection blocks
todo-map-{slug}.json     the only record of "already created in HA"
activity.log             audit trail, capped at 1000 lines
```

`todo-map-*.json` is authoritative for reconciliation. If it is lost, the next
poll treats everything as new and duplicates it. Mitigation is operational:
`/data` is included in HA's own backups for an installed App.

A corrupt map raises rather than silently starting fresh, since starting fresh
is precisely what causes mass duplication.

## Logging

**HA's Logbook is the source of truth for who did what.** Completions from the
frontend or Companion app are attributed to a user; the bridge's REST calls
appear under the API/token context.

**`activity.log` fills in the why**, which the Logbook cannot show — that the
bridge removed and re-added an item *because the content hash changed*:

```
<timestamp>  child-one  CONTENT_CHANGED  2026-08-17::HISTORIE  oldHash=9f86d0.. newHash=3b5019..  previousStatus=completed
```

`previousStatus` is captured explicitly because it is the one piece the Logbook
won't hand you without cross-referencing two separate entries. To answer "did my
kid check that off, or did the bridge reset it": if a `CONTENT_CHANGED` line for
that key is timestamped *after* the completion, the bridge reset it.

Other line types: `ADDED`, `OP_FAILED`, `SANITY_BRAKE`, `POLL_FAILED`. A failed
operation leaves that key's map entry untouched so the next poll retries it,
rather than losing track of the item.

## Packaging as a Home Assistant App — not started

HA renamed "Add-ons" to "Apps" in 2026.2; the mechanism is unchanged. Intended
shape, following the same pattern as other private Apps: an `ha_addon/` folder
holding `config.yaml`, `README.md`, `CHANGELOG.md`, plus a `repository.yaml` at
the repo root, referencing a multi-arch GHCR image built by GitHub Actions
rather than built by the Supervisor.

```yaml
name: "SkoleIntra Homework Bridge"
slug: "skoleintra_ha_bridge"
arch: [aarch64, amd64]
init: false
startup: application
boot: auto
homeassistant_api: true
image: "ghcr.io/<owner>/skoleintra-ha-bridge-{arch}"
```

No `ports`, `ingress` or `map` needed — the App only talks out to SkoleIntra and
to HA's Core API, and its state lives in the `/data` every App is given.

Changing options requires an App restart to take effect (standard Supervisor
behaviour).

## Open items

- **Run `verify-ha`** and fix `src/ha.js` for anything that fails. Everything
  else on the HA side is blocked behind this.
- Confirm the Logbook attributes the bridge's calls distinguishably from a
  person's, or accept that `activity.log` carries that weight alone.
- Confirm `homeassistant_api: true` alone suffices for `todo.*` calls via the
  Supervisor proxy.
- Observe automation-protection blocking under sustained polling. None was seen
  across roughly 45 requests in one session with cookie reuse, so the original
  concern looks overstated — but that isn't a long-run sample.
- Decide whether to auto-remove items that vanish from the fetch, once there is
  real evidence of how often that happens and what it means.
- The parser's table assumption is the biggest fragility. Worth revisiting if a
  class changes format — the sanity brake turns that from data loss into a log
  line, but it still needs a human.

## Non-goals (v1)

- Weekly schedule / timetable and calendar events (both available in the
  package, neither wired up)
- Any write-back to SkoleIntra
- The notification automation itself — HA's native todo triggers plus
  `due_date` already provide everything needed to build it
