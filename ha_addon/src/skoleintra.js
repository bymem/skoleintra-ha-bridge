// SkoleIntra access layer.
//
// IMPORTANT — this does NOT use the skoleintra package's data methods.
// That package only scrapes the "Ugeplaner" module, which this school has never
// published to (the site states "Der er ingen ugeplaner for <class> i skoleåret
// <year>", and a sweep of a full term's ISO weeks returned nothing for any child).
//
// The homework actually lives in the "Lektiebog" tab — a diary with a numeric id
// per class, which the package has no method for:
//     /parent/{childId}/{name}item/weeklyplansandhomework/diary/notes/{diaryId}
//
// So the package is used for LOGIN ONLY (it handles the SAML + noscript form
// dance correctly, which is the fiddly part), and we drive its authenticated
// axios instance ourselves for the diary pages.
//
// URL shape note: there is deliberately no separator before "item" —
// `parent/{childId}/{name}` + `item/weeklyplansandhomework/...`. That looks like
// a bug but mirrors the site's own menu links; inserting a slash returns a 404.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { parse } from 'node-html-parser';
import SkoleIntraModule from 'skoleintra';

// Published as CommonJS (`exports.default = SkoleIntra`); a default import from
// ESM binds the module object rather than the class.
const SkoleIntra = SkoleIntraModule.default ?? SkoleIntraModule;

const DA_MONTHS = {
  jan: 1, feb: 2, mar: 3, apr: 4, maj: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, okt: 10, nov: 11, dec: 12,
};

// The teachers' CKEditor content is full of HTML entities and node-html-parser's
// innerText leaves them encoded. This text goes straight into a to-do
// description, so decode generally rather than entity-by-entity.
const NAMED_ENTITIES = {
  nbsp: ' ', amp: '&', quot: '"', apos: "'", lt: '<', gt: '>',
  aring: 'å', Aring: 'Å', oslash: 'ø', Oslash: 'Ø', aelig: 'æ', AElig: 'Æ',
  eacute: 'é', egrave: 'è', uuml: 'ü', ouml: 'ö', auml: 'ä', hellip: '…',
  ndash: '–', mdash: '—', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”',
};

export function decodeEntities(text) {
  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, body) => {
    if (body[0] === '#') {
      const code = body[1].toLowerCase() === 'x'
        ? parseInt(body.slice(2), 16)
        : parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return NAMED_ENTITIES[body] ?? NAMED_ENTITIES[body.toLowerCase()] ?? match;
  });
}

function clean(node) {
  return decodeEntities(node.innerText).replace(/\s+/g, ' ').trim();
}

// "Mandag, 17. aug. 2026:" -> "2026-08-17"
export function parseDanishDate(heading) {
  const match = /(\d{1,2})\.\s*([a-zæøå]+)\.?\s*(\d{4})/i.exec(decodeEntities(heading));
  if (!match) {
    return null;
  }
  const month = DA_MONTHS[match[2].slice(0, 3).toLowerCase()];
  if (!month) {
    return null;
  }
  const day = String(Number(match[1])).padStart(2, '0');
  return `${match[3]}-${String(month).padStart(2, '0')}-${day}`;
}

// Turn one diary note into homework items.
//
// Both current classes use a two-column FAG/LEKTIER table, but that is a
// per-teacher convention rather than a schema — so when there is no usable
// table we keep the note whole instead of silently returning nothing.
export function itemsFromNote(noteEl, date) {
  const table = noteEl.querySelector('table');

  if (table) {
    const items = [];
    for (const row of table.querySelectorAll('tr')) {
      const cells = row.querySelectorAll('td, th');
      if (cells.length < 2) {
        continue;
      }
      const subject = clean(cells[0]);
      const homework = clean(cells[1]);
      // Drop the header row and subjects with nothing assigned.
      if (!subject || !homework || /^FAG$/i.test(subject) || /^LEKTIER$/i.test(homework)) {
        continue;
      }
      items.push({ date, subject, homework });
    }
    if (items.length > 0) {
      return items;
    }
    // A table with no homework in it (start of term, "no homework today").
    // Whatever the teacher wrote around it may still be worth keeping, but the
    // empty grid of subject names is not — drop it before falling back.
    table.remove();
  }

  const remaining = clean(noteEl);
  return remaining ? [{ date, subject: 'Lektier', homework: remaining }] : [];
}

export class SkoleIntraClient {
  constructor({ baseUrl, username, password, cookieFile }) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.cookieFile = cookieFile;
    this.instance = new SkoleIntra(username, password, this.baseUrl);
    this.authenticated = false;
  }

  // Restore a previous session if we have one. The library's README recommends
  // reusing cookies to avoid tripping automation protection, so treat this as
  // required rather than an optimisation.
  async restoreSession() {
    if (!this.cookieFile || !existsSync(this.cookieFile)) {
      return false;
    }
    const cookies = readFileSync(this.cookieFile, 'utf8').trim();
    if (!cookies) {
      return false;
    }
    await this.instance.setCookies(cookies);
    this.authenticated = true;
    return true;
  }

  async persistSession() {
    if (!this.cookieFile) {
      return;
    }
    mkdirSync(dirname(this.cookieFile), { recursive: true });
    writeFileSync(this.cookieFile, await this.instance.getCookies());
  }

  async login() {
    const ok = await this.instance.authenticate();
    if (!ok) {
      throw new Error('SkoleIntra authentication failed — credentials rejected or the login form changed.');
    }
    this.authenticated = true;
    await this.persistSession();
  }

  static looksLikeLoginPage(html) {
    return !!parse(html).getElementById('UserName');
  }

  // GET a path under the base URL, logging in and retrying once if the stored
  // session has expired.
  async get(path) {
    if (!this.authenticated) {
      await this.login();
    }
    let response = await this.instance.axiosInstance.get(`${this.baseUrl}/${path}`);

    if (SkoleIntraClient.looksLikeLoginPage(response.data)) {
      await this.login();
      response = await this.instance.axiosInstance.get(`${this.baseUrl}/${path}`);
      if (SkoleIntraClient.looksLikeLoginPage(response.data)) {
        throw new Error(`Still unauthenticated after re-login while fetching ${path}`);
      }
    }

    // The library's own automation-protection heuristic: a 500 whose body is a
    // bare one-h1/one-h2 error page.
    if (response.status === 500) {
      throw new Error(
        'Request appears to have been blocked by automation protection. ' +
        'Log in via a normal browser, then seed the cookie file from that session.',
      );
    }
    return response.data;
  }

  // Each class's Lektiebog has its own numeric diary id. It is stable, but
  // discovering it costs one request and avoids hard-coding a value that would
  // silently break at a class change.
  async discoverDiaryId(childPath) {
    const html = await this.get(`${childPath}item/weeklyplansandhomework/diary`);
    return /diary\/(?:notes\/)?(\d+)/.exec(html)?.[1] ?? null;
  }

  // One request returns every note in the site's current period, so this is a
  // single fetch per child per poll rather than one per date.
  async fetchHomework(childPath, diaryId) {
    const html = await this.get(`${childPath}item/weeklyplansandhomework/diary/notes/${diaryId}`);
    const container = parse(html).querySelector('#sk-diary-notes-container');
    if (!container) {
      throw new Error(`No diary notes container on the Lektiebog page for ${childPath}`);
    }

    const items = [];
    const datesSeen = [];
    for (const box of container.querySelectorAll('.sk-white-box')) {
      const date = parseDanishDate(clean(box).slice(0, 60));
      const body = box.querySelector('.sk-user-input');
      if (!date || !body) {
        continue;
      }
      datesSeen.push(date);
      items.push(...itemsFromNote(body, date));
    }
    return { items, datesSeen };
  }
}
