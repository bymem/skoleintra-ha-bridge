// test-child-switch.mjs — throwaway diagnostic, not part of the bridge itself.
//
// Verifies whether overriding SkoleIntra's private `childUrl` field after
// authentication actually switches to a second child under the same login,
// and whether that override survives the way the real poller will use it
// (cookie warm-start on every cycle, not a fresh login each time).
//
// Setup:
//   npm init -y
//   npm install skoleintra
//
// Run:
//   SKOLEINTRA_USERNAME=... SKOLEINTRA_PASSWORD=... SKOLEINTRA_BASE_URL=https://MIN_SKOLE.m.skoleintra.dk node test-child-switch.mjs
//
// Before trusting the output: log into ForældreIntra in a normal browser
// first, note what each child's homework actually looks like this week, and
// compare that against what this script prints — a "different" result here
// doesn't by itself prove it's the *correct* other child's data rather than
// a login-fallback page that happened to parse as empty.

import SkoleIntra from 'skoleintra';

const {
  SKOLEINTRA_USERNAME: USERNAME,
  SKOLEINTRA_PASSWORD: PASSWORD,
  SKOLEINTRA_BASE_URL: BASE_URL,
} = process.env;

if (!USERNAME || !PASSWORD || !BASE_URL) {
  console.error('Missing env vars. Required: SKOLEINTRA_USERNAME, SKOLEINTRA_PASSWORD, SKOLEINTRA_BASE_URL');
  process.exit(1);
}

function summarize(plan) {
  return (plan.dailyPlans ?? []).map((d) => ({
    day: d.day,
    formattedDate: d.formattedDate,
    subjects: d.lessonPlans.map((l) => l.subject),
  }));
}

function print(label, plan) {
  console.log(`\n${label}`);
  console.log(JSON.stringify(summarize(plan), null, 2));
}

async function run() {
  console.log('=== Step 1: log in, fetch whatever child the site defaults to ===');
  const instance = new SkoleIntra(USERNAME, PASSWORD, BASE_URL);
  const defaultPlan = await instance.getWeeklyPlan(new Date());
  print('Default plan (compare against the browser for whichever child this login normally lands on):', defaultPlan);

  console.log('\n=== Step 2: override childUrl AFTER authentication, same instance ===');
  instance.childUrl = 'parent/1/navn'; // plain JS — private is TS-only, no cast needed
  const overriddenPlan = await instance.getWeeklyPlan(new Date());
  print('Overridden plan (compare against the browser for the OTHER child):', overriddenPlan);

  const defaultJson = JSON.stringify(summarize(defaultPlan));
  const overriddenJson = JSON.stringify(summarize(overriddenPlan));
  const overriddenIsEmpty = summarize(overriddenPlan).every((d) => d.subjects.length === 0);

  console.log('\n=== Verdict ===');
  if (overriddenIsEmpty) {
    console.log(
      'Overridden plan came back EMPTY — inconclusive on its own. Could mean genuinely no ' +
      'homework this week for that child, or the URL guess silently failed. Cross-check ' +
      'against the browser before trusting either interpretation.'
    );
  } else if (defaultJson === overriddenJson) {
    console.log(
      'Plans are IDENTICAL. Since both children are confirmed to be on this one login, this ' +
      'means the URL guess silently failed and re-resolved to the same default child rather ' +
      'than switching. Check the raw HTTP response/status, and try other index/URL shapes ' +
      'based on what the browser check showed.'
    );
  } else {
    console.log(
      'Plans DIFFER — promising. Now manually confirm the overridden plan\'s subjects ' +
      'actually match what the browser showed for the second child, not just that something changed.'
    );
  }

  console.log('\n=== Step 3: fresh instance, no override — confirm no bleed-over from Step 2 ===');
  const freshInstance = new SkoleIntra(USERNAME, PASSWORD, BASE_URL);
  const freshPlan = await freshInstance.getWeeklyPlan(new Date());
  const freshMatchesDefault = JSON.stringify(summarize(freshPlan)) === defaultJson;
  console.log(
    freshMatchesDefault
      ? 'Fresh instance matches the original default — good, no session pinning from the earlier override.'
      : 'Fresh instance DOES NOT match the original default — investigate before relying on this pattern.'
  );

  console.log('\n=== Step 4: cookie warm-start — matches how the real poller will actually run ===');
  const cookies = await instance.getCookies();
  const warmInstance = new SkoleIntra(USERNAME, PASSWORD, BASE_URL);
  await warmInstance.setCookies(cookies);
  warmInstance.childUrl = 'parent/1/navn';
  const warmPlan = await warmInstance.getWeeklyPlan(new Date());
  const warmMatches = JSON.stringify(summarize(warmPlan)) === overriddenJson;
  console.log(
    warmMatches
      ? 'Warm-started instance (cookies loaded from disk, no fresh login) matches Step 2 — ' +
        'this is the pattern the real poller should use on every cycle.'
      : 'Warm-started instance DOES NOT match Step 2 — the override may only work right after ' +
        'a fresh login, which would need a different approach in the real poller.'
  );

  console.log('\nDone. Re-run with childUrl set to \'parent/0/navn\' explicitly too, as a sanity check that it still returns the first child correctly when set explicitly rather than left at its default.');
}

run().catch((err) => {
  console.error('\nScript failed:', err);
  console.error(
    'If this is "Request was blocked by automation protection": log into ForældreIntra in a ' +
    'normal browser first, then retry — the library\'s own README recommends this to reduce blocks.'
  );
  process.exit(1);
});
