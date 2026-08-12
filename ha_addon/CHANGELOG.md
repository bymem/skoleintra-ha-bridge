# Changelog

## 0.1.3

No longer creates to-do items for homework whose date has already passed.

The Lektiebog notes listing returns a period surrounding today, so it includes
days that are already gone. Those were being synced as fresh to-do items even
though they were past due. Homework dated today is still included, since the
first poll of the day runs before school.

"Everything fetched is in the past" is now distinguished from "the fetch
returned nothing" — only the second is a scrape failure. Otherwise a school
holiday would trip the EMPTY_FETCH brake on every poll.

Note that items already synced are not removed when their date passes, so an
uncompleted item stays on the list. Auto-removal is still not implemented.

## 0.1.2

Fixes every item failing with "could not find it again to read its uid".

`todo.add_item` returns no uid, so the bridge has to find the item afterwards.
It matched on summary + due date — but `todo.get_items` does not echo any due
field back, so nothing ever matched and no item was recorded. Matching on
summary alone would also have been wrong: the same subject legitimately appears
on several dates, so it can return another item's uid.

The uid is now found by diffing the list before and after the add, which
depends on neither. `verify` uses the same logic; previously it matched on
summary only, so it passed while the real client failed on every item.

Also adds a startup check that each configured to-do entity exists. Calling
`todo.get_items` on a missing entity answers HTTP 500, which repeated once per
homework item and buried the real cause.

Confirmed working: `homeassistant_api: true` alone is sufficient for `todo.*`
through the Supervisor proxy.

Known issue: `add_item` accepts `due_date` and returns 200, but `get_items`
does not return any due field, so the bridge cannot confirm the date was
stored. `verify` now prints the item verbatim to show what is actually
returned.

## 0.1.1

Fixes the build failing on install with `npm: not found`.

The base image is now pinned directly in the Dockerfile and `build.yaml` is
gone. It had two problems: the Supervisor validates `build_from` against a
regex requiring a namespaced image path, so a bare `node:22-alpine` failed
validation and the Supervisor silently fell back to its own base image (which
has no Node); and `build.yaml` is deprecated in favour of the Dockerfile.

The Dockerfile also no longer consumes `BUILD_FROM`. The Supervisor always
injects it, so an `ARG BUILD_FROM` default could never take effect. Docker now
reports that build arg as unused — that warning is expected.

## 0.1.0

First packaged release. Not yet proven against a live Home Assistant instance —
`run_mode` defaults to `verify` for exactly that reason.

- Reads homework from the **Lektiebog** diary rather than the Ugeplaner module.
  Ugeplaner is empty for this school and always has been, which is why earlier
  attempts returned nothing while appearing to succeed.
- One login covers every child; switching between them by URL path works on a
  single session with no re-login.
- Sessions are reused from disk between polls to avoid automation-protection
  blocks.
- Homework becomes one to-do item per subject per day: subject as the title,
  the teacher's text as the description, the date as the due date.
- Teacher edits are applied as remove-then-recreate, so they surface as HA's
  native to-do triggers and reset completion.
- Sanity brake abandons a poll that would rewrite most tracked items, or that
  fetches nothing while items are tracked.
- `run_mode: verify` checks the Home Assistant to-do API and exits.

### Known gaps

- The HA to-do calls are unverified; `run_mode: verify` exists to close this.
- Whether `homeassistant_api: true` alone permits `todo.*` calls through the
  Supervisor proxy is assumed, not confirmed.
- Homework notes are free-form teacher-authored rich text. The parser handles a
  two-column subject/homework table and otherwise keeps the note whole, but a
  reformat can still change what gets parsed.
- Items removed from SkoleIntra are not removed from the to-do list.
- Built locally by the Supervisor; no published image yet.
