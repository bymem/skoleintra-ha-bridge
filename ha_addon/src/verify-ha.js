// Verifies every ASSUMPTION in ha.js against a real Home Assistant instance.
//
// Nothing in ha.js has been confirmed against a live HA, because the dev machine
// can't reach one. Inside an HA App it can — so this is importable, and
// index.js runs it when `run_mode: verify` is set. It also works standalone:
//
//   HA_BASE_URL=http://homeassistant.local:8123 \
//   HA_TOKEN=<long-lived access token> \
//   node src/verify-ha.js todo.homework_child_one
//
// It creates one throwaway item and removes it again, leaving no residue.

const TEST_DUE = '2026-12-24';

// Resolve the API base and token the same way HomeAssistantClient does, so this
// verifies the path the bridge will actually take.
export function resolveTarget(env = process.env) {
  if (env.SUPERVISOR_TOKEN) {
    return { api: 'http://supervisor/core/api', token: env.SUPERVISOR_TOKEN, via: 'Supervisor proxy' };
  }
  if (!env.HA_BASE_URL || !env.HA_TOKEN) {
    return null;
  }
  return {
    api: `${env.HA_BASE_URL.replace(/\/$/, '')}/api`,
    token: env.HA_TOKEN,
    via: 'long-lived access token',
  };
}

// Runs the checks for one to-do entity. Returns { passed, failed, results }.
export async function verifyEntity({ api, token, entityId, log = console.log }) {
  const results = [];
  const record = (name, ok, detail) => {
    results.push({ name, ok });
    log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`);
    if (detail) {
      log(`        ${detail}`);
    }
  };

  const call = async (path, init = {}) => {
    const response = await fetch(`${api}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...(init.headers ?? {}),
      },
    });
    const text = await response.text();
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text;
    }
    return { status: response.status, ok: response.ok, body };
  };

  const testSummary = `__bridge_verify_${Date.now()}`;
  log(`\n=== ${entityId} ===`);

  // 1. API reachable with this token. Inside an App this also proves
  //    homeassistant_api: true is sufficient for Core API access.
  const ping = await call('/');
  record('API reachable and token accepted', ping.ok, `HTTP ${ping.status}`);
  if (!ping.ok) {
    return { passed: 0, failed: 1, results };
  }

  // 2. Entity exists.
  const state = await call(`/states/${entityId}`);
  record('Entity exists', state.ok, state.ok ? `state=${state.body.state}` : `HTTP ${state.status}`);
  if (!state.ok) {
    log('        Create it: Settings -> Devices & services -> Add integration -> Local to-do');
    return { passed: 1, failed: 1, results };
  }

  // 3. Due-date support. supported_features is a bitmask; SET_DUE_DATE_ON_ITEM
  //    is bit 4 in HA's TodoListEntityFeature.
  const features = state.body.attributes?.supported_features ?? 0;
  record(
    'Entity advertises SET_DUE_DATE_ON_ITEM',
    (features & 4) === 4,
    `supported_features=${features}. If this fails, drop due_date from ha.js addItem().`,
  );

  // 4. get_items with ?return_response — what ha.js assumes.
  const listed = await call('/services/todo/get_items?return_response', {
    method: 'POST',
    body: JSON.stringify({ entity_id: entityId }),
  });
  record(
    'todo.get_items works with ?return_response',
    listed.ok,
    `HTTP ${listed.status}${listed.ok ? '' : ` — ${JSON.stringify(listed.body).slice(0, 200)}`}`,
  );

  // 5. The exact response shape ha.js parses.
  if (listed.ok) {
    const payload = listed.body?.service_response ?? listed.body;
    record(
      'Response shape is service_response[entity].items',
      Array.isArray(payload?.[entityId]?.items),
      `Got: ${JSON.stringify(listed.body).slice(0, 250)}`,
    );
  }

  // Snapshot uids before the add. ha.js identifies a created item by diffing
  // uids, so verify has to do the same. An earlier version matched on summary
  // here while ha.js matched on summary + due_date — so this step passed while
  // the real client failed on every single item.
  const listBefore = await call('/services/todo/get_items?return_response', {
    method: 'POST',
    body: JSON.stringify({ entity_id: entityId }),
  });
  const uidsBefore = new Set(
    ((listBefore.body?.service_response ?? listBefore.body)?.[entityId]?.items ?? []).map((i) => i.uid),
  );

  // 6. add_item with `item` as the title field, plus due_date.
  const added = await call('/services/todo/add_item', {
    method: 'POST',
    body: JSON.stringify({
      entity_id: entityId,
      item: testSummary,
      description: 'Created by verify-ha — safe to delete',
      due_date: TEST_DUE,
    }),
  });
  record(
    'todo.add_item accepts { item, description, due_date }',
    added.ok,
    `HTTP ${added.status}${added.ok ? '' : ` — ${JSON.stringify(added.body).slice(0, 200)}`}`,
  );

  if (!added.ok) {
    const alt = await call('/services/todo/add_item', {
      method: 'POST',
      body: JSON.stringify({ entity_id: entityId, summary: testSummary }),
    });
    record(
      'todo.add_item accepts { summary } instead',
      alt.ok,
      'If this passes, change ha.js to send "summary" rather than "item".',
    );
  }

  // 7. add_item returns nothing, so the bridge must find the item again to get
  //    a uid for the to-do map. This is the check that matters most.
  let createdUid = null;
  const after = await call('/services/todo/get_items?return_response', {
    method: 'POST',
    body: JSON.stringify({ entity_id: entityId }),
  });
  if (after.ok) {
    const payload = after.body?.service_response ?? after.body;
    const created = (payload?.[entityId]?.items ?? []).filter((i) => !uidsBefore.has(i.uid));
    const match = created.length === 1 ? created[0] : created.filter((i) => i.summary === testSummary).at(-1);
    createdUid = match?.uid ?? null;
    record(
      'New item identifiable by uid diff (how ha.js finds it)',
      !!createdUid,
      createdUid ? `uid=${createdUid}` : `${created.length} new items appeared; could not tell which was ours.`,
    );

    // Print the item verbatim. get_items was observed not to echo due_date at
    // all, so the only way to learn what it *does* return is to look.
    if (match) {
      log(`  INFO  item as returned by get_items:\n        ${JSON.stringify(match)}`);
      // HA has used `due`, `due_date` and `due_datetime` across versions.
      const dueValue = match.due_date ?? match.due ?? match.due_datetime;
      record(
        'Due date is readable back from get_items',
        dueValue === TEST_DUE || String(dueValue ?? '').startsWith(TEST_DUE),
        dueValue === undefined
          ? `sent due_date=${TEST_DUE}; get_items returns no due field at all. ` +
            'Check the item in the HA UI: if the date shows there, only the read-back is missing.'
          : `sent ${TEST_DUE}, got ${JSON.stringify(dueValue)}`,
      );
    }
  }

  // 8. remove_item by uid — what the reconciler depends on.
  if (createdUid) {
    const removed = await call('/services/todo/remove_item', {
      method: 'POST',
      body: JSON.stringify({ entity_id: entityId, item: createdUid }),
    });
    record('todo.remove_item accepts a uid in `item`', removed.ok, `HTTP ${removed.status}`);

    if (!removed.ok) {
      const byName = await call('/services/todo/remove_item', {
        method: 'POST',
        body: JSON.stringify({ entity_id: entityId, item: testSummary }),
      });
      record(
        'todo.remove_item accepts a summary in `item`',
        byName.ok,
        'If only this passes, ha.js must track summaries rather than uids.',
      );
    }
  }

  // 9. Leave nothing behind.
  const final = await call('/services/todo/get_items?return_response', {
    method: 'POST',
    body: JSON.stringify({ entity_id: entityId }),
  });
  if (final.ok) {
    const payload = final.body?.service_response ?? final.body;
    const leftovers = (payload?.[entityId]?.items ?? []).filter((i) => i.summary === testSummary);
    record('Test item cleaned up', leftovers.length === 0, leftovers.length ? 'Remove it by hand.' : '');
  }

  const failed = results.filter((r) => !r.ok).length;
  return { passed: results.length - failed, failed, results };
}

// Verify every configured child's entity. Used by run_mode: verify.
export async function verifyAll({ entityIds, env = process.env, log = console.log }) {
  const target = resolveTarget(env);
  if (!target) {
    throw new Error('Set HA_BASE_URL and HA_TOKEN, or run inside an App with homeassistant_api: true.');
  }
  log(`Verifying HA to-do API at ${target.api} (via ${target.via})`);

  let passed = 0;
  let failed = 0;
  const allFailures = [];
  for (const entityId of entityIds) {
    const result = await verifyEntity({ api: target.api, token: target.token, entityId, log });
    passed += result.passed;
    failed += result.failed;
    allFailures.push(...result.results.filter((r) => !r.ok).map((r) => `${entityId}: ${r.name}`));
  }

  log(`\n${passed}/${passed + failed} checks passed.`);
  if (allFailures.length) {
    log('Adjust src/ha.js for:');
    for (const failure of allFailures) {
      log(`  - ${failure}`);
    }
  } else {
    log('All assumptions in src/ha.js hold. Set run_mode back to "poll".');
  }
  return { passed, failed };
}

// CLI entry point — only when run directly, not when imported.
if (import.meta.url === `file://${process.argv[1]}`) {
  const entityIds = process.argv.slice(2);
  if (entityIds.length === 0) {
    console.error('Usage: node src/verify-ha.js <todo entity_id> [...]');
    process.exit(1);
  }
  const { failed } = await verifyAll({ entityIds });
  process.exitCode = failed > 0 ? 1 : 0;
}
