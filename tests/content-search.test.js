const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');
const metadata = require('../src/metadata');

// Execute the production content script with a controlled page and clock.
// Only replace browser startup and DOM lookup boundaries; search, fallback,
// picker completion and resource advancement run their real implementations.
const rootDir = path.resolve(__dirname, '..');
const source = process.env.CVM_TEST_CONTENT_REF
  ? execFileSync('git', ['show', `${process.env.CVM_TEST_CONTENT_REF}:src/content.js`], { cwd: rootDir, encoding: 'utf8' })
  : fs.readFileSync(path.join(rootDir, 'src/content.js'), 'utf8');
const startup = "  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });\n  else init();";

async function flush() {
  for (let index = 0; index < 20; index += 1) await Promise.resolve();
}

function harness() {
  const timers = new Map();
  let now = 0;
  let timerId = 0;
  const clock = {
    setTimeout(callback, delay = 0) {
      const id = ++timerId;
      timers.set(id, { callback, at: now + delay });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
    async advance(ms) {
      const end = now + ms;
      await flush();
      while (true) {
        const next = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        now = next[1].at;
        timers.delete(next[0]);
        next[1].callback();
        await flush();
      }
      now = end;
      await flush();
    }
  };
  const observers = new Set();
  class Observer {
    constructor(callback) { this.callback = callback; }
    observe() { observers.add(this); }
    disconnect() { observers.delete(this); }
  }
  const loader = {
    isConnected: true,
    getClientRects: () => [{}],
    matches: (selector) => selector.includes('.mantine-Loader-root')
  };
  const pickerRoot = {
    isConnected: true,
    textContent: '',
    loading: false,
    card: null,
    getClientRects() { return this.isConnected ? [{}] : []; },
    matches: () => false,
    contains(node) { return node === this || node?.parentElement === this; },
    querySelector: () => null,
    querySelectorAll(selector) { return this.loading && selector.includes('.mantine-Loader-root') ? [loader] : []; }
  };
  const input = { value: '', isConnected: true, parentElement: pickerRoot };
  const resourcePanel = { ...pickerRoot, loading: false };
  const queries = [];
  const selections = [];
  let open = false;
  const notify = (target = pickerRoot, addedNodes = [], removedNodes = []) => {
    for (const observer of [...observers]) observer.callback([{ target, addedNodes, removedNodes }]);
  };
  const button = {
    disabled: false,
    getAttribute: () => null,
    click() {
      open = true;
      pickerRoot.isConnected = true;
      pickerRoot.textContent = '';
      pickerRoot.loading = false;
      pickerRoot.card = null;
      input.value = '';
      notify();
    }
  };
  const context = vm.createContext({
    CVMMetadata: metadata,
    localStorage: { getItem: () => null },
    window: clock,
    document: { documentElement: {}, querySelectorAll: () => [], getElementById: () => null },
    MutationObserver: Observer,
    getComputedStyle: () => ({ visibility: 'visible' }),
    location: { href: 'https://civitai.red/posts/123/edit' }
  });
  const seam = `
  globalThis.testAPI = {
    state, searchPickerOnce, searchPickerWithFallbacks, addResources,
    hooks(hooks) {
      render = hooks.render;
      dispatchInput = hooks.dispatchInput;
      resourcePickerRoot = hooks.resourcePickerRoot;
      resourceCardFor = hooks.resourceCardFor;
      exactResourceSelectButton = hooks.exactResourceSelectButton;
      findSearchInput = hooks.findSearchInput;
      findResourceButton = hooks.findResourceButton;
      resourceSectionRoot = hooks.resourceSectionRoot;
      markAlreadyAttachedResources = () => [];
      prepareAttachedResources = async () => true;
    }
  };`;
  const normalized = source.replace(/\r\n/g, '\n');
  assert.equal(normalized.includes(startup), true, 'content-script startup seam must still match');
  vm.runInContext(normalized.replace(startup, seam), context);
  const api = context.testAPI;
  const h = { api, clock, pickerRoot, input, queries, selections, notify, onQuery: null, selectManually: false };
  const close = () => {
    open = false;
    pickerRoot.isConnected = false;
    notify();
  };
  h.close = close;
  api.hooks({
    render: () => {},
    dispatchInput(field, query) {
      field.value = query;
      queries.push(query);
      h.onQuery?.(query);
      Promise.resolve().then(() => notify());
    },
    resourcePickerRoot: () => open ? pickerRoot : null,
    resourceCardFor: (root) => root.card,
    async exactResourceSelectButton(root, resource) {
      if (!root.card) return null;
      selections.push(resource.modelVersionId);
      if (h.selectManually) return null;
      return { click: close };
    },
    findSearchInput: () => input,
    findResourceButton: () => button,
    resourceSectionRoot: () => resourcePanel
  });
  Object.assign(api.state, { fileKey: 'video.mp4:100:1', scanToken: 1, resourceAutomationActive: true });
  return h;
}

const first = { modelVersionId: 101, hash: 'ABCDEF1234', lookup: { id: 101, name: 'v1', model: { name: 'First model' } } };
const second = { modelVersionId: 102, hash: '123456ABCD', lookup: { id: 102, name: 'v1', model: { name: 'Second model' } } };

test('a visible loader prevents an empty hash response from falling back', async () => {
  const h = harness();
  h.pickerRoot.loading = true;
  const result = h.api.searchPickerOnce({ root: h.pickerRoot, input: h.input }, first, { query: first.hash });
  let settled = false;
  result.then(() => { settled = true; });
  h.pickerRoot.textContent = 'No models found';
  h.notify();
  await h.clock.advance(5000);
  assert.equal(settled, false, 'empty text during loading is not a completed response');
  h.pickerRoot.loading = false;
  h.pickerRoot.textContent = 'First model';
  h.pickerRoot.card = {};
  h.notify();
  assert.equal((await result).type, 'match');
});

test('unrelated page mutations cannot turn the initial empty state into a search failure', async () => {
  const h = harness();
  h.pickerRoot.textContent = 'No models found';
  const result = h.api.searchPickerOnce({ root: h.pickerRoot, input: h.input }, first, { query: first.hash });
  let settled = false;
  result.then(() => { settled = true; });
  h.notify({}, [], [{ textContent: 'No models found' }]);
  await h.clock.advance(5000);
  assert.equal(settled, false);
  h.pickerRoot.loading = true;
  h.notify();
  h.pickerRoot.loading = false;
  h.notify();
  await h.clock.advance(750);
  assert.equal((await result).type, 'empty');
});

test('completed empty hash search falls back by name and starts the next resource automatically', async () => {
  const h = harness();
  h.api.state.resources = [first, second];
  h.onQuery = () => { h.pickerRoot.loading = true; };
  const adding = h.api.addResources({ autoSelect: true });
  await flush();
  assert.deepEqual(h.queries, [first.hash]);
  h.pickerRoot.textContent = 'No models found';
  h.pickerRoot.loading = false;
  h.notify();
  await h.clock.advance(750);
  assert.deepEqual(h.queries, [first.hash, 'First model']);
  h.pickerRoot.textContent = 'First model';
  h.pickerRoot.card = {};
  h.pickerRoot.loading = false;
  h.notify();
  await adding;
  await flush();
  assert.deepEqual(h.selections, [first.modelVersionId]);
  assert.deepEqual(h.queries, [first.hash, 'First model', second.hash]);
  assert.equal(h.api.state.resourceAutomationActive, true);
});

test('a search watchdog reports pending and still selects a late result before advancing', async () => {
  const h = harness();
  h.api.state.resources = [first, second];
  h.onQuery = () => { h.pickerRoot.loading = true; };
  const adding = h.api.addResources({ autoSelect: true });
  await flush();
  await h.clock.advance(90000);
  await adding;
  assert.match(h.api.state.message, /still searching/i);
  assert.deepEqual(h.queries, [first.hash], 'a timeout must not change the hash query');
  h.pickerRoot.loading = false;
  h.pickerRoot.card = {};
  h.notify();
  await flush();
  assert.deepEqual(h.selections, [first.modelVersionId]);
  assert.deepEqual(h.queries, [first.hash, second.hash]);
});

test('manual version selection pauses only that resource and keeps the next resource automatic', async () => {
  const h = harness();
  h.api.state.resources = [first, second];
  h.selectManually = true;
  h.onQuery = () => { h.pickerRoot.card = {}; };
  await h.api.addResources({ autoSelect: true });
  await flush();
  assert.equal(h.api.state.resourceAutomationActive, true);
  h.selectManually = false;
  h.api.state.guidedSelectionPending = true;
  h.close();
  await flush();
  assert.deepEqual(h.selections, [first.modelVersionId, second.modelVersionId]);
  assert.equal(h.api.state.added.has('id:101'), true);
  assert.equal(h.api.state.added.has('id:102'), true);
});

test('switching videos cancels the old search before it can overwrite the next query', async () => {
  const h = harness();
  h.pickerRoot.loading = true;
  const result = h.api.searchPickerOnce({ root: h.pickerRoot, input: h.input }, first, { query: first.hash });
  h.api.state.scanToken += 1;
  h.notify();
  assert.equal((await result).type, 'stale');
  assert.deepEqual(h.queries, [first.hash]);
});

test('loading that starts during empty-response confirmation cancels the fallback', async () => {
  const h = harness();
  const result = h.api.searchPickerOnce({ root: h.pickerRoot, input: h.input }, first, { query: first.hash });
  let settled = false;
  result.then(() => { settled = true; });
  h.pickerRoot.textContent = 'No models found';
  h.notify();
  await h.clock.advance(300);
  h.pickerRoot.loading = true;
  h.notify();
  await h.clock.advance(3000);
  assert.equal(settled, false);
  h.pickerRoot.loading = false;
  h.pickerRoot.card = {};
  h.notify();
  assert.equal((await result).type, 'match');
});
