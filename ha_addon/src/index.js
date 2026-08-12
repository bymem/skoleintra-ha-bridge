// Poll cycle: SkoleIntra Lektiebog -> reconcile -> HA to-do lists.
//
// Run modes:
//   node src/index.js              scheduled, per poll_cron
//   node src/index.js --once       one cycle, then exit
//   node src/index.js --dry-run    no writes to HA; prints the exact REST calls

import cron from 'node-cron';
import { loadConfig } from './config.js';
import { Store } from './store.js';
import { SkoleIntraClient } from './skoleintra.js';
import { HomeAssistantClient } from './ha.js';
import { reconcile, nextMap } from './reconcile.js';
import { verifyAll } from './verify-ha.js';

const args = process.argv.slice(2);
const runOnce = args.includes('--once');
const dryRun = args.includes('--dry-run');
const verifyFlag = args.includes('--verify');

async function pollChild({ child, skoleintra, ha, store }) {
  const now = new Date().toISOString();
  console.log(`\n--- ${child.name} (${child.slug}) ---`);

  const diaryId = child.diary_id ?? (await skoleintra.discoverDiaryId(child.child_path_segment));
  if (!diaryId) {
    throw new Error(`No Lektiebog diary found for ${child.name}`);
  }

  const { items, datesSeen } = await skoleintra.fetchHomework(child.child_path_segment, diaryId);
  console.log(`  diary ${diaryId}: ${items.length} item(s) across ${datesSeen.length} day(s)`);

  const previousMap = store.readMap(child.slug);
  const { operations, unchangedKeys, brake } = reconcile({
    items,
    previousMap,
    brakeOptions: {
      enabled: store.brakeOptions.enabled,
      minChanges: store.brakeOptions.min_changes,
      maxChangeRatio: store.brakeOptions.max_change_ratio,
    },
  });

  if (brake) {
    const line = `${child.slug}  SANITY_BRAKE  ${brake.reason}  ${brake.detail}`;
    console.log(`  !! ${line}`);
    store.append(line);
    return;
  }

  if (operations.length === 0) {
    console.log(`  nothing to do (${unchangedKeys.length} unchanged)`);
    store.writeMap(child.slug, nextMap({ previousMap, operations, unchangedKeys, results: {}, now }));
    return;
  }

  // For the audit trail we want each replaced item's completion status as it was
  // immediately before we touched it — the one thing the HA Logbook won't hand
  // you without cross-referencing two separate entries.
  let statusByUid = {};
  if (operations.some((op) => op.type === 'replace')) {
    try {
      const existing = await ha.getItems(child.ha_todo_entity);
      statusByUid = Object.fromEntries(existing.map((entry) => [entry.uid, entry.status]));
    } catch (error) {
      console.log(`  (could not read current items for audit detail: ${error.message})`);
    }
  }

  const results = {};
  for (const op of operations) {
    try {
      if (op.type === 'replace') {
        const previousStatus = statusByUid[op.oldUid] ?? 'unknown';
        await ha.removeItem(child.ha_todo_entity, op.oldUid);
        const uid = await ha.addItem(child.ha_todo_entity, {
          summary: op.item.subject,
          description: op.item.homework,
          dueDate: op.item.date,
        });
        results[op.key] = uid;
        console.log(
          store.append(
            `${child.slug}  CONTENT_CHANGED  ${op.key}  ` +
            `oldHash=${op.oldHash.slice(0, 8)} newHash=${op.contentHash.slice(0, 8)}  ` +
            `previousStatus=${previousStatus}`,
          ),
        );
      } else {
        const uid = await ha.addItem(child.ha_todo_entity, {
          summary: op.item.subject,
          description: op.item.homework,
          dueDate: op.item.date,
        });
        results[op.key] = uid;
        console.log(store.append(`${child.slug}  ADDED  ${op.key}  hash=${op.contentHash.slice(0, 8)}`));
      }
    } catch (error) {
      // One failed item must not abandon the rest of the cycle; the map is left
      // untouched for this key so the next poll retries it.
      console.log(store.append(`${child.slug}  OP_FAILED  ${op.key}  ${error.message}`));
    }
  }

  store.writeMap(child.slug, nextMap({ previousMap, operations, unchangedKeys, results, now }));
  console.log(`  ${Object.keys(results).length}/${operations.length} operation(s) applied`);
}

async function pollCycle(config, store) {
  const skoleintra = new SkoleIntraClient({
    baseUrl: config.base_url,
    username: config.username,
    password: config.password,
    cookieFile: store.cookiePath(),
  });

  const ha = dryRun
    ? new HomeAssistantClient({ baseUrl: 'http://dry-run/api', token: 'dry-run', dryRun: true })
    : HomeAssistantClient.fromEnv();

  try {
    await skoleintra.restoreSession();
    if (!dryRun) {
      await ha.ping();
    }

    for (const child of config.children) {
      await pollChild({ child, skoleintra, ha, store });
    }

    await skoleintra.persistSession();
  } catch (error) {
    // On failure no HA calls have to be undone — each item is applied
    // independently — so recording it is enough.
    console.error(`Poll failed: ${error.message}`);
    store.append(`POLL_FAILED  ${error.message}`);
    process.exitCode = 1;
  }
}

const config = loadConfig();
const store = new Store(config.data_dir, { readOnly: dryRun });
store.brakeOptions = config.sanity_brake;

console.log(`skoleintra-ha-bridge — config from ${config.sourcePath}`);
console.log(`children: ${config.children.map((c) => c.name).join(', ')}`);
if (dryRun) {
  console.log('DRY RUN — no changes will be written to Home Assistant\n');
}

// run_mode: verify checks every ASSUMPTION in ha.js against the real instance
// and exits without touching SkoleIntra. This is how a first App install
// confirms the HA side, since the dev machine can't reach HA at all.
if (verifyFlag || config.run_mode === 'verify') {
  console.log('run_mode: verify — checking the HA to-do API, not polling.\n');
  try {
    const { failed } = await verifyAll({
      entityIds: config.children.map((child) => child.ha_todo_entity),
    });
    process.exitCode = failed > 0 ? 1 : 0;
  } catch (error) {
    // A stack trace here tells the reader nothing useful — the cause is always
    // configuration, and this runs in an App log where it just adds noise.
    console.error(`Cannot verify: ${error.message}`);
    process.exitCode = 1;
  }
} else if (runOnce || dryRun) {
  await pollCycle(config, store);
} else {
  console.log(`scheduling: ${config.poll_cron}`);
  cron.schedule(config.poll_cron, () => pollCycle(config, store));
  await pollCycle(config, store);
}
