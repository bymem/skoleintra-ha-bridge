# skoleintra-ha-bridge — Technical Spec

## Purpose

Pull weekly homework plans ("ugeplaner") for two or more children from
SkoleIntra (ForældreIntra) and surface them in Home Assistant as per-child
to-do lists — checkable per item, with due dates, updated in place (not
duplicated) when a teacher edits an existing entry, and with a clear audit
trail so "I already did that" can actually be checked against what happened.

This replaces the originally-planned "small Docker that navigates ParentIntra"
approach — the `skoleintra` NPM package (github.com/CavaleriDK/skoleintra)
already does the scraping/auth work, so this project is a thin bridge around it,
not a scraper.

## Non-goals (v1)

- Weekly schedule / timetable (`getWeeklySchedule`) — library supports it, not wired up yet
- Calendar events (`getCalendarActivitiesByMonth`) — library supports it, not wired up yet
- Any write-back to SkoleIntra
- The notification itself (iOS push, Live Activity, whatever) — HA's native
  `todo.item_added` / `todo.item_completed` triggers plus `due_date` fields
  give you everything needed to build the actual notification automation
  yourself, same as your existing push-based automations

Both deferred data sources use methods that already exist on the `SkoleIntra`
class, so adding them later is additive — new poll calls, no architecture
change.

## Known open item — verify before building assumes it works

Confirmed: same parent login sees both children. That settles the shape of
this problem — what's still unverified is whether the specific
`parent/{index}/navn` URL pattern is really how the site distinguishes
between them, since that's inferred from the library's default value rather
than tested behavior.

The `skoleintra` package does **not** currently support selecting a specific
child. `childUrl` is a private field, defaulting to `'parent/0/navn'`, set only
from the redirect URL after login. There is no public `selectChild()` or similar.
Since one login covers both kids, the whole bridge runs off **a single
credential pair**, switching `childUrl` between requests rather than logging
in twice — this also means only one cookie jar is needed, not one per child
(see Config below).

We bypass the private field with a plain assignment — TypeScript's `private`
is compile-time only, so this only matters if the bridge code is TypeScript;
from plain JS it's just a normal property:

```typescript
const instance = new SkoleIntra(username, password, baseUrl);

// Important ordering: do one authenticated call FIRST. authenticate()
// sets childUrl from the post-login redirect URL as a side effect, which
// silently overwrites any override made before the instance has logged
// in. Setting childUrl before the first request looks like it works but
// gets clobbered the moment login actually happens.
await instance.getWeeklyPlan(new Date()); // triggers login, sets childUrl to whatever the site defaults to

// Only now does an override actually stick — the instance is already
// authenticated, so this request won't trigger authenticate() again.
(instance as any).childUrl = `parent/${childIndex}/navn`;
const plan = await instance.getWeeklyPlan(new Date());
```

This is a hack against an undocumented URL pattern inferred from the library's
own default value, not from tested behavior — see "How to test this" below
for a script that verifies it against your actual account before any of
the rest of this gets built around it.

If the URL pattern turns out to be wrong (site uses something other than a
plain index — a GUID, a query param, a cookie-based selection with no URL
change at all), the fallback isn't "scenario 2 applies instead" anymore
since that's ruled out — it just means whatever the browser check in
step 1 below reveals as the real mechanism needs to replace `parent/${childIndex}/navn`
in the snippet above. The rest of the architecture is unaffected either way;
only the exact string being assigned to `childUrl` changes.

### How to test this

Two steps, cheapest first:

**1. Browser check (no code, do this first).** Log into ForældreIntra
normally. Look for a child-switcher on the page (dropdown or tabs, usually
near the top). If it's there, switch to the other child with DevTools'
Network tab open and read the actual request URL — confirm it's really
`parent/{n}/navn` and not something else (a GUID, a query param, a
cookie-based selection with no URL change at all). This tells you the truth
before guessing from the library's source, and gives you known-good content
to compare the script's output against.

**2. Standalone diagnostic script**, separate from the bridge itself —
verifies the corrected override ordering above against your real account,
using the same account/credentials from step 1:

```javascript
// test-child-switch.mjs — throwaway, not part of the bridge.
// Run: node test-child-switch.mjs   (after `npm install skoleintra`)
// Requires env vars: SKOLEINTRA_USERNAME, SKOLEINTRA_PASSWORD, SKOLEINTRA_BASE_URL

import SkoleIntra from 'skoleintra';

const { SKOLEINTRA_USERNAME: USERNAME, SKOLEINTRA_PASSWORD: PASSWORD, SKOLEINTRA_BASE_URL: BASE_URL } = process.env;

function summarize(plan) {
  return (plan.dailyPlans ?? []).map((d) => ({
    day: d.day,
    subjects: d.lessonPlans.map((l) => l.subject),
  }));
}

function print(label, plan) {
  console.log(`\n${label}`);
  console.log(JSON.stringify(summarize(plan), null, 2));
}

async function run() {
  console.log('=== Step 1: log in, fetch whatever child the site defaults to ===');
  const instance = new SkoleIntra(USERNAME, PASSWORD, BASE_URL);
  const defaultPlan = await instance.getWeeklyPlan(new Date());
  print('Default plan (compare this against the browser for whichever child you expect this login to land on):', defaultPlan);

  console.log('\n=== Step 2: override childUrl AFTER authentication, on the same instance ===');
  instance.childUrl = 'parent/1/navn'; // plain JS — no TS cast needed here
  const overriddenPlan = await instance.getWeeklyPlan(new Date());
  print('Overridden plan (compare this against the browser for the OTHER child):', overriddenPlan);

  const defaultJson = JSON.stringify(summarize(defaultPlan));
  const overriddenJson = JSON.stringify(summarize(overriddenPlan));
  const overriddenIsEmpty = summarize(overriddenPlan).every((d) => d.subjects.length === 0);

  console.log('\n=== Verdict ===');
  if (overriddenIsEmpty) {
    console.log('Overridden plan came back empty — inconclusive. Could mean genuinely no homework this week for that child, OR the URL guess was wrong and silently fell through. Cross-check against the browser before trusting either interpretation.');
  } else if (defaultJson === overriddenJson) {
    console.log('Plans are IDENTICAL. Since both children are confirmed to be on this one login, this means the URL guess silently failed and re-resolved to the same default child rather than switching — check the raw HTTP response/status, and try other index/URL shapes based on what the browser check in step 1 showed.');
  } else {
    console.log('Plans DIFFER. Promising sign the override works — now manually confirm the overridden plan\'s subjects actually match what the browser showed for the second child, not just that it changed to something.');
  }

  console.log('\n=== Step 3: fresh instance, no override — confirm no bleed-over from Step 2 ===');
  const freshInstance = new SkoleIntra(USERNAME, PASSWORD, BASE_URL);
  const freshPlan = await freshInstance.getWeeklyPlan(new Date());
  const freshMatchesDefault = JSON.stringify(summarize(freshPlan)) === defaultJson;
  console.log(freshMatchesDefault
    ? 'Fresh instance matches the original default — good, no session pinning from the earlier override.'
    : 'Fresh instance DOES NOT match the original default — investigate before relying on this pattern across poll cycles.');

  console.log('\n=== Step 4: cookie warm-start, matching how the real poller will actually run ===');
  const cookies = await instance.getCookies();
  const warmInstance = new SkoleIntra(USERNAME, PASSWORD, BASE_URL);
  await warmInstance.setCookies(cookies);
  warmInstance.childUrl = 'parent/1/navn';
  const warmPlan = await warmInstance.getWeeklyPlan(new Date());
  const warmMatches = JSON.stringify(summarize(warmPlan)) === overriddenJson;
  console.log(warmMatches
    ? 'Warm-started instance (loaded cookies from disk, no fresh login) matches Step 2 — this is the actual pattern the bridge will use on every poll after the first.'
    : 'Warm-started instance DOES NOT match Step 2 — the override may only work right after a fresh login, which would need a different approach in the real poller.');
}

run().catch((err) => {
  console.error('Script failed:', err);
  process.exit(1);
});
```

Read the output alongside what you saw in the browser in step 1 — the
script can tell you "the response changed" or "it's still empty," but only
you can confirm the changed response is *actually the other kid's* homework
and not a login-fallback page that happened to parse as empty. If both
Step 3 and Step 4 pass, this is the pattern the real poller (and the spec
above) should use — override happens fresh each cycle, right after loading
cookies from disk, before the first request of that cycle.

This same script scaffold is easy to extend for two of the other flagged
open items too, if useful later: swap `new Date()` for a date a few weeks
out to check the future-week-plan behavior, or loop the whole thing a few
times in a row to get an early read on automation-protection blocking
frequency. Not included above to keep this test focused on the one thing it
was written to answer.

## Revision note

Two rounds of revision on the original MQTT-sensor idea:

**Round 1** replaced a read-only MQTT sensor with HA's native `todo` entities,
since checkable per-item state has to live somewhere HA users can check it
off, and `todo` isn't MQTT-discoverable (confirmed against the official list
of MQTT-discoverable component types — no `todo` in it).

**Round 2** removes the custom MQTT event entity too. It existed only to
signal "an item changed" for automations to key off. But HA's `todo`
integration already ships native triggers — `todo.item_added`,
`todo.item_completed`, `todo.item_removed` — and once the reconciler
uses **remove-then-recreate instead of in-place update** for content changes
(see Reconciliation logic below), every case the bridge produces is one of
those three native events. No custom entity needed at all; the bridge talks
to HA purely through the `todo.*` REST actions, and your automations trigger
on HA's own todo events like they would for any other to-do list.

## Architecture

```
┌───────────────────────────────────────────────────────────┐
│  skoleintra-ha-bridge (Docker container)                   │
│                                                              │
│  ┌─────────────┐   ┌──────────────────────┐                │
│  │  node-cron   │──▶│  Poller (per cycle)  │                │
│  │  scheduler   │   │  - load cookie jar   │                │
│  └─────────────┘   │  - SkoleIntra login  │                │
│                     │  - getWeeklyPlan()   │                │
│                     │    ×2 (childUrl swap)│                │
│                     │  - save cookie jar   │                │
│                     └──────────┬───────────┘                │
│                                │                             │
│                     ┌──────────▼───────────┐                │
│                     │  Reconciler            │               │
│                     │  - key = date+subject  │               │
│                     │  - hash content         │               │
│                     │  - diff vs local map    │               │
│                     │    (/data/todo-map-*)   │               │
│                     └───┬──────────────┬─────┘               │
│                         │              │                      │
│              new / changed        unchanged                   │
│                         │              │ (log only, no-op)       │
│                ┌────────▼────────┐    │                       │
│                │ HA REST client   │    │                       │
│                │ todo.add_item /  │    │                       │
│                │ todo.remove_item │    │                       │
│                └────────┬────────┘    │                       │
│                         │                                      │
│                ┌────────▼────────┐                             │
│                │ Item-level        │                            │
│                │ audit log         │                            │
│                │ (/data/activity.log)│                          │
│                └───────────────────┘                            │
└─────────────────────────┼──────────────────────────────────────┘
                           │
              HA REST API (todo.add_item / todo.remove_item)
                           │
                           ▼
                  todo.homework_emma
              (checkbox list w/ due dates,
               HA's built-in to-do card,
               native item_added/item_completed/
               item_removed triggers for your
               own automations)
```

## Why polling here, everything downstream is native HA

The poll loop against SkoleIntra is unavoidable — no webhook exists, someone
has to ask it. Everything downstream of the reconciler now goes through HA's
own `todo` mechanisms rather than a custom transport:

- **Done/not-done state** lives on the `todo` entity itself, checkable from
  any HA dashboard or the Companion app.
- **"Something changed, maybe notify"** is covered by HA's native
  `todo.item_added` / `todo.item_completed` / `todo.item_removed` triggers —
  no custom event entity needed, see Reconciliation logic below for how
  content edits map onto those three.
- **Deadlines** live on the item's `due_date` field, so "isn't done by day X"
  is a plain `todo.incomplete` condition or a scheduled check against due
  dates — no bridge-side deadline logic required either.

## Config

Packaging this as a Home Assistant App (see "Packaging as a Home Assistant
App" below) changes how config works for the better: instead of a
`config.json` + `.env` pair you manage by hand, the Supervisor generates a
proper config form from a schema and persists whatever you fill in — that
**is** the "config window," no custom UI to build. Credentials go in there
too, as masked `password` fields, so there's no separate `.env` file at all.

### App options schema (`ha_addon/config.yaml`)

```yaml
options:
  poll_cron: "0 6,13,17 * * 1-5"
  base_url: "https://YOUR_SCHOOL.m.skoleintra.dk"
  username: ""
  password: ""
  children:
    - slug: "child-one"
      name: "Emma"
      child_index: 0
      ha_todo_entity: "todo.homework_emma"
    - slug: "child-two"
      name: "Noah"
      child_index: 1
      ha_todo_entity: "todo.homework_noah"

schema:
  poll_cron: "str"
  base_url: "url"
  username: "str"
  password: "password"
  children:
    - slug: "str"
      name: "str"
      child_index: "int"
      ha_todo_entity: "str"
```

One credential pair and one `base_url`, now that it's confirmed both kids
share a single login — `username`/`password` moved out of the `children`
array to top-level fields, and `children` only carries what actually varies
per child: which index to switch to, and which HA to-do list it maps to.

The Supervisor renders `children` as a repeatable group in the Configuration
tab — add/remove a child, fill in fields, save. `password` is a masked field
and stored the same way any other App secret is (Supervisor's own config
store, not a file you manage). Nested arrays/objects two levels deep like
this are within what the schema format supports.

- `poll_cron`: default is 06:00 / 13:00 / 17:00 on weekdays — plans are
  typically published ahead of time, no need to poll hourly or on weekends.
  Adjust once you've seen how your school actually publishes.
- `child_index`: fed into the `childUrl` override from "Known open item"
  above. `0` should be whatever the login already defaults to without any
  override — worth setting the first child to `0` and confirming that
  matches before trusting `1` for the second.
- `ha_todo_entity`: entity ID of a **Local To-do** list you create manually
  in HA first (Settings → Devices & services → Add Integration → Local
  to-do, name it e.g. "Homework — Emma"). Still a one-time manual step — the
  `local_todo` integration doesn't expose list creation over the API,
  scripting it isn't worth it for a two-item setup.

No separate HA token field, either — see "Talking to HA from inside the App"
below.

At runtime, the container reads its current options from `/data/options.json`
(Supervisor writes this automatically whenever the config is saved) — plain
JSON, no bashio or shell tooling needed from Node.

No `resetCompletionOnUpdate` flag needed — with remove-then-recreate on
content change (see Reconciliation logic below), a "reset to not-done" is
just what naturally happens when an item is deleted and a fresh one takes
its place, per your call on that.

### Talking to HA from inside the App

Set `homeassistant_api: true` in `config.yaml` and the Supervisor injects a
`SUPERVISOR_TOKEN` environment variable automatically — no manual Long-Lived
Access Token, no separate `HA_BASE_URL` to configure. Calls go to
`http://supervisor/core/api/services/todo/<action>` with
`Authorization: Bearer $SUPERVISOR_TOKEN` instead of a user-created token
against the public HA URL. One less manual setup step than the standalone
Docker version, and one less credential to leak if the container's ever
compromised — it only gets Core API access, not full Supervisor control.

### Cookie persistence (flat file, not a DB — matches your usual pattern)

```
/data/
  cookies.json
```

One login, one cookie jar — since both children share a single credential
pair, the poller uses **one `SkoleIntra` instance per poll cycle**, not one
per child: load the cookie string via `setCookies()` if the file exists,
fetch the first child (which also handles authentication if the cookies
were stale or missing), override `childUrl` and fetch the second child on
the *same* instance (per the ordering rule in "Known open item" above), then
persist the latest cookie string via `getCookies()` back to disk once at the
end of the cycle. This is what the library's own README recommends to
reduce automation-protection blocks — treat it as required, not optional.

### To-do reconciliation state (flat JSON per child, not a DB)

```
/data/
  todo-map-child-one.json
  todo-map-child-two.json
```

Maps a stable homework key to what the bridge last knew about it:

```json
{
  "2026-07-20::Matematik": {
    "uid": "abc123",
    "contentHash": "9f86d0...",
    "lastSeen": "2026-07-19T13:00:04+02:00"
  }
}
```

- **Key**: `${isoDate}::${subject}` — one homework entry per subject per day,
  matching how SkoleIntra structures `DailyPlans`.
- **uid**: the HA to-do item's ID. Used only to `remove_item` the old item
  when content changes (see Reconciliation logic below) — the bridge never
  calls `todo.update_item`.
- **contentHash**: sha256 of the trimmed homework content, used purely to
  detect teacher edits — not for anything cryptographic.

This file is the only source of truth the bridge has for "have I already
created this item." If it's lost, the bridge has no way to tell existing HA
to-do items apart from ones it needs to (re)create — see "Known limitation"
below rather than building reconciliation-by-content-match to guard against a
case that shouldn't come up in normal operation. `/data` is included in HA's
own full backups by default as part of packaging this as an App, which
covers this file the same way it covers everything else in the folder — see
"Packaging as a Home Assistant App" below.

### Activity log (flat, capped — see full Logging section below)

```
/data/activity.log
```

Per-poll and per-item audit trail — used to answer "did the bridge do
something here, or not." Full design, format, and reasoning under Logging,
further down; mentioned here just to complete the `/data` layout.

## Reconciliation logic (per child, per poll)

```
fetch WeeklyPlan via SkoleIntra
for each DailyPlan.lessonPlan entry:
    key = `${date}::${subject}`
    hash = sha256(trim(content))

    if key not in todo-map:
        HA: todo.add_item(entity=haTodoEntity, item=subject, description=content,
                           due_date=date)
        todo-map[key] = { uid: <from response>, contentHash: hash, lastSeen: now }
        audit-log: ADDED key hash=hash

    else if todo-map[key].contentHash != hash:
        oldUid = todo-map[key].uid
        HA: todo.remove_item(entity=haTodoEntity, item=oldUid)
        HA: todo.add_item(entity=haTodoEntity, item=subject, description=content,
                           due_date=date)
        todo-map[key] = { uid: <from response>, contentHash: hash, lastSeen: now }
        audit-log: CONTENT_CHANGED key oldHash=old.contentHash newHash=hash
                   previousStatus=<whatever it was before removal>

    else:
        todo-map[key].lastSeen = now
        # no HA call, no log line beyond a debug-level "unchanged" — keeps
        # activity.log readable instead of one line per item per poll
```

**Why remove-then-recreate instead of `todo.update_item`:** HA's `todo`
integration fires native triggers for `todo.item_added`, `todo.item_completed`,
and `todo.item_removed` — but there's no native "item content changed"
trigger. Editing in place would need a custom signal to notify on. Deleting
the stale item and adding a fresh one turns a content edit into an
`item_removed` + `item_added` pair, both of which are things your automations
can already trigger on like any other to-do list — no custom entity, no MQTT,
nothing extra to maintain. It also gives you the reset-to-not-done behavior
for free, since a newly-added item always starts as `needs_action`.

The trade-off: HA's Logbook will show this as "removed, then added" rather
than "edited" for that one item. Given the audit-log requirement below fills
in the "why," this reads as clear rather than confusing — but worth knowing
going in, in case you'd rather have a single continuous item history for a
given piece of homework. If that ever matters more than avoiding custom
infrastructure, `todo.update_item` is a straightforward swap for the second
branch above.

Items that disappear from the fetched plan (teacher deletes an entry, or it
rolls out of the current week) are **not** auto-removed from the HA to-do
list in v1 — deliberately left as a manual cleanup rather than guessing
whether "gone from this week's plan" means "cancelled" or "just not in the
fetch window." Worth revisiting once you've seen how often it actually
happens.

## HA REST API calls

Two actions, both to `http://supervisor/core/api/services/todo/<action>` with
`Authorization: Bearer $SUPERVISOR_TOKEN` (auto-injected, see "Talking to HA
from inside the App" above) and JSON body, `target.entity_id` set to the
child's `ha_todo_entity`. The bridge never calls `todo.update_item`.

- **`todo.add_item`** — body: `{ item: subject, description: content, due_date: date }`.
  `due_date` requires the entity to support `TodoListEntityFeature.SET_DUE_DATE_ON_ITEM`
  — Local To-do should support this, but **confirm it against your actual
  entity once set up** rather than assuming; if it doesn't, drop the field
  and set due dates manually as a fallback. Also note the exact title field
  name (`item` vs `summary`) varies by HA version — confirm against yours.
- **`todo.remove_item`** — body: `{ item: uid }`, used only for the
  remove-then-recreate path above.
- **`todo.get_items`** — used once at startup per child to sanity-check that
  the configured `haTodoEntity` exists and is reachable, not used for
  reconciliation (the local `todo-map-*.json` is authoritative for that, see
  above). **Note:** there are community reports of this action returning a
  500 over plain REST without a `return_response` flag set on the call —
  confirm the exact working shape against your HA version during
  implementation rather than assuming the naive `curl` example works.

## Logging — answering "did I already check that, or did the bridge undo it?"

Two layers, deliberately not merged into one system:

**HA's own Logbook is the source of truth for "who did what."** Every
`todo.item_added` / `todo.item_completed` / `todo.item_removed` is already
recorded there with context — items completed from the frontend or Companion
app show the user who did it; items added/removed via the bridge's REST
calls show up attributed to the API/token context rather than a person. That
distinction is exactly what answers "did my kid actually check it, or did
something else touch it" — it's built into HA already, nothing to build.
Worth checking once the bridge is live that the token's calls render with a
sensible name in the Logbook rather than a bare "API" — HA's context
attribution has improved across versions, so this is a "verify on your
version" item like the others in this doc, not an assumption to build past.

**The bridge's own `/data/activity.log` fills in the "why," which the Logbook
can't show.** The Logbook records *that* an item was removed and re-added;
it doesn't record *that the bridge decided to because SkoleIntra's content
hash changed*. So each `CONTENT_CHANGED` line in the audit log captures the
old hash, new hash, and what the item's completion status was immediately
before the bridge touched it — e.g.:

```
2026-07-19T17:00:11+02:00  child-one  CONTENT_CHANGED  2026-07-20::Matematik  oldHash=9f86d0.. newHash=3b5019..  previousStatus=completed
```

Reading a kid's "I already did that" against this: check the Logbook first
for who completed the item and when; if a `CONTENT_CHANGED` line in
`activity.log` for that same key has a timestamp *after* the completion
timestamp, the bridge reset it — not the kid forgetting. If there's no such
line, the item's current not-done state reflects genuine reality. This is
also why `previousStatus` is captured explicitly — it's the one piece of
this specific question the Logbook alone won't hand you directly without
cross-referencing two separate item entries (the removal and the earlier
completion).

Cap the log at, say, 1000 lines (a bit more headroom than the seerr projects
since this one's meant to double as an audit trail, not just a health check)
and truncate oldest on write, per your usual flat-log pattern.

On poll failure: no HA calls happen. Only `activity.log` records it (a
`POLL_FAILED` line with the error), so repeated failures are visible if you
go looking, without any extra entity or dashboard plumbing in v1. Worth
revisiting only if silent staleness turns out to be a real problem in
practice — a `binary_sensor` for "bridge unhealthy" would be the natural
addition then, but isn't worth building ahead of that.

## Packaging as a Home Assistant App

**Terminology note:** HA renamed "Add-ons" to "Apps" in the 2026.2 release
(Feb 2026) — same underlying mechanism (Supervisor-managed Docker container,
`config.yaml` manifest), just a UI/docs relabel. Your existing neolink add-on
already uses the older term in places; nothing about the mechanics changed,
so this doc uses "App" going forward but you'll still see "add-on" in a lot
of HA's own developer docs and community posts.

This follows the same shape as your neolink App: a `ha_addon/` folder in the
repo, referencing an already-published multi-arch GHCR image rather than
having the Supervisor build it, added to HA as a private repository via
Settings → Apps → Repositories with the GitHub URL — not published to the
public store.

### Folder layout

```
ha_addon/
  config.yaml       # manifest — options schema lives here (see Config above)
  README.md         # shown as the App's "Documentation" tab in HA
  CHANGELOG.md       # shown as the App's "Changelog" tab
  icon.png           # optional, 128x128
```

No `Dockerfile` in this folder — same as neolink, the image is built and
published separately via GitHub Actions to GHCR, and `config.yaml` just
references it.

### `ha_addon/config.yaml` (manifest, beyond the options/schema shown above)

```yaml
name: "SkoleIntra Homework Bridge"
version: "1.0.0"
slug: "skoleintra_ha_bridge"
description: "Syncs SkoleIntra weekly homework into per-child HA to-do lists"
url: "https://github.com/YOUR_USER/skoleintra-ha-bridge"
arch:
  - aarch64
  - amd64
init: false
startup: application
boot: auto
homeassistant_api: true
image: "ghcr.io/YOUR_USER/skoleintra-ha-bridge-{arch}"
```

- `image` with `{arch}` — Supervisor resolves this per-device against your
  multi-arch GHCR tags, same pattern as your other GHCR-published projects.
- `homeassistant_api: true` — grants Core API access via the Supervisor
  proxy (see above); nothing broader than that.
- `init: false` — the base Node image handles its own signal handling and
  process management fine without Supervisor's init wrapper on top;
  consistent with keeping the container itself unchanged from a plain Docker
  deployment.
- No `ports`, no `ingress`, no `map` (extra host directories) needed — the
  App only talks out to SkoleIntra and to HA's own Core API, and its
  persistent state lives in the `/data` directory the Supervisor gives every
  App automatically. No manual volume configuration at all, unlike the
  earlier plain-Docker version of this spec.

### Repository root

Need one `repository.yaml` at the repo root (not inside `ha_addon/`) for HA
to recognize the repo as a valid Apps source when you add it via
Settings → Apps → Repositories:

```yaml
name: "Mikkel's Apps"
url: "https://github.com/YOUR_USER/YOUR_REPO"
```

If this repo already has other Apps in it (or will, alongside neolink), one
`repository.yaml` covers all of them — each App just needs its own
subfolder with a `config.yaml`.

### Why this is the "config window," not a reason to build one

Supervisor auto-generates a configuration form from `schema` in `config.yaml`
— that's the App's Configuration tab in HA's UI already, including masked
password fields and repeatable groups for the `children` array. Building a
custom ingress web UI on top would duplicate that for no benefit here; it's
the right call for Apps that need a live dashboard (like NativePop's sidebar
panel), not for a config-only settings screen like this one.

One operational note: changing options in the Configuration tab requires
restarting the App to take effect (standard Supervisor behavior, not
specific to this project) — worth knowing so a saved child that doesn't seem
to show up yet isn't mistaken for a bug.

### Docker image itself

Unchanged from the plain-Docker version of this spec — same multi-arch
(amd64 + arm64) GHCR image, published via GitHub Actions, same pattern as
seerr-relay and neolink. The App wrapper is purely the `ha_addon/config.yaml`
manifest sitting on top of it; the container doesn't need to know it's
running under Supervisor versus plain `docker run`, aside from reading
`/data/options.json` instead of a mounted `config.json`.

## Implementation order

1. **Verify the `parent/{index}/navn` URL pattern against the real account**
   using the test script above — before writing the poller, since it
   determines the exact string `child_index` needs to produce.
2. **Manually create one Local To-do list per child in HA**, note their
   entity IDs for the App's options.
3. **Confirm the exact working shape of `todo.add_item` / `todo.remove_item`
   / `todo.get_items` against your HA version** (field names, `due_date`
   support, and the `get_items` response-format quirk noted above) — do this
   with plain `curl` (against a manually-created Long-Lived Access Token,
   just for this exploratory step) before writing any bridge code against it.
4. Cookie persistence wrapper around `getCookies()`/`setCookies()`.
5. Single-child poll → reconcile → HA to-do calls, run as a plain local
   script reading a hand-written `options.json`, no App packaging yet —
   verify items appear correctly in the HA to-do card with due dates set.
6. Verify a content edit on the same homework entry correctly triggers
   remove+add (not a duplicate sitting alongside the old item), and resets
   completion.
7. Check the HA Logbook entries for those add/remove calls actually
   attribute to something identifiable, confirming the audit-trail approach
   works before relying on it.
8. Add second child.
9. Add node-cron scheduling.
10. Dockerfile + GitHub Actions multi-arch build + GHCR publish (unchanged
    from a plain-Docker deployment).
11. Write `ha_addon/config.yaml` + root `repository.yaml`, add the repo to
    HA via Settings → Apps → Repositories, confirm the Configuration tab
    renders the schema correctly (children as a repeatable group, passwords
    masked).
12. Set `homeassistant_api: true`, switch the bridge's HA calls from the
    manually-created token (step 3) to `$SUPERVISOR_TOKEN` against
    `http://supervisor/core/api/...`, confirm the calls still work from
    inside the App before removing the manual-token codepath entirely.

## Known limitation

If `/data/todo-map-*.json` is lost (fresh reinstall without restoring from
an HA backup), the bridge has no memory of which HA to-do items correspond
to which homework entries. Next poll will treat everything as new and create
duplicates rather than replacing existing items. Mitigation is operational,
not architectural — same as before, just now covered automatically by HA's
own backup system rather than something you have to remember to back up
separately, since `/data` for an installed App is included in full HA
backups by default.

## Open items to confirm once running against the real site

- Whether `parent/{index}/navn` is in fact the right URL shape for the second
  child (see "Known open item" above).
- Whether `getWeeklyPlan()` for a future week (not yet published) returns an
  empty result cleanly or throws — affects whether polling next week's plan
  in advance is worth adding later.
- Actual automation-protection blocking frequency in practice, to tune poll
  interval and decide if a manual cookie-priming step is needed on first
  deploy per child.
- Exact `todo.add_item` / `todo.remove_item` field names, `due_date` support
  on Local To-do, and the `todo.get_items` response shape on your HA version
  (see REST API section).
- Whether HA's Logbook attributes the bridge's REST calls with a name useful
  enough to distinguish "bridge did this" from "person did this" at a
  glance, or whether the audit log needs to carry more of that weight itself.
- Whether `homeassistant_api: true` alone is sufficient for `todo.*` service
  calls via the Supervisor proxy, or whether an additional permission/role
  is needed — confirm during implementation step 12 before assuming it just
  works.
