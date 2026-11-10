const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
const data = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'fleet.json'), 'utf8'));
const clone = value => JSON.parse(JSON.stringify(value));
const vessel = () => clone(data.find(v => v.id === 'mi-lan'));
const response = body => ({ ok: true, json: async () => clone(body) });

// Execute the shipping inline source, not a separate copy of its implementation.
function setup({ stored, selected = 'mi-lan', fetch = async () => response(data) } = {}) {
  const storage = new Map();
  if (stored !== undefined) storage.set('pickle_fleet_data_v10', JSON.stringify(stored));
  storage.set('pickle_selected_vessel', selected);
  const handlers = new Map();
  const classes = new Set();
  const attributes = new Map();
  const button = {
    disabled: false,
    classList: { add: k => classes.add(k), remove: k => classes.delete(k) },
    setAttribute: (k, v) => attributes.set(k, v), removeAttribute: k => attributes.delete(k),
    addEventListener: (k, fn) => handlers.set(k, fn)
  };
  const status = { textContent: '' };
  const timers = new Map();
  let timerId = 0;
  let renders = 0;
  let views = 0;
  const context = vm.createContext({
    defaultFleet: [vessel()],
    localStorage: { getItem: k => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, v) },
    document: { getElementById: id => id === 'btnRefresh' ? button : status },
    window: {}, map: null, AbortController, fetch,
    console: { warn() {} },
    setTimeout: (fn, ms) => { timers.set(++timerId, { fn, ms }); return timerId; },
    clearTimeout: id => timers.delete(id),
    renderChips: () => { renders++; },
    updateView: () => { views++; }
  });
  const loadStart = script.includes('function isValidFleetVessel') ? script.indexOf('function isValidFleetVessel') : script.indexOf('let fleetData = []');
  const syncStart = script.includes('let fleetSyncPromise') ? script.indexOf('let fleetSyncPromise') : script.indexOf('async function syncFleetFromNetwork');
  vm.runInContext(script.slice(loadStart, script.indexOf('// Leaflet 지도')), context);
  vm.runInContext(script.slice(syncStart, script.indexOf("if ('caches' in window)")), context);
  return {
    context, storage, button, status, classes, attributes, timers,
    click: () => handlers.get('click')(),
    sync: () => vm.runInContext('syncFleetFromNetwork()', context),
    state: () => JSON.parse(vm.runInContext('JSON.stringify({fleetData, currentVessel})', context)),
    renders: () => renders, views: () => views,
    finishTimers: () => {
      for (const [id, timer] of [...timers]) if (timer.ms < 12000) { timers.delete(id); timer.fn(); }
    }
  };
}

test('shipping JavaScript parses and shipped fleet passes validation', () => {
  new vm.Script(script);
  const app = setup();
  for (const v of data) {
    app.context.record = v;
    assert.equal(vm.runInContext('isValidFleetVessel(record)', app.context), true, v.id);
  }
});

test('refresh keeps server coordinates, speed, route and ETA instead of bundled defaults', async () => {
  const remote = { ...vessel(), lat: 39.8765, lon: 121.2345, speed: 6.2, dest: { ...vessel().dest, eta: '새 ETA' }, futureRoute: [[39.8765, 121.2345], [40.71, 122.05]] };
  const app = setup({ fetch: async () => response([remote]) });
  await app.click();
  app.finishTimers();
  assert.deepEqual(app.state().currentVessel, remote);
  assert.deepEqual(JSON.parse(app.storage.get('pickle_fleet_data_v10'))[0], remote);
  assert.match(app.status.textContent, /동기화 완료/);
  assert.equal(app.renders(), 1);
  assert.equal(app.button.disabled, false);
  assert.equal(app.classes.has('spinning'), false);
});

test('reload keeps saved latest values when network fails', async () => {
  const saved = { ...vessel(), lat: 39.1234, speed: 3.4 };
  const app = setup({ stored: [saved], fetch: async () => { throw new Error('offline'); } });
  assert.deepEqual(app.state().currentVessel, saved);
  await app.click();
  app.finishTimers();
  assert.deepEqual(app.state().currentVessel, saved);
  assert.match(app.status.textContent, /갱신하지 못했습니다/);
  assert.doesNotMatch(app.status.textContent, /완료/);
  assert.equal(app.views(), 0);
});

test('custom vessels and current selection survive server updates and added vessels render', async () => {
  const custom = { ...vessel(), id: 'custom-1', imo: '1234567', name: 'MY SHIP' };
  const app = setup({ stored: [vessel(), custom], selected: custom.id });
  await app.click();
  assert.deepEqual(app.state().currentVessel, custom);
  assert.equal(app.state().fleetData.length, data.length + 1);
  assert.equal(app.renders(), 1);
});

test('selection follows a matching IMO when server changes the vessel ID', async () => {
  const renamed = { ...vessel(), id: 'mi-lan-new', lat: 39.9 };
  const app = setup({ fetch: async () => response([renamed]) });
  await app.click();
  assert.equal(app.state().fleetData.length, 1);
  assert.equal(app.state().currentVessel.id, renamed.id);
});

test('server record replaces old DR state when no new base fix is supplied', async () => {
  const saved = { ...vessel(), baseFix: { time: '2026-11-01T00:00:00Z', lat: 30, lon: 120 }, drActive: true, computedEta: 'old ETA' };
  const app = setup({ stored: [saved], fetch: async () => response([vessel()]) });
  await app.click();
  assert.equal(app.state().currentVessel.baseFix, undefined);
  assert.equal(app.state().currentVessel.drActive, undefined);
  assert.equal(app.state().currentVessel.computedEta, undefined);
});

for (const [name, fetch] of [
  ['HTTP failure', async () => ({ ok: false, status: 503 })],
  ['invalid JSON', async () => ({ ok: true, json: async () => { throw new SyntaxError('bad JSON'); } })],
  ['empty data', async () => response([])],
  ['non-array data', async () => response({ error: 'not a fleet' })],
  ['invalid record after valid record', async () => response([{ ...vessel(), lat: 39.1 }, { id: 'broken' }])],
  ['invalid coordinates', async () => response([{ ...vessel(), lat: 999 }])],
  ['invalid route', async () => response([{ ...vessel(), futureRoute: [['bad', 120]] }])],
  ['duplicate identity', async () => response([vessel(), { ...vessel(), lat: 39.2 }])],
  ['rejected request', async () => { throw new Error('offline'); }]
]) {
  test(`${name} leaves data unchanged, reports failure and unlocks refresh`, async () => {
    const app = setup({ fetch });
    const before = app.state();
    await app.click();
    app.finishTimers();
    assert.deepEqual(app.state(), before);
    assert.match(app.status.textContent, /갱신하지 못했습니다/);
    assert.doesNotMatch(app.status.textContent, /동기화 완료/);
    assert.equal(app.views(), 0);
    assert.equal(app.button.disabled, false);
    assert.equal(app.classes.has('spinning'), false);
    assert.equal(app.attributes.has('aria-busy'), false);
  });
}

test('startup and repeated refresh clicks share one in-flight request', async () => {
  let resolve;
  let calls = 0;
  const app = setup({ fetch: () => { calls++; return new Promise(r => { resolve = r; }); } });
  const startup = app.sync();
  const manual = app.click();
  await app.click();
  assert.equal(calls, 1);
  assert.equal(app.button.disabled, true);
  resolve(response([{ ...vessel(), lat: 39.5 }]));
  await Promise.all([startup, manual]);
  assert.equal(app.state().currentVessel.lat, 39.5);
  assert.equal(app.button.disabled, false);
});

test('request timeout aborts, retains data, and allows a later successful retry', async () => {
  let calls = 0;
  const app = setup({ fetch: (url, options) => {
    calls++;
    assert.equal(options.cache, 'no-store');
    assert.match(url, /^fleet\.json\?t=/);
    if (calls > 1) return Promise.resolve(response([{ ...vessel(), lat: 39.6 }]));
    return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('timeout'))));
  } });
  const pending = app.click();
  [...app.timers.values()].find(t => t.ms === 12000).fn();
  await pending;
  assert.match(app.status.textContent, /갱신하지 못했습니다/);
  assert.equal(app.button.disabled, false);
  await app.click();
  assert.equal(app.state().currentVessel.lat, 39.6);
  assert.equal(calls, 2);
});

test('corrupt stored data cannot crash startup', () => {
  for (const stored of [{}, [null], [{ id: 'incomplete' }], 'not an array']) {
    const app = setup({ stored });
    assert.deepEqual(app.state().currentVessel, vessel());
  }
});

test('all named vessel briefings use the actual record coordinates', () => {
  const context = vm.createContext({ window: {} });
  vm.runInContext(script.slice(script.indexOf('function formatSpeedAnalysis'), script.indexOf('function updateView()')), context);
  for (const record of [...data, { ...vessel(), id: 'grace-sambu', name: 'GRACE SAMBU' }]) {
    context.vessel = { ...record, lat: 38.1234, lon: 125.5678 };
    const text = vm.runInContext('generateDynamicBriefing(vessel)[0].text', context);
    assert.match(text, /38\.12/);
    assert.match(text, /125\.56|125\.57/);
  }
});
