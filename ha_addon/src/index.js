// Poll cycle: SkoleIntra Lektiebog -> reconcile -> HA to-do lists.
//
// Run modes:
//   node src/index.js              scheduled, per poll_cron
//   node src/index.js --once       one cycle, then exit
//   node src/index.js --dry-run    no writes to HA; prints the exact REST calls

import cron from 'node-cron';
import { loadConfig } from './config.js';
import { Store } from './store.js';
import { SkoleIntraClient, dropPastItems, CONTENT_FORMAT } from './skoleintra.js';
import { HomeAssistantClient } from './ha.js';
import { reconcile, nextMap } from './reconcile.js';
import { verifyAll } from './verify-ha.js';

const args = process.argv.slice(2);
const runOnce = args.includes('--once');
const dryRun = args.includes('--dry-run');
const verifyFlag = args.includes('--verify');

async function pollChild({ child, skoleintra, ha, store, formatMigration = false }) {
  const now = new Date().toISOString();
  console.log(`\n--- ${child.name} (${child.slug}) ---`);

  const diaryId = child.diary_id ?? (await skoleintra.discoverDiaryId(child.child_path_segment));
  if (!diaryId) {
    throw new Error(`No Lektiebog diary found for ${child.name}`);
  }

  const { items: fetched, datesSeen } = await skoleintra.fetchHomework(child.child_path_segment, diaryId);

  // The notes listing covers a period around today, past days included.
  const items = dropPastItems(fetched);
  const skipped = fetched.length - items.length;
  console.log(
    `  diary ${diaryId}: ${items.length} current item(s) across ${datesSeen.length} day(s)` +
    (skipped ? `, ${skipped} past-dated item(s) skipped` : ''),
  );

  // Distinguish "everything fetched is in the past" from "the fetch returned
  // nothing". Only the latter is a scrape failure; letting the first case reach
  // the reconciler would trip the EMPTY_FETCH brake every poll over a holiday.
  if (items.length === 0 && fetched.length > 0) {
    console.log('  all fetched homework is past-dated — nothing current to sync');
    return true;
  }

  const previousMap = store.readMap(child.slug);
  const { operations, unchangedKeys, brake } = reconcile({
    items,
    previousMap,
    brakeOptions: {
      // A deliberate change to how homework text is rendered shifts every
      // content hash at once, which is indistinguishable from a parser
      // regression. Suspend the brake for that one migrating poll rather than
      // making the user disable a safety setting by hand.
      enabled: store.brakeOptions.enabled && !formatMigration,
      minChanges: store.brakeOptions.min_changes,
      maxChangeRatio: store.brakeOptions.max_change_ratio,
    },
  });

  if (brake) {
    const line = `${child.slug}  SANITY_BRAKE  ${brake.reason}  ${brake.detail}`;
    console.log(`  !! ${line}`);
    store.append(line);
    return false;
  }

  if (operations.length === 0) {
    console.log(`  nothing to do (${unchangedKeys.length} unchanged)`);
    store.writeMap(child.slug, nextMap({ previousMap, operations, unchangedKeys, results: {}, now }));
    return true;
  }

  // For the audit trail we want each replaced item's completion status as it was
  // immediately before we touched it — the one thing the HA Logbook won't hand
  // you without cross-referencing two separate entries.
  // null means "we could not read the list", which is different from "the list
  // is empty" — the difference decides whether a missing uid is trustworthy.
  let statusByUid = null;
  if (operations.some((op) => op.type === 'replace')) {
    try {
      const existing = await ha.getItems(child.ha_todo_entity);
      statusByUid = Object.fromEntries(existing.map((entry) => [entry.uid, entry.status]));
    } catch (error) {
      console.log(`  (could not read current items: ${error.message})`);
    }
  }

  const results = {};
  for (const op of operations) {
    try {
      if (op.type === 'replace') {
        const previousStatus = statusByUid?.[op.oldUid] ?? 'unknown';
        // Skip the removal only when we positively know the item is gone. If
        // the list could not be read, still attempt it — wrongly assuming it
        // vanished would leave the old item behind as a duplicate.
        const knownGone = statusByUid !== null && !(op.oldUid in statusByUid);
        const removed = knownGone ? false : await ha.removeItem(child.ha_todo_entity, op.oldUid);
        if (!removed) {
          store.append(`${child.slug}  STALE_UID  ${op.key}  previous item was already gone; recreating it`);
        }
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
  const applied = Object.keys(results).length;
  console.log(`  ${applied}/${operations.length} operation(s) applied`);
  return applied === operations.length;
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

    // Check every configured list exists up front. Calling todo.get_items on a
    // missing entity answers HTTP 500, which otherwise repeats once per
    // homework item and buries the actual cause ("the list doesn't exist").
    const children = [];
    for (const child of config.children) {
      if (await ha.entityExists(child.ha_todo_entity)) {
        children.push(child);
      } else {
        const line = `${child.slug}  ENTITY_MISSING  ${child.ha_todo_entity} does not exist — create the ` +
          'Local To-do list, or correct ha_todo_entity in the App configuration.';
        console.log(`  !! ${line}`);
        store.append(line);
      }
    }
    if (children.length === 0) {
      throw new Error('None of the configured to-do entities exist — nothing to sync.');
    }

    // Was the stored state written by an older rendering of homework text?
    // A first-ever run has nothing to migrate; a run with existing maps but no
    // recorded format predates the marker, so it used the old plain-text form.
    const storedFormat = store.readContentFormat();
    const formatMigration = storedFormat !== CONTENT_FORMAT && store.hasTrackedState();
    if (formatMigration) {
      const line = `FORMAT_MIGRATION  homework text rendering changed ` +
        `(${storedFormat ?? 'plain-text'} -> ${CONTENT_FORMAT}); ` +
        'every item will be rewritten once and the sanity brake is suspended for this poll.';
      console.log(`  ${line}`);
      store.append(line);
    }

    let allApplied = true;
    for (const child of children) {
      const ok = await pollChild({ child, skoleintra, ha, store, formatMigration });
      allApplied = allApplied && ok;
    }

    // Only record the new format once every item actually made it. Marking a
    // failed migration as done would leave the old hashes in place with the
    // brake re-armed, tripping MASS_CHANGE on every future poll with no way out.
    if (allApplied) {
      store.writeContentFormat(CONTENT_FORMAT);
    } else if (formatMigration) {
      console.log('  format migration incomplete — will retry on the next poll');
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
