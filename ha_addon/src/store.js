// Flat-file persistence: the to-do map per child, and the activity log.
//
// The to-do map is the ONLY record of "have I already created this item in HA".
// If it's lost, the next poll treats everything as new and duplicates it — see
// the Known limitation in the spec. /data is covered by HA's own backups.

import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export class Store {
  // readOnly backs --dry-run. A dry run that persisted the map would record
  // fake uids and leave the first real run believing everything was synced.
  constructor(dataDir, { readOnly = false } = {}) {
    this.dataDir = dataDir;
    this.readOnly = readOnly;
    mkdirSync(dataDir, { recursive: true });
    this.logFile = join(dataDir, 'activity.log');
    this.maxLogLines = 1000;
  }

  mapPath(slug) {
    return join(this.dataDir, `todo-map-${slug}.json`);
  }

  readMap(slug) {
    const path = this.mapPath(slug);
    if (!existsSync(path)) {
      return {};
    }
    try {
      return JSON.parse(readFileSync(path, 'utf8'));
    } catch (error) {
      // A corrupt map would otherwise cause mass duplication on the next poll,
      // so fail loudly rather than silently starting from scratch.
      throw new Error(`Corrupt to-do map at ${path}: ${error.message}`);
    }
  }

  writeMap(slug, map) {
    if (this.readOnly) {
      return;
    }
    writeFileSync(this.mapPath(slug), JSON.stringify(map, null, 2));
  }

  cookiePath() {
    return join(this.dataDir, 'cookies.txt');
  }

  // Audit trail. Answers "did the bridge touch this, or did a person?", which
  // HA's own Logbook can't tell you on its own — it records that an item was
  // removed and re-added, not that the bridge decided to because the content
  // hash changed.
  append(line) {
    const stamped = `${new Date().toISOString()}  ${line}`;
    if (this.readOnly) {
      return stamped;
    }
    appendFileSync(this.logFile, `${stamped}\n`);
    this.truncate();
    return stamped;
  }

  truncate() {
    if (!existsSync(this.logFile)) {
      return;
    }
    const lines = readFileSync(this.logFile, 'utf8').split('\n');
    if (lines.length > this.maxLogLines * 1.2) {
      writeFileSync(this.logFile, lines.slice(-this.maxLogLines).join('\n'));
    }
  }
}
