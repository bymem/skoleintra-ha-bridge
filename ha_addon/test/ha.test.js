import test from 'node:test';
import assert from 'node:assert/strict';
import { HomeAssistantClient } from '../src/ha.js';

// A stand-in HA that reproduces the behaviour observed against a real instance:
//   - todo.add_item accepts due_date and returns 200 with no body
//   - todo.get_items does NOT echo any due field back
//   - the response envelope carries changed_states beside service_response
function fakeHa({ entityId = 'todo.test', existingEntities = [entityId] } = {}) {
  const items = [];
  let nextUid = 1;

  const fetchStub = async (url, init = {}) => {
    const target = new URL(url);
    const body = init.body ? JSON.parse(init.body) : {};

    if (target.pathname.startsWith('/api/states/')) {
      const requested = decodeURIComponent(target.pathname.replace('/api/states/', ''));
      return new Response('', { status: existingEntities.includes(requested) ? 200 : 404 });
    }

    if (target.pathname === '/api/services/todo/get_items') {
      // due_date is deliberately stripped — this is the real behaviour that
      // broke uid resolution when it matched on due date.
      const visible = items.map(({ due_date: _omit, ...rest }) => rest);
      return Response.json({ changed_states: [], service_response: { [entityId]: { items: visible } } });
    }

    if (target.pathname === '/api/services/todo/add_item') {
      items.push({
        uid: `uid-${nextUid++}`,
        summary: body.item,
        status: 'needs_action',
        due_date: body.due_date,
      });
      return new Response('', { status: 200 });
    }

    if (target.pathname === '/api/services/todo/remove_item') {
      const index = items.findIndex((i) => i.uid === body.item);
      if (index === -1) {
        return new Response('not found', { status: 400 });
      }
      items.splice(index, 1);
      return new Response('', { status: 200 });
    }

    return new Response('', { status: 404 });
  };

  return { fetchStub, items };
}

function withStub(fetchStub, run) {
  const original = globalThis.fetch;
  globalThis.fetch = fetchStub;
  return run().finally(() => {
    globalThis.fetch = original;
  });
}

const client = () => new HomeAssistantClient({ baseUrl: 'http://ha.test/api', token: 't' });

test('addItem finds the new uid even though get_items omits due_date', async () => {
  const { fetchStub } = fakeHa();
  await withStub(fetchStub, async () => {
    const uid = await client().addItem('todo.test', {
      summary: 'HISTORIE',
      description: 'Læs s. 5-7',
      dueDate: '2026-08-17',
    });
    assert.equal(uid, 'uid-1');
  });
});

test('two items sharing a summary on different dates get distinct uids', async () => {
  // The real case: MATEMATIK appears on both the 12th and the 14th. Matching on
  // summary would return the same uid twice and corrupt the to-do map.
  const { fetchStub } = fakeHa();
  await withStub(fetchStub, async () => {
    const ha = client();
    const first = await ha.addItem('todo.test', { summary: 'MATEMATIK', dueDate: '2026-08-12' });
    const second = await ha.addItem('todo.test', { summary: 'MATEMATIK', dueDate: '2026-08-14' });

    assert.notEqual(first, second);
    assert.deepEqual([first, second], ['uid-1', 'uid-2']);
  });
});

test('addItem reports clearly when nothing new appears', async () => {
  const { fetchStub } = fakeHa();
  const swallowingStub = async (url, init) => {
    // add_item silently does nothing, as a rejected/ignored call would.
    if (new URL(url).pathname === '/api/services/todo/add_item') {
      return new Response('', { status: 200 });
    }
    return fetchStub(url, init);
  };
  await withStub(swallowingStub, async () => {
    await assert.rejects(
      () => client().addItem('todo.test', { summary: 'DANSK' }),
      /no new item appeared/,
    );
  });
});

test('removeItem deletes by uid, and the item is gone afterwards', async () => {
  const { fetchStub } = fakeHa();
  await withStub(fetchStub, async () => {
    const ha = client();
    const uid = await ha.addItem('todo.test', { summary: 'FYSIK' });
    await ha.removeItem('todo.test', uid);
    assert.deepEqual(await ha.getItems('todo.test'), []);
  });
});

test('getItems parses the envelope that carries changed_states', async () => {
  const { fetchStub } = fakeHa();
  await withStub(fetchStub, async () => {
    const ha = client();
    await ha.addItem('todo.test', { summary: 'GEOGRAFI' });
    const items = await ha.getItems('todo.test');
    assert.equal(items.length, 1);
    assert.equal(items[0].summary, 'GEOGRAFI');
  });
});

test('entityExists distinguishes a real list from a missing one', async () => {
  const { fetchStub } = fakeHa({ entityId: 'todo.real', existingEntities: ['todo.real'] });
  await withStub(fetchStub, async () => {
    const ha = client();
    assert.equal(await ha.entityExists('todo.real'), true);
    assert.equal(await ha.entityExists('todo.typo'), false);
  });
});

test('dry run never calls add_item for real', async () => {
  let called = false;
  const stub = async () => {
    called = true;
    return new Response('', { status: 200 });
  };
  const original = globalThis.fetch;
  globalThis.fetch = stub;
  try {
    const ha = new HomeAssistantClient({ baseUrl: 'http://ha.test/api', token: 't', dryRun: true, log: () => {} });
    const uid = await ha.addItem('todo.test', { summary: 'DANSK', dueDate: '2026-08-12' });
    assert.match(uid, /^dry-run-uid-/);
    assert.equal(called, false, 'dry run must not reach the network');
  } finally {
    globalThis.fetch = original;
  }
});
