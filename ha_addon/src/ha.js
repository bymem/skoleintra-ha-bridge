// Home Assistant to-do client.
//
// ⚠ EVERYTHING IN THIS FILE IS UNVERIFIED against a real HA instance — the dev
// machine can't reach one. Each assumption is marked ASSUMPTION and is checked
// by `npm run verify-ha` (src/verify-ha.js) once HA is reachable. Run that
// before trusting any of this.
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

  // ASSUMPTION: the title field is `item`, and `due_date` (yyyy-mm-dd) is
  // accepted — the latter needs TodoListEntityFeature.SET_DUE_DATE_ON_ITEM,
  // which Local To-do is believed to support but has not been confirmed here.
  //
  // PROBLEM the spec missed: todo.add_item does NOT return the created item's
  // uid, but the todo-map needs a uid to remove the item later. So after adding
  // we read the list back and match on summary + due date. That costs one extra
  // call per add, which only happens for genuinely new homework.
  async addItem(entityId, { summary, description, dueDate }) {
    const data = { entity_id: entityId, item: summary };
    if (description) {
      data.description = description;
    }
    if (dueDate) {
      data.due_date = dueDate;
    }
    await this.callService('todo', 'add_item', data);

    if (this.dryRun) {
      return `dry-run-uid-${summary}`;
    }
    return this.resolveUid(entityId, { summary, dueDate });
  }

  // Find the uid of an item we just created.
  async resolveUid(entityId, { summary, dueDate }) {
    const items = await this.getItems(entityId);
    // Match on summary and, when present, due date. If a teacher sets the same
    // subject on two dates, the due date is what tells them apart.
    const candidates = items.filter(
      (candidate) => candidate.summary === summary && (!dueDate || candidate.due_date === dueDate),
    );
    if (candidates.length === 0) {
      throw new Error(`Added "${summary}" to ${entityId} but could not find it again to read its uid.`);
    }
    // Newest last is the usual ordering; if ambiguous, the last match is the
    // one we just added.
    return candidates[candidates.length - 1].uid;
  }

  // ASSUMPTION: remove_item accepts a uid in `item`. Some HA versions expect the
  // summary here instead — verify before relying on it.
  async removeItem(entityId, uid) {
    await this.callService('todo', 'remove_item', { entity_id: entityId, item: uid });
  }
}
