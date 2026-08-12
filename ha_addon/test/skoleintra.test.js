import test from 'node:test';
import assert from 'node:assert/strict';
import { parse } from 'node-html-parser';
import { itemsFromNote, parseDanishDate, decodeEntities, dropPastItems, localIsoDate } from '../src/skoleintra.js';

// Shaped like the real thing: a teacher-authored CKEditor table, complete with
// the `widht` typo that is actually in the live markup.
function noteWithTable(rows) {
  const body = rows
    .map(([subject, homework]) => `<tr><td><div>${subject}</div><div>&nbsp;</div></td><td>${homework}</td></tr>`)
    .join('');
  return parse(`
    <div class="sk-user-input">
      <table border="1" cellpadding="8">
        <tbody>
          <tr bgcolor="#ffff80"><td width="20%"><strong>FAG</strong></td><td widht="80%"><strong>LEKTIER</strong></td></tr>
          ${body}
        </tbody>
      </table>
    </div>
  `).querySelector('.sk-user-input');
}

test('parses a FAG/LEKTIER table into one item per subject with homework', () => {
  const note = noteWithTable([
    ['DANSK', '&nbsp;'],
    ['MATEMATIK', 'Multi grundbog s. 8-9 opg. 6+7+8'],
    ['HISTORIE', 'Medbring: Historie 5'],
  ]);

  const items = itemsFromNote(note, '2026-08-12');

  assert.equal(items.length, 2, 'subjects with no homework are skipped');
  assert.deepEqual(items.map((i) => i.subject), ['MATEMATIK', 'HISTORIE']);
  assert.equal(items[0].homework, 'Multi grundbog s. 8-9 opg. 6+7+8');
  assert.equal(items[0].date, '2026-08-12');
});

test('the FAG/LEKTIER header row is never emitted as homework', () => {
  const items = itemsFromNote(noteWithTable([['DANSK', 'Læs bogen']]), '2026-08-12');
  assert.ok(!items.some((i) => i.subject === 'FAG'));
});

test('an empty table is dropped rather than dumped as one giant item', () => {
  // Start of term: intro text, and a table with every subject blank. The
  // subject names must not end up in the to-do description.
  const note = parse(`
    <div class="sk-user-input">
      <p>VELKOMMEN TILBAGE FRA SOMMERFERIE. I m&oslash;der kl. 10-11 i dag.</p>
      <table><tbody>
        <tr><td>FAG</td><td>LEKTIER</td></tr>
        <tr><td>DANSK</td><td>&nbsp;</td></tr>
        <tr><td>MATEMATIK</td><td>&nbsp;</td></tr>
      </tbody></table>
    </div>
  `).querySelector('.sk-user-input');

  const items = itemsFromNote(note, '2026-08-10');

  assert.equal(items.length, 1);
  assert.equal(items[0].subject, 'Lektier');
  assert.ok(items[0].homework.includes('VELKOMMEN TILBAGE'));
  assert.ok(!items[0].homework.includes('MATEMATIK'), 'empty table skeleton must not leak in');
});

test('a note with no table at all is kept whole', () => {
  const note = parse('<div class="sk-user-input"><p>Husk gymnastikt&oslash;j p&aring; fredag</p></div>')
    .querySelector('.sk-user-input');

  const items = itemsFromNote(note, '2026-08-12');

  assert.equal(items.length, 1);
  assert.equal(items[0].subject, 'Lektier');
  assert.equal(items[0].homework, 'Husk gymnastiktøj på fredag');
});

test('an entirely empty note produces nothing', () => {
  const note = parse('<div class="sk-user-input">&nbsp;</div>').querySelector('.sk-user-input');
  assert.deepEqual(itemsFromNote(note, '2026-08-12'), []);
});

// --- Danish dates --------------------------------------------------------

test('parses Danish date headings', () => {
  assert.equal(parseDanishDate('Mandag, 17. aug. 2026:'), '2026-08-17');
  assert.equal(parseDanishDate('Fredag, 1. maj 2026:'), '2026-05-01');
  assert.equal(parseDanishDate('Torsdag, 19. apr. 2027:'), '2027-04-19');
});

test('every Danish month abbreviation is understood', () => {
  const months = ['jan', 'feb', 'mar', 'apr', 'maj', 'jun', 'jul', 'aug', 'sep', 'okt', 'nov', 'dec'];
  months.forEach((month, index) => {
    assert.equal(
      parseDanishDate(`Mandag, 5. ${month}. 2026:`),
      `2026-${String(index + 1).padStart(2, '0')}-05`,
      `${month} should map to month ${index + 1}`,
    );
  });
});

test('a heading with no date returns null rather than a wrong date', () => {
  assert.equal(parseDanishDate('LEKTIEBOG FEMTE KLASSE'), null);
});

// --- Entities ------------------------------------------------------------

test('decodes the entities that actually appear in teacher content', () => {
  assert.equal(decodeEntities('&quot;overset nyhed&quot;'), '"overset nyhed"');
  assert.equal(decodeEntities('arbejdssp&oslash;rgsm&aring;lene'), 'arbejdsspørgsmålene');
  assert.equal(decodeEntities('H&Aring;NDV&AElig;RK'), 'HÅNDVÆRK');
  assert.equal(decodeEntities('&#248;velse'), 'øvelse');
  assert.equal(decodeEntities('a &amp; b'), 'a & b');
});

test('unknown entities are left alone rather than mangled', () => {
  assert.equal(decodeEntities('&notarealentity;'), '&notarealentity;');
});

// --- Past-dated homework -------------------------------------------------

test('homework dated before today is dropped', () => {
  const items = [
    { date: '2026-08-10', subject: 'DANSK', homework: 'a' },
    { date: '2026-08-11', subject: 'ENGELSK', homework: 'b' },
    { date: '2026-08-12', subject: 'MATEMATIK', homework: 'c' },
    { date: '2026-08-17', subject: 'HISTORIE', homework: 'd' },
  ];

  const kept = dropPastItems(items, '2026-08-12');

  assert.deepEqual(kept.map((i) => i.date), ['2026-08-12', '2026-08-17']);
});

test("today's homework is kept — the morning poll runs before school", () => {
  const items = [{ date: '2026-08-12', subject: 'MATEMATIK', homework: 'c' }];
  assert.equal(dropPastItems(items, '2026-08-12').length, 1);
});

test('dropping past items across a month and year boundary', () => {
  const items = [
    { date: '2026-08-31', subject: 'A', homework: 'x' },
    { date: '2026-09-01', subject: 'B', homework: 'x' },
    { date: '2026-12-31', subject: 'C', homework: 'x' },
    { date: '2027-01-04', subject: 'D', homework: 'x' },
  ];
  assert.deepEqual(dropPastItems(items, '2026-09-01').map((i) => i.subject), ['B', 'C', 'D']);
  assert.deepEqual(dropPastItems(items, '2027-01-01').map((i) => i.subject), ['D']);
});

test('localIsoDate uses local time, not UTC', () => {
  // Late evening local time is already the next day in UTC. Using toISOString()
  // here would skip a whole day of homework for anyone east of Greenwich.
  const lateEvening = new Date(2026, 7, 12, 23, 30, 0);
  assert.equal(localIsoDate(lateEvening), '2026-08-12');
});

test('localIsoDate zero-pads single-digit months and days', () => {
  assert.equal(localIsoDate(new Date(2026, 0, 5)), '2026-01-05');
});
