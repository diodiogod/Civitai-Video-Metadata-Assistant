const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const metadata = require('../src/metadata');

const source = fs.readFileSync(path.join(__dirname, '../src/content.js'), 'utf8').replace(/\r\n/g, '\n');
const startup = "  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });\n  else init();";
const parameters = 'A moving landscape\nNegative prompt: blurry\nSteps: 20, Sampler: dpmpp_2m, Schedule type: karras, CFG scale: 4, Seed: 123456';
const resources = Array.from({ length: 5 }, (_, index) => ({
  modelVersionId: 101 + index,
  lookup: { id: 101 + index, modelId: 201 + index, name: 'v1', model: { name: `Model ${index + 1}` } }
}));

function resourceLink(resource) {
  return `<div><a href="/models/${resource.lookup.modelId}?modelVersionId=${resource.modelVersionId}"><div><p>${resource.lookup.model.name}</p><p>v1</p></div></a></div>`;
}

// Mirror the public AddedImage.tsx markup: a header inside a CustomCard,
// sibling resource links, and Show All after the first three resource rows.
function videoRow(id, attached = resources, { collapsed = false, prompt = true, steps = 20 } = {}) {
  return `<article id="${id}"><video></video>
    <div class="settings"><div><p>Guidance</p><p>4.0</p></div><div><p>Steps</p><p>${steps}</p></div>
      <div><p>Sampler</p><p>DPM++ 2M Karras</p></div><div><p>Seed</p><p>123,456</p></div></div>
    <section class="prompt"><div><h3>Prompt</h3><button class="edit">EDIT</button></div>
      ${prompt ? '<p>A moving landscape</p><hr><h3>Negative Prompt</h3><p>blurry</p>' : ''}</section>
    <section class="resources"><div><div><h3>Resources</h3></div><div><button class="add">+ RESOURCE</button></div></div>
      ${attached.slice(0, collapsed ? 3 : attached.length).map(resourceLink).join('')}
      ${collapsed ? `<button class="expand">Show All (${attached.length})</button>` : ''}</section>
    <section><h3>Tools</h3></section>
  </article>`;
}

function harness(t, html = videoRow('first')) {
  const dom = new JSDOM(html, { url: 'https://civitai.red/posts/123/edit', runScripts: 'outside-only' });
  t.after(() => dom.window.close());
  const { window } = dom;
  // JSDOM has no layout engine; retain normal DOM/events/MutationObserver and
  // expose only elements that would participate in a browser's layout.
  window.HTMLElement.prototype.getClientRects = function () {
    for (let item = this; item; item = item.parentElement) {
      if (item.hidden || item.style.display === 'none') return [];
    }
    return this.isConnected ? [{}] : [];
  };
  window.CVMMetadata = metadata;
  assert.equal(source.includes(startup), true);
  window.eval(source.replace(startup, `
    render = () => {};
    globalThis.testAPI = { state, attachedResourceSnapshot, markAlreadyAttachedResources,
      prepareAttachedResources, fillCivitaiPrompt, runAutomaticWorkflow, addResources
    };`));
  const api = window.testAPI;
  const h = { window, document: window.document, api, edits: 0, searches: 0, changes: [], saves: 0 };
  h.bind = (id, attached = resources) => {
    Object.assign(api.state, {
      fileKey: `${id}.mp4:100:1`, uploadFileKey: `${id}.mp4:100:1`, targetMediaFileKey: `${id}.mp4:100:1`,
      targetMediaContainer: h.document.getElementById(id), targetMediaIndex: id === 'first' ? 0 : 1,
      scanToken: api.state.scanToken + 1, resources: attached, added: new Set(), skipped: new Set(),
      parsed: { metadata: { parameters } }, promptFilled: false, busy: false,
      queue: [{ id, status: 'applying', activity: [] }], activeQueueId: id
    });
  };
  h.document.querySelectorAll('.edit').forEach((button) => button.addEventListener('click', () => { h.edits += 1; }));
  h.document.querySelectorAll('.add').forEach((button) => button.addEventListener('click', () => { h.searches += 1; }));
  h.bind('first');
  return h;
}

function mountEditor(h, { steps = 20, scheduler, positive = 'A moving landscape' } = {}) {
  const dialog = h.document.createElement('div');
  dialog.setAttribute('role', 'dialog');
  dialog.innerHTML = `<label for="positive">Prompt</label><textarea id="positive">${positive}</textarea>
    <label for="input_negativePrompt">Negative prompt</label><textarea name="negativePrompt" id="input_negativePrompt">blurry</textarea>
    <input name="cfgScale" value="4.0"><input name="steps" value="${steps}">
    <input name="sampler" value="DPM++ 2M Karras"><input name="seed" value="123,456">
    ${scheduler !== undefined ? `<label for="scheduler">Scheduler</label><input id="scheduler" name="scheduler" value="${scheduler}">` : ''}
    <button class="cancel" aria-label="Close">×</button><button class="save">Save</button>`;
  dialog.addEventListener('input', (event) => h.changes.push(event.target.name || event.target.id));
  dialog.querySelector('.cancel').onclick = () => dialog.remove();
  dialog.querySelector('.save').onclick = () => { h.saves += 1; dialog.remove(); };
  h.document.body.append(dialog);
  return dialog;
}

test('native metadata skips the editor and all resource searches, including hidden resources', async (t) => {
  const h = harness(t, videoRow('first', resources, { collapsed: true }));
  h.document.querySelector('.expand').onclick = (event) => {
    const button = event.currentTarget;
    button.insertAdjacentHTML('beforebegin', resources.slice(3).map(resourceLink).join(''));
    button.textContent = 'Show Less';
  };
  await h.api.runAutomaticWorkflow(h.api.state.scanToken);
  assert.equal(h.edits, 0);
  assert.equal(h.searches, 0);
  assert.equal(h.api.state.added.size, 5);
  assert.equal(h.api.state.promptFilled, true);
  assert.equal(h.api.state.queue[0].status, 'complete');
});

test('attachment checks stay inside the bound video and require the correct version', async (t) => {
  const wrongVersion = { ...resources[0], modelVersionId: 999 };
  const h = harness(t, videoRow('first') + videoRow('second', [wrongVersion, resources[1]]));
  h.bind('second');
  await h.api.prepareAttachedResources();
  h.api.markAlreadyAttachedResources(h.document.querySelector('#second .add'));
  assert.deepEqual([...h.api.state.added], ['id:102']);
  assert.equal(h.api.state.added.has('id:101'), false);
});

test('each video independently recognizes resources already detected by Civitai', async (t) => {
  const h = harness(t, videoRow('first') + videoRow('second'));
  await h.api.runAutomaticWorkflow(h.api.state.scanToken);
  h.bind('second');
  await h.api.runAutomaticWorkflow(h.api.state.scanToken);
  assert.equal(h.api.state.added.size, 5);
  assert.equal(h.api.state.queue[0].status, 'complete');
  assert.equal(h.edits, 0);
  assert.equal(h.searches, 0);
});

test('partial native detection searches only the missing resource', async (t) => {
  const h = harness(t, videoRow('first', resources.slice(0, 4)));
  const queries = [];
  h.document.querySelector('.add').addEventListener('click', () => {
    const picker = h.document.createElement('div');
    picker.setAttribute('role', 'dialog');
    picker.innerHTML = '<h2>Select resources</h2><input placeholder="Search models"><div class="results"></div>';
    picker.querySelector('input').oninput = (event) => {
      queries.push(event.target.value);
      picker.querySelector('.results').innerHTML = `<div class="card">${resourceLink(resources[4])}<input role="combobox" value="v1"><button>Select</button></div>`;
      picker.querySelector('button').onclick = () => {
        h.document.querySelector('.resources').insertAdjacentHTML('beforeend', resourceLink(resources[4]));
        picker.remove();
      };
    };
    h.document.body.append(picker);
  });
  await h.api.runAutomaticWorkflow(h.api.state.scanToken);
  for (let index = 0; index < 30; index += 1) await Promise.resolve();
  assert.deepEqual(queries, ['Model 5']);
  assert.equal(h.searches, 1);
  assert.equal(h.api.state.added.size, 5);
  assert.equal(h.api.state.queue[0].status, 'complete');
  assert.equal(h.edits, 0);
});

test('native attachment detection still works when a public API lookup failed', async (t) => {
  const h = harness(t);
  h.api.state.resources = [{ modelVersionId: 101 }];
  await h.api.runAutomaticWorkflow(h.api.state.scanToken);
  assert.equal(h.api.state.added.has('id:101'), true);
  assert.equal(h.api.state.queue[0].status, 'complete');
  assert.doesNotMatch(h.api.state.message, /unresolved/);
});

test('native import loading must finish before an empty resource list is evaluated', async (t) => {
  const h = harness(t, videoRow('first', []));
  const loader = h.document.createElement('span');
  loader.className = 'mantine-Loader-root';
  h.document.querySelector('#first').append(loader);
  let settled = false;
  const running = h.api.runAutomaticWorkflow(h.api.state.scanToken).then(() => { settled = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  assert.equal(h.searches, 0);
  h.document.querySelector('.resources').insertAdjacentHTML('beforeend', resources.map(resourceLink).join(''));
  loader.remove();
  await running;
  assert.equal(h.searches, 0);
  assert.equal(h.api.state.added.size, 5);
});

test('only a different generation field is written; matching scheduler and prompts are untouched', async (t) => {
  const h = harness(t, videoRow('first', resources, { steps: 19 }));
  h.document.querySelector('.edit').addEventListener('click', () => mountEditor(h, { steps: 19, scheduler: 'karras' }));
  await h.api.runAutomaticWorkflow(h.api.state.scanToken);
  assert.deepEqual(h.changes, ['steps']);
  assert.equal(h.saves, 1);
  assert.equal(h.searches, 0);
  assert.equal(h.api.state.queue[0].status, 'complete');
});

test('an unrecognized summary falls back to comparing the editor, without saving unchanged fields', async (t) => {
  const h = harness(t, videoRow('first', resources, { prompt: false }));
  h.document.querySelector('.edit').addEventListener('click', () => mountEditor(h));
  await h.api.runAutomaticWorkflow(h.api.state.scanToken);
  assert.equal(h.edits, 1);
  assert.deepEqual(h.changes, []);
  assert.equal(h.saves, 0);
  assert.equal(h.document.querySelector('[role="dialog"]'), null);
  assert.equal(h.api.state.queue[0].status, 'complete');
});

test('an older video with no native prompt fills only its missing prompt', async (t) => {
  const h = harness(t, videoRow('first', resources, { prompt: false }));
  h.document.querySelector('.edit').addEventListener('click', () => mountEditor(h, { positive: '' }));
  await h.api.runAutomaticWorkflow(h.api.state.scanToken);
  assert.deepEqual(h.changes, ['positive']);
  assert.equal(h.saves, 1);
  assert.equal(h.api.state.queue[0].status, 'complete');
});

test('a different scheduler is updated only when Civitai exposes its field', async (t) => {
  const h = harness(t, videoRow('first', resources, { prompt: false }));
  h.document.querySelector('.edit').addEventListener('click', () => mountEditor(h, { scheduler: 'exponential' }));
  await h.api.runAutomaticWorkflow(h.api.state.scanToken);
  assert.deepEqual(h.changes, ['scheduler']);
  assert.equal(h.saves, 1);
  assert.equal(h.searches, 0);
});

test('an unmatched warning does not make a missing resource count as attached', async (t) => {
  const h = harness(t, videoRow('first', []));
  h.document.querySelector('.resources').insertAdjacentHTML('beforeend', '<div role="alert">The following resources could not be matched: Model 1 v1</div>');
  await h.api.prepareAttachedResources();
  h.api.markAlreadyAttachedResources(h.document.querySelector('.add'));
  assert.equal(h.api.state.added.size, 0);
});
