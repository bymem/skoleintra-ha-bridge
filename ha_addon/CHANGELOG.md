# Changelog

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
