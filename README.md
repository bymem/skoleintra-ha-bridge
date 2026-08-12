# skoleintra-ha-bridge

Pulls homework from SkoleIntra (ForældreIntra) and syncs it into per-child Home
Assistant to-do lists — checkable, with due dates, updated when a teacher edits
an entry, with an audit trail.

This repo is a **Home Assistant Apps repository**. Add it in HA via
Settings → Apps → Repositories using this repo's URL, then install
"SkoleIntra Homework Bridge".

## Layout

```
repository.yaml     marks this repo as an Apps source
ha_addon/           the App — manifest, Dockerfile, and the bridge itself
  config.yaml       manifest + the options form HA renders
  Dockerfile        built locally by the Supervisor; no registry involved
  src/              the bridge
  test/             reconciler + parser tests
docs/               spec and handoff notes
```

The app lives inside `ha_addon/` because the Supervisor builds an App with the
App's own folder as the Docker build context — a Dockerfile there cannot reach
files above it.

## Install

1. **Create one Local To-do list per child** in HA: Settings → Devices &
   services → Add integration → Local to-do. Note the entity IDs.
2. Add this repo under Settings → Apps → Repositories, install the App.
3. Fill in the Configuration tab (school URL, login, one entry per child) and
   save.
4. Start it. `run_mode` defaults to **`verify`**, so the first run checks the
   Home Assistant to-do API and exits without writing anything — see below.
5. When the log shows all checks passing, set `run_mode` to `poll` and restart.

## Why the first run verifies instead of polling

`run_mode: verify` creates one throwaway item per list, checks how this HA
version actually behaves, removes it, and reports PASS/FAIL. Anything failing
maps to a fix in `ha_addon/src/ha.js`.

Confirmed against a real instance so far: `homeassistant_api: true` alone is
sufficient for `todo.*` through the Supervisor proxy; `add_item` takes the title
as `item`; `remove_item` takes a uid; and `get_items` needs `?return_response`.

One behaviour to be aware of: `add_item` accepts `due_date` and returns 200, but
`get_items` returns **no** due field, so the bridge cannot read the date back.
Check an item in the to-do card to confirm the date is actually stored. This is
also why the created item is identified by diffing uids rather than matching on
summary and date.

## Where the data comes from

Not the "Ugeplaner" module, and therefore **not** the `skoleintra` package's
`getWeeklyPlan()`. That module is empty for this school and always has been —
the site says so outright — which is why earlier attempts returned nothing while
appearing to succeed.

Homework lives in the **Lektiebog** tab, a diary with a numeric id per class:

```
/parent/{childId}/{name}item/weeklyplansandhomework/diary/notes/{diaryId}
```

One request returns a period of days. The `skoleintra` package is used for
**login only** — it handles the SAML/noscript dance, which is the fiddly part.

Two quirks worth knowing before editing `ha_addon/src/skoleintra.js`:

- There is deliberately **no separator** before `item` in the path. It looks
  malformed and is correct — the site's own menu emits it, and inserting the
  "missing" slash returns a hard 404.
- A diary note is **free-form rich text a teacher typed into CKEditor**. The
  current classes use a two-column subject/homework table, but that is a
  convention, not a schema. The parser keeps the note whole when there is no
  usable table.

## Safety

Teacher edits are applied as remove-then-recreate, so they surface as HA's
native `item_removed` + `item_added` triggers and reset completion. Correct for
a real edit — destructive for a *parser* regression, which would make every item
look edited at once.

So a poll is abandoned and logged as `SANITY_BRAKE` when it would replace more
than `max_change_ratio` of tracked items, or fetches nothing while items are
tracked. Adds are never blocked.

Homework dated before today is skipped rather than added — the notes listing
covers a period surrounding today, past days included. Items that vanish from
the fetch, or whose date passes after they were added, are **not** removed, so
an uncompleted item stays on the list until it is checked off or deleted.

## Development

```bash
cd ha_addon
npm install
npm test        # 37 tests: reconciler, Lektiebog parser, and the HA client
npm run dry-run # fetches real homework, writes nothing anywhere
```

`npm run dry-run` needs credentials, from `ha_addon/options.json` (copy
`options.example.json`) or the environment — `SKOLEINTRA_USERNAME`,
`SKOLEINTRA_PASSWORD`, `SKOLEINTRA_BASE_URL` override the file.

Build the App image the way the Supervisor does:

```bash
cd ha_addon && docker build -t skoleintra-ha-bridge .
```

The Dockerfile deliberately ignores the `BUILD_FROM` arg the Supervisor injects;
Docker reporting it as unused is expected.

The HA client is covered by tests against a stubbed HA that reproduces observed
behaviour, but a stub only proves internal consistency — `run_mode: verify` is
what proves agreement with a real instance.

## Not done yet

- Multi-arch GHCR image + GitHub Actions (the Supervisor builds locally for now)
- Whether `due_date` is actually stored, given `get_items` never returns it
- Removing items once their date has passed, or once they vanish from SkoleIntra
