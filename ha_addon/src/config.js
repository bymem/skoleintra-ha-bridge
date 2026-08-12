// Configuration loading.
//
// Inside an HA App the Supervisor writes the saved options to /data/options.json
// whenever the config form is submitted, so there is nothing to parse from the
// shell. Locally, a hand-written options.json in the repo root stands in for it.
//
// Secrets may also come from the environment, which is how the local dev setup
// keeps credentials out of a file that's easy to commit by accident.

import { existsSync, readFileSync } from 'node:fs';

const DEFAULTS = {
  poll_cron: '0 6,13,17 * * 1-5',
  data_dir: '/data',
  // "poll" runs normally; "verify" checks the HA to-do API and exits, which is
  // how a fresh App install confirms src/ha.js against a real instance.
  run_mode: 'poll',
  sanity_brake: {
    enabled: true,
    min_changes: 3,
    max_change_ratio: 0.5,
  },
};

export function loadConfig({ env = process.env, explicitPath } = {}) {
  const candidates = [
    explicitPath,
    env.OPTIONS_FILE,
    '/data/options.json',
    new URL('../options.json', import.meta.url).pathname,
  ].filter(Boolean);

  const path = candidates.find((candidate) => existsSync(candidate));
  if (!path) {
    throw new Error(`No options file found. Looked in: ${candidates.join(', ')}`);
  }

  const options = JSON.parse(readFileSync(path, 'utf8'));
  const config = {
    ...DEFAULTS,
    ...options,
    sanity_brake: { ...DEFAULTS.sanity_brake, ...(options.sanity_brake ?? {}) },
    // Env wins so local runs don't need credentials written to disk.
    username: env.SKOLEINTRA_USERNAME || options.username,
    password: env.SKOLEINTRA_PASSWORD || options.password,
    base_url: env.SKOLEINTRA_BASE_URL || options.base_url,
    sourcePath: path,
  };

  const missing = ['username', 'password', 'base_url'].filter((key) => !config[key]);
  if (missing.length) {
    throw new Error(`Missing required config: ${missing.join(', ')}`);
  }
  if (!Array.isArray(config.children) || config.children.length === 0) {
    throw new Error('Config must define at least one child.');
  }
  for (const child of config.children) {
    for (const key of ['slug', 'name', 'child_path_segment', 'ha_todo_entity']) {
      if (!child[key]) {
        throw new Error(`Child ${child.slug ?? '(unnamed)'} is missing "${key}".`);
      }
    }
  }

  return config;
}
