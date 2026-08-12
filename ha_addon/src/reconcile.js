// Reconciliation: works out what has to change in HA, without touching HA.
//
// Pure and side-effect free so it can be tested against fixtures — which
// matters, because this is the code that can destroy a kid's checked-off items.
//
// Content edits are handled as remove-then-recreate rather than update_item, so
// every change the bridge makes surfaces as one of HA's native todo triggers
// (item_added / item_removed / item_completed). A recreated item also starts as
// needs_action again, which is the wanted "teacher changed it, do it again"
// behaviour.

import { createHash } from 'node:crypto';

// Not cryptographic — just a stable fingerprint for "did the teacher edit this".
export function hashContent(text) {
  return createHash('sha256').update(text.trim()).digest('hex');
}

export function itemKey(item) {
  return `${item.date}::${item.subject}`;
}

// Decide what to do this cycle.
//
// previousMap: { "2026-08-17::HISTORIE": { uid, contentHash, lastSeen } }
// Returns operations for the caller to execute, or a brake explaining why not.
export function reconcile({ items, previousMap = {}, brakeOptions = {} }) {
  const { minChanges = 3, maxChangeRatio = 0.5, enabled = true } = brakeOptions;
  const trackedCount = Object.keys(previousMap).length;

  const operations = [];
  const unchangedKeys = [];
  const seenKeys = new Set();

  for (const item of items) {
    const key = itemKey(item);
    // A teacher listing the same subject twice on one day would otherwise
    // produce two items competing for one key.
    if (seenKeys.has(key)) {
      continue;
    }
    seenKeys.add(key);

    const hash = hashContent(item.homework);
    const known = previousMap[key];

    if (!known) {
      operations.push({ type: 'add', key, item, contentHash: hash });
    } else if (known.contentHash !== hash) {
      operations.push({
        type: 'replace',
        key,
        item,
        contentHash: hash,
        oldUid: known.uid,
        oldHash: known.contentHash,
      });
    } else {
      unchangedKeys.push(key);
    }
  }

  // --- Sanity brakes ----------------------------------------------------
  // These guard the one failure mode that silently destroys state: a scrape or
  // parse regression making every item look edited, which would remove and
  // recreate the lot and reset every checkmark.
  if (enabled && trackedCount > 0) {
    if (items.length === 0) {
      return {
        operations: [],
        unchangedKeys: [],
        brake: {
          reason: 'EMPTY_FETCH',
          detail: `Fetch returned no items while ${trackedCount} are tracked — treating as a scrape failure.`,
        },
      };
    }

    const replacements = operations.filter((op) => op.type === 'replace').length;
    const threshold = Math.max(minChanges, Math.ceil(trackedCount * maxChangeRatio));
    if (replacements > threshold) {
      return {
        operations: [],
        unchangedKeys: [],
        brake: {
          reason: 'MASS_CHANGE',
          detail:
            `${replacements} of ${trackedCount} tracked items changed at once (threshold ${threshold}) — ` +
            'likely a parser or site change rather than real edits.',
        },
      };
    }
  }

  return { operations, unchangedKeys, brake: null };
}

// Build the next todo-map from the previous one plus what actually happened.
// `results` maps an operation key to the uid HA reported for the new item.
export function nextMap({ previousMap, operations, unchangedKeys, results, now }) {
  const map = { ...previousMap };

  for (const key of unchangedKeys) {
    map[key] = { ...map[key], lastSeen: now };
  }

  for (const op of operations) {
    const uid = results[op.key];
    // An operation that failed against HA leaves the previous entry untouched,
    // so the next poll retries it rather than losing track of the item.
    if (!uid) {
      continue;
    }
    map[op.key] = { uid, contentHash: op.contentHash, lastSeen: now };
  }

  return map;
}
