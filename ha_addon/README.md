# SkoleIntra Homework Bridge

Pulls homework from SkoleIntra (ForældreIntra) and syncs it into per-child Home
Assistant to-do lists — checkable, with due dates, updated when a teacher edits
an entry, and with an audit trail.

## Before you start

**Create one Local To-do list per child first.** Settings → Devices & services →
Add integration → Local to-do. The App does not create them, and it needs the
entity IDs (e.g. `todo.homework_child_one`).

## First run: verify, don't poll

`run_mode` defaults to **`verify`** on purpose. The Home Assistant side of this
bridge has never run against a real instance, so a fresh install checks it
rather than writing anything.

1. Fill in the Configuration tab and save.
2. Start the App and open the Log tab.
3. It creates one throwaway to-do item per configured list, checks the API
   behaves as expected, removes the item again, and reports PASS/FAIL per check.

What it verifies:

- The Supervisor proxy grants `todo.*` service access (`homeassistant_api: true`
  being sufficient is itself an assumption).
- Each configured entity exists and advertises due-date support.
- The title field is `item` rather than `summary` (this varies by HA version).
- `todo.get_items` returns the expected shape with `?return_response`.
- A newly added item can be found again and exposes a `uid` — the bridge needs
  one to remove the item later, and `todo.add_item` doesn't return it.
- `todo.remove_item` accepts a uid.

If everything passes, set `run_mode` to `poll` and restart. If anything fails,
the log names the check — that maps directly to a fix in `src/ha.js`.

## Configuration

| Option | Meaning |
| --- | --- |
| `run_mode` | `verify` (check the HA API and exit) or `poll` (run normally) |
| `poll_cron` | When to poll. Default 06:00 / 13:00 / 17:00 on weekdays |
| `base_url` | `https://<school>.m.skoleintra.dk` |
| `username` / `password` | One login covers every child |
| `children[].child_path_segment` | See below |
| `children[].ha_todo_entity` | The Local To-do entity for that child |
| `sanity_brake` | See Safety |

### Finding `child_path_segment`

Log into ForældreIntra in a browser, switch to the child, and look at the URL:

```
https://<school>.m.skoleintra.dk/parent/1234/Name/Index
                                 └────────────────┘
```

Take that middle part — base URL and trailing `/Index` removed — giving
`parent/1234/Name`. It **cannot be derived or guessed**: the number is a real
per-child id, not a position, and the name is embedded in the path. Repeat per
child.

Changing options requires restarting the App (standard Supervisor behaviour).

## Safety

A teacher editing an assignment is handled by removing the to-do item and adding
a fresh one, so the change surfaces as HA's native `item_removed` + `item_added`
triggers and the item resets to not-done.

That is correct for a real edit and destructive for a *parser* regression, which
would make every item look edited at once and clear every checkmark. Homework
notes are free-form rich text a teacher typed, so the format is a convention,
not a guarantee.

So a poll is abandoned and logged as `SANITY_BRAKE` when it would replace more
than `max_change_ratio` of tracked items, or when it fetches nothing while items
are tracked. New items are never blocked — a fresh week of homework is not a
regression.

Items that disappear from the fetch are **not** removed.

## Automations

Use HA's built-in to-do triggers — `todo.item_added`, `todo.item_completed`,
`todo.item_removed` — plus `due_date` on each item. Nothing custom is exposed.

## State

Everything lives in the App's `/data`, which is included in Home Assistant's own
backups:

| File | Purpose |
| --- | --- |
| `cookies.txt` | Session reuse, which reduces automation-protection blocks |
| `todo-map-<slug>.json` | The only record of what has already been created. If lost, the next poll duplicates everything |
| `activity.log` | Audit trail, capped at 1000 lines |

To answer "did my kid check that off, or did the bridge reset it": the Logbook
says who completed an item and when; `activity.log` says why the bridge touched
it. A `CONTENT_CHANGED` line timestamped after the completion means the bridge
reset it.
