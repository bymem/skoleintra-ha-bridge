// Home Assistant to-do client.
//
// Confirmed against a real instance: homeassistant_api: true alone is enough
// for todo.* through the Supervisor proxy; add_item takes the title as `item`
// and accepts due_date; remove_item takes a uid; get_items needs
// ?return_response and answers with service_response alongside changed_states.
//
// Confirmed quirk: get_items does NOT echo any due field back, so the bridge
// can never read a due date it has written.
//
// Anything still marked ASSUMPTION below is unverified. `npm run verify-ha`
// (src/verify-ha.js) re-checks the lot against a live instance.
//
// Auth has two modes:
//   - Inside an HA App: SUPERVISOR_TOKEN is injected, base URL is
//     http://supervisor/core/api (needs `homeassistant_api: true`).
//   - Local development: a Long-Lived Access Token against http://<ha>:8123/api.

export class HomeAssistantClient {
  constructor({ baseUrl, token, dryRun = false, log = console.log }) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.token = token;
    this.dryRun = dryRun;
    this.log = log;
  }

  // Build a client from the environment, preferring the Supervisor injection.
  static fromEnv(env = process.env, options = {}) {
    if (env.SUPERVISOR_TOKEN) {
      return new HomeAssistantClient({
        baseUrl: 'http://supervisor/core/api',
        token: env.SUPERVISOR_TOKEN,
        ...options,
      });
    }
    if (!env.HA_BASE_URL || !env.HA_TOKEN) {
      throw new Error('Set HA_BASE_URL and HA_TOKEN (or run inside an HA App with homeassistant_api: true).');
    }
    return new HomeAssistantClient({
      baseUrl: `${env.HA_BASE_URL.replace(/\/$/, '')}/api`,
      token: env.HA_TOKEN,
      ...options,
    });
  }

  // ASSUMPTION: response-returning service calls need ?return_response, and
  // calling it on a service that returns nothing is an error — so it is only
  // set where we actually expect data back.
  async callService(domain, service, data, { returnResponse = false } = {}) {
    const url = `${this.baseUrl}/services/${domain}/${service}${returnResponse ? '?return_response' : ''}`;

    if (this.dryRun) {
      this.log(`      DRY-RUN POST ${url}`);
      this.log(`               ${JSON.stringify(data)}`);
      return null;
    }

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(data),
    });

    if (!response.ok) {
      throw new Error(`HA ${domain}.${service} failed: HTTP ${response.status} ${await response.text()}`);
    }
    const text = await response.text();
    return text ? JSON.parse(text) : null;
  }

  async ping() {
    if (this.dryRun) {
      this.log('      DRY-RUN GET  ' + `${this.baseUrl}/`);
      return true;
    }
    const response = await fetch(`${this.baseUrl}/`, {
      headers: { Authorization: `Bearer ${this.token}` },
    });
    if (!response.ok) {
      throw new Error(`HA API unreachable: HTTP ${response.status}`);
    }
    return true;
  }

  // ASSUMPTION: todo.get_items returns { service_response: { <entity_id>: { items: [...] } } }.
  // The spec notes community reports of a 500 here without return_response.
  async getItems(entityId, { status } = {}) {
    const data = { entity_id: entityId };
    if (status) {
      data.status = status;
    }
    const result = await this.callService('todo', 'get_items', data, { returnResponse: true });
    if (!result) {
      return [];
    }
    const payload = result.service_response ?? result;
    return payload?.[entityId]?.items ?? [];
  }

  // todo.add_item returns no body, so the created item's uid has to be
  // discovered afterwards — and the to-do map needs it to remove the item later.
  //
  // We find it by diffing uids before and after the add, rather than searching
  // by summary and due date. Two reasons, both found against a real instance:
  //   - get_items does NOT echo back due_date, so matching on it never matched.
  //   - summaries are not unique. The same subject legitimately appears on
  //     several dates ("MATEMATIK" on the 12th and the 14th), so a summary
  //     match can return the wrong item's uid.
  // A uid diff depends on neither and is exact.
  async addItem(entityId, { summary, description, dueDate }) {
    const data = { entity_id: entityId, item: summary };
    if (description) {
      data.description = description;
    }
    if (dueDate) {
      data.due_date = dueDate;
    }

    if (this.dryRun) {
      await this.callService('todo', 'add_item', data);
      return `dry-run-uid-${summary}`;
    }

    const before = new Set((await this.getItems(entityId)).map((item) => item.uid));
    await this.callService('todo', 'add_item', data);
    const after = await this.getItems(entityId);

    const created = after.filter((item) => !before.has(item.uid));
    if (created.length === 1) {
      return created[0].uid;
    }
    if (created.length === 0) {
      throw new Error(`Added "${summary}" to ${entityId} but no new item appeared in the list.`);
    }
    // More than one appeared — something else wrote to the list at the same
    // moment. Fall back to the newest matching summary rather than guessing.
    const match = created.filter((item) => item.summary === summary).at(-1);
    if (!match) {
      throw new Error(`Added "${summary}" to ${entityId} but could not identify which new item it was.`);
    }
    return match.uid;
  }

  // Cheap existence check so a mistyped or not-yet-created entity fails with a
  // clear message instead of a burst of opaque HTTP 500s from get_items.
  async entityExists(entityId) {
    if (this.dryRun) {
      return true;
    }
    const response = await fetch(`${this.baseUrl}/states/${entityId}`, {
      headers: { Authorization: `Bearer ${this.token}` },
    });
    return response.ok;
  }

  // Removes an item, tolerating one that has already gone.
  //
  // Returns true if it was removed, false if HA reports there was no such item.
  // A stale uid is normal: someone deleted the item in the HA UI, or an earlier
  // cycle removed it and failed before recording the result. Treating that as a
  // hard error left the item permanently stuck, retrying the same doomed
  // removal every poll and never applying the teacher's edit.
  //
  // NOTE: this message match is a fallback only — HA's exact wording here has
  // not been confirmed. The caller's primary defence is checking the item is
  // actually present before asking for its removal.
  async removeItem(entityId, uid) {
    try {
      await this.callService('todo', 'remove_item', { entity_id: entityId, item: uid });
      return true;
    } catch (error) {
      if (/unable to find|not found|no such/i.test(error.message)) {
        return false;
      }
      throw error;
    }
  }
}
