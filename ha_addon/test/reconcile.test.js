import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcile, nextMap, hashContent, itemKey } from '../src/reconcile.js';

const item = (date, subject, homework) => ({ date, subject, homework });

// Build a todo-map entry that matches the given item, as if we'd synced it.
function tracked(uid, homework) {
  return { uid, contentHash: hashContent(homework), lastSeen: '2026-08-01T00:00:00.000Z' };
}

test('new homework produces add operations', () => {
  const items = [item('2026-08-17', 'HISTORIE', 'Læs s. 5-7')];
  const { operations, brake } = reconcile({ items, previousMap: {} });

  assert.equal(brake, null);
  assert.equal(operations.length, 1);
  assert.equal(operations[0].type, 'add');
  assert.equal(operations[0].key, '2026-08-17::HISTORIE');
});

test('unchanged homework produces no operations', () => {
  const items = [item('2026-08-17', 'HISTORIE', 'Læs s. 5-7')];
  const previousMap = { '2026-08-17::HISTORIE': tracked('uid-1', 'Læs s. 5-7') };

  const { operations, unchangedKeys } = reconcile({ items, previousMap });

  assert.deepEqual(operations, []);
  assert.deepEqual(unchangedKeys, ['2026-08-17::HISTORIE']);
});

test('an edited entry becomes a replace carrying the old uid', () => {
  const items = [item('2026-08-17', 'HISTORIE', 'Læs s. 5-9 i stedet')];
  const previousMap = { '2026-08-17::HISTORIE': tracked('uid-1', 'Læs s. 5-7') };

  const { operations } = reconcile({ items, previousMap });

  assert.equal(operations.length, 1);
  assert.equal(operations[0].type, 'replace');
  assert.equal(operations[0].oldUid, 'uid-1');
  assert.notEqual(operations[0].contentHash, operations[0].oldHash);
});

test('whitespace-only differences are not treated as edits', () => {
  const items = [item('2026-08-17', 'HISTORIE', '  Læs s. 5-7  ')];
  const previousMap = { '2026-08-17::HISTORIE': tracked('uid-1', 'Læs s. 5-7') };

  const { operations } = reconcile({ items, previousMap });

  assert.deepEqual(operations, []);
});

test('the same subject listed twice on one day only yields one operation', () => {
  const items = [
    item('2026-08-17', 'DANSK', 'Første'),
    item('2026-08-17', 'DANSK', 'Anden'),
  ];
  const { operations } = reconcile({ items, previousMap: {} });

  assert.equal(operations.length, 1);
});

// --- Sanity brakes -------------------------------------------------------

test('an empty fetch with tracked items trips the brake instead of doing nothing quietly', () => {
  const previousMap = {
    '2026-08-17::HISTORIE': tracked('uid-1', 'a'),
    '2026-08-17::DANSK': tracked('uid-2', 'b'),
  };
  const { operations, brake } = reconcile({ items: [], previousMap });

  assert.equal(brake.reason, 'EMPTY_FETCH');
  assert.deepEqual(operations, []);
});

test('an empty fetch on a first run is normal, not a brake', () => {
  const { brake } = reconcile({ items: [], previousMap: {} });
  assert.equal(brake, null);
});

test('a parser regression that rewrites every item trips the brake', () => {
  // Ten tracked items; a parse change makes all ten look edited.
  const previousMap = {};
  const items = [];
  for (let i = 0; i < 10; i += 1) {
    const key = `2026-08-1${i % 10}::FAG${i}`;
    previousMap[key] = tracked(`uid-${i}`, `original ${i}`);
    items.push(item(`2026-08-1${i % 10}`, `FAG${i}`, `MANGLED ${i}`));
  }

  const { operations, brake } = reconcile({ items, previousMap });

  assert.equal(brake.reason, 'MASS_CHANGE');
  assert.deepEqual(operations, [], 'no destructive work when the brake trips');
});

test('a teacher editing one entry among many is allowed through', () => {
  const previousMap = {};
  const items = [];
  for (let i = 0; i < 10; i += 1) {
    const key = `2026-08-1${i % 10}::FAG${i}`;
    previousMap[key] = tracked(`uid-${i}`, `original ${i}`);
    items.push(item(`2026-08-1${i % 10}`, `FAG${i}`, i === 3 ? 'edited' : `original ${i}`));
  }

  const { operations, brake } = reconcile({ items, previousMap });

  assert.equal(brake, null);
  assert.equal(operations.length, 1);
  assert.equal(operations[0].type, 'replace');
});

test('adds are never blocked by the brake, only replaces', () => {
  const previousMap = { '2026-08-10::DANSK': tracked('uid-1', 'unchanged') };
  const items = [
    item('2026-08-10', 'DANSK', 'unchanged'),
    ...Array.from({ length: 20 }, (_, i) => item('2026-08-11', `NYT${i}`, `nyt ${i}`)),
  ];

  const { operations, brake } = reconcile({ items, previousMap });

  assert.equal(brake, null, 'a week of new homework is not a regression');
  assert.equal(operations.length, 20);
});

test('the brake can be switched off', () => {
  const previousMap = {
    '2026-08-17::A': tracked('uid-1', 'a'),
    '2026-08-17::B': tracked('uid-2', 'b'),
  };
  const { brake } = reconcile({ items: [], previousMap, brakeOptions: { enabled: false } });

  assert.equal(brake, null);
});

// --- Map rebuilding ------------------------------------------------------

test('a failed HA call leaves the previous entry so the next poll retries', () => {
  const previousMap = { '2026-08-17::HISTORIE': tracked('uid-1', 'gammel') };
  const operations = [
    { type: 'replace', key: '2026-08-17::HISTORIE', contentHash: hashContent('ny'), oldUid: 'uid-1' },
  ];

  const map = nextMap({ previousMap, operations, unchangedKeys: [], results: {}, now: 'now' });

  assert.equal(map['2026-08-17::HISTORIE'].uid, 'uid-1');
  assert.equal(map['2026-08-17::HISTORIE'].contentHash, hashContent('gammel'));
});

test('a successful operation records the new uid and hash', () => {
  const operations = [
    { type: 'add', key: '2026-08-17::HISTORIE', contentHash: hashContent('ny') },
  ];

  const map = nextMap({
    previousMap: {},
    operations,
    unchangedKeys: [],
    results: { '2026-08-17::HISTORIE': 'uid-new' },
    now: 'now',
  });

  assert.equal(map['2026-08-17::HISTORIE'].uid, 'uid-new');
  assert.equal(map['2026-08-17::HISTORIE'].lastSeen, 'now');
});

test('items that vanish from the fetch are kept, not deleted (v1 behaviour)', () => {
  const previousMap = { '2026-08-01::GAMMEL': tracked('uid-old', 'x') };
  const { operations } = reconcile({
    items: [item('2026-08-17', 'HISTORIE', 'ny')],
    previousMap,
  });
  const map = nextMap({
    previousMap,
    operations,
    unchangedKeys: [],
    results: { '2026-08-17::HISTORIE': 'uid-new' },
    now: 'now',
  });

  assert.ok(map['2026-08-01::GAMMEL'], 'old entry survives');
});

test('itemKey matches the spec format', () => {
  assert.equal(itemKey(item('2026-08-17', 'HISTORIE', 'x')), '2026-08-17::HISTORIE');
});
