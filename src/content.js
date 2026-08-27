(function () {
  'use strict';

  if (!globalThis.CVMMetadata) return;
  if (globalThis.__CVM_ASSISTANT_INITIALIZED) return;
  globalThis.__CVM_ASSISTANT_INITIALIZED = true;

  const EXTENSION_ID = 'cvm-assistant-panel';
  const API_ROOT = 'https://civitai.com/api/v1';
  const state = {
    file: null,
    fileKey: '',
    parsed: null,
    resources: [],
    message: 'Select an MP4 or WebM in the Civitai upload form.',
    busy: false,
    added: new Set(),
    promptFilled: false,
    uploadFileKey: '',
    scanToken: 0,
    guidedResourceId: '',
    guidedSelectionPending: false,
    autoAdvanceResources: true,
    autoEverything: true,
    resourceAutomationActive: false,
    skipped: new Set(),
    ignoredPageFileKey: '',
    queue: [],
    activeQueueId: '',
    queueCounter: 0,
    activity: [],
    targetMediaContainer: null,
    targetMediaFileKey: '',
    uploadToken: 0,
    scanningFileKey: ''
  };

  const visible = (element) => Boolean(element && element.isConnected && element.getClientRects().length && getComputedStyle(element).visibility !== 'hidden');
  const normalizeText = (value) => String(value || '').replace(/\s+/g, ' ').trim();
  const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));

  function getPanel() {
    return document.getElementById(EXTENSION_ID);
  }

  function keyForFile(file) {
    return file ? `${file.name}:${file.size}:${file.lastModified}` : '';
  }

  function activeQueueItem() {
    return state.queue.find((item) => item.id === state.activeQueueId) || null;
  }

  function addActivity(level, message, item = activeQueueItem()) {
    state.activity.unshift({
      id: `${Date.now()}-${Math.random()}`,
      level,
      message,
      fileName: item?.file?.name || state.file?.name || '',
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    });
    state.activity = state.activity.slice(0, 80);
  }

  function setQueueStatus(status, message) {
    const item = activeQueueItem();
    if (!item) return;
    item.status = status;
    item.message = message || '';
    render();
  }

  function enqueueFiles(files) {
    const videos = [...files].filter((file) => file.type.startsWith('video/') || /\.(mp4|webm)$/i.test(file.name));
    if (!videos.length) {
      state.message = 'Drop one or more MP4/WebM video files here.';
      render();
      return;
    }
    for (const file of videos) {
      state.queue.push({ id: `video-${++state.queueCounter}`, file, status: 'waiting', message: 'Waiting' });
      addActivity('info', 'Added to the queue.', { file });
    }
    if (!state.activeQueueId) activateQueueItem(state.queue.find((item) => item.status === 'waiting'));
    else render();
  }

  function clearCurrentVideoState() {
    state.scanToken += 1;
    state.uploadToken += 1;
    state.ignoredPageFileKey = state.fileKey;
    state.file = null;
    state.fileKey = '';
    state.scanningFileKey = '';
    state.parsed = null;
    state.resources = [];
    state.busy = false;
    state.added.clear();
    state.skipped.clear();
    state.guidedResourceId = '';
    state.guidedSelectionPending = false;
    state.resourceAutomationActive = false;
    state.promptFilled = false;
    state.uploadFileKey = '';
    state.targetMediaContainer = null;
    state.targetMediaFileKey = '';
    lastObservedFileKey = '';
  }

  function resetUploadSession() {
    clearCurrentVideoState();
    state.queue = [];
    state.activeQueueId = '';
    state.activity = [];
    state.message = 'Drop one or more videos into Step 1.';
  }

  function activateQueueItem(item) {
    if (!item) {
      state.activeQueueId = '';
      clearCurrentVideoState();
      state.message = 'Queue complete. Drop more videos into Step 1.';
      render();
      return;
    }
    clearCurrentVideoState();
    state.activeQueueId = item.id;
    item.status = 'reading';
    item.message = 'Reading metadata';
    scanFile(item.file);
  }

  function completeActiveQueueItem(message = 'Complete') {
    const item = activeQueueItem();
    if (!item || item.status === 'complete') return;
    item.status = 'complete';
    item.message = message;
    addActivity('success', message, item);
    render();
    if (state.autoEverything) {
      const next = state.queue.find((candidate) => candidate.status === 'waiting');
      window.setTimeout(() => activateQueueItem(next), 0);
    }
  }

  function queueRows() {
    if (!state.queue.length) return '<div class="cvm-empty">No videos queued.</div>';
    return state.queue.map((item, index) => {
      const active = item.id === state.activeQueueId;
      const canRemove = item.status === 'waiting' || item.status === 'error' || item.status === 'skipped';
      return `<li class="cvm-queue-item ${active ? 'cvm-queue-active' : ''}">
        <b>${index + 1}</b><span><strong>${escapeHtml(item.file.name)}</strong><small>${escapeHtml(item.message || item.status)}</small></span>
        <em class="cvm-queue-status cvm-q-${escapeHtml(item.status)}">${escapeHtml(item.status)}</em>
        <span class="cvm-queue-actions">${item.status === 'error' ? `<button data-cvm-queue-action="retry" data-cvm-id="${item.id}">Retry</button>` : ''}${canRemove ? `<button data-cvm-queue-action="remove" data-cvm-id="${item.id}">Remove</button>` : ''}</span>
      </li>`;
    }).join('');
  }

  function activityRows() {
    if (!state.activity.length) return '<div class="cvm-empty">No activity yet.</div>';
    return state.activity.map((entry) => `<li class="cvm-log-${entry.level}"><time>${escapeHtml(entry.time)}</time><span><strong>${escapeHtml(entry.fileName)}</strong>${escapeHtml(entry.message)}</span></li>`).join('');
  }

  function getFileFromPage() {
    const panel = getPanel();
    const inputs = [...document.querySelectorAll('input[type="file"]')]
      .filter((input) => !panel?.contains(input));
    for (const input of inputs) {
      const file = input.files?.[0];
      if (file && (file.type.startsWith('video/') || /\.(mp4|webm)$/i.test(file.name))) return file;
    }
    return null;
  }

  function findUploadFileInput() {
    const panel = getPanel();
    const inputs = [...document.querySelectorAll('input[type="file"]')]
      .filter((input) => !panel?.contains(input));
    if (!inputs.length) return null;
    const score = (input) => {
      const accept = String(input.getAttribute('accept') || '').toLowerCase();
      const context = normalizeText(input.parentElement?.parentElement?.parentElement?.textContent || '').toLowerCase();
      return (accept.includes('video') ? 20 : 0)
        + (accept.includes('.mp4') || accept.includes('.webm') ? 10 : 0)
        + (context.includes('video') ? 5 : 0)
        + (input.closest('[role="dialog"], form') ? 2 : 0)
        + (input.files?.length ? -5 : 0);
    };
    return inputs.sort((left, right) => score(right) - score(left))[0];
  }

  function mediaContainerFor(element) {
    let container = element?.parentElement || null;
    for (let depth = 0; container && container !== document.body && depth < 10; depth += 1, container = container.parentElement) {
      const hasPromptHeading = [...container.querySelectorAll('h1, h2, h3, h4, h5, h6')]
        .some((heading) => /^prompt$/i.test(normalizeText(heading.textContent)));
      if (hasPromptHeading && container.querySelector('video, img')) return container;
    }
    return null;
  }

  function currentTargetRoot() {
    if (state.targetMediaFileKey === state.fileKey && state.targetMediaContainer?.isConnected) {
      return state.targetMediaContainer;
    }
    return document;
  }

  function hasPromptTarget() {
    if (state.targetMediaFileKey === state.fileKey && state.targetMediaContainer?.isConnected) return true;
    return visibleElements('h1, h2, h3, h4, h5, h6')
      .filter((heading) => /^prompt$/i.test(normalizeText(heading.textContent)) && !heading.closest(`#${EXTENSION_ID}`)).length <= 1;
  }

  async function useFileInCivitaiUpload() {
    if (!state.file) {
      state.message = 'Drop or choose a video in the assistant first.';
      render();
      return;
    }
    const input = findUploadFileInput();
    if (!input) {
      state.message = 'Civitai’s video upload input was not found. Use Civitai’s drop area directly.';
      render();
      return;
    }
    try {
      setQueueStatus('uploading', 'Uploading to Civitai');
      const uploadToken = ++state.uploadToken;
      const handedOffFileKey = state.fileKey;
      const existingMedia = new Set(document.querySelectorAll('video'));
      const transfer = new DataTransfer();
      transfer.items.add(state.file);
      input.files = transfer.files;
      const handedOffFile = input.files?.[0];
      if (!handedOffFile || handedOffFile.name !== state.file.name || handedOffFile.size !== state.file.size) {
        throw new Error('Firefox did not accept the video in Civitai’s actual upload input.');
      }
      input.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
      input.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
      state.uploadFileKey = handedOffFileKey;
      state.targetMediaContainer = null;
      state.targetMediaFileKey = '';
      state.message = 'Video handed to Civitai. Waiting for its new preview row…';
      render();
      const newVideo = await waitForDomCondition(() => [...document.querySelectorAll('video')]
        .find((video) => !existingMedia.has(video)), 120000);
      if (uploadToken !== state.uploadToken) return;
      if (newVideo) {
        state.targetMediaContainer = mediaContainerFor(newVideo);
        state.targetMediaFileKey = handedOffFileKey;
        state.message = state.targetMediaContainer
          ? 'Civitai created this video’s row. Prompt and resource actions will target it.'
          : 'Civitai uploaded the video, but its details row could not be identified.';
        if (state.targetMediaContainer) {
          setQueueStatus('applying', 'Video uploaded; applying metadata');
          addActivity('success', 'Uploaded and bound to the correct Civitai row.');
        } else {
          setQueueStatus('error', 'Uploaded, but row binding failed');
          addActivity('error', 'Civitai uploaded the video, but the row could not be identified.');
        }
      } else {
        state.message = 'Civitai did not expose a new video row. Prompt targeting is unavailable for this upload.';
      }
    } catch (error) {
      state.message = error?.message || 'Firefox would not hand the local file to Civitai’s upload form.';
      setQueueStatus('error', state.message);
      addActivity('error', state.message);
    }
    render();
  }

  async function fetchJson(url) {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 2500);
    try {
      const response = await fetch(url, { signal: controller.signal });
      return response.ok ? await response.json() : null;
    } catch (_) {
      return null;
    } finally {
      window.clearTimeout(timeout);
    }
  }

  async function lookupResource(resource) {
    if (resource.modelVersionId) {
      const lookup = await fetchJson(`${API_ROOT}/model-versions/${encodeURIComponent(resource.modelVersionId)}`);
      if (lookup) return { ...resource, lookup };
    }
    if (resource.hash) {
      const lookup = await fetchJson(`${API_ROOT}/model-versions/by-hash/${encodeURIComponent(resource.hash)}`);
      if (lookup) return { ...resource, lookup };
    }
    return { ...resource, lookup: null };
  }

  function resourceId(resource) {
    return resource.modelVersionId ? `id:${resource.modelVersionId}` : resource.hash ? `hash:${String(resource.hash).toLowerCase()}` : resource.air || resource.name || 'unknown';
  }

  function resourceName(resource) {
    const lookup = resource.lookup;
    const modelName = lookup?.model?.name || resource.modelName || resource.name || 'Unknown resource';
    const versionName = lookup?.name || resource.versionName || '';
    return versionName && versionName !== modelName ? `${modelName} — ${versionName}` : modelName;
  }

  function resourceUrl(resource) {
    const lookup = resource.lookup;
    const modelId = lookup?.modelId || resource.modelId;
    const versionId = lookup?.id || resource.modelVersionId;
    if (modelId && versionId) return `https://civitai.com/models/${modelId}?modelVersionId=${versionId}`;
    if (versionId) return `https://civitai.com/model-versions/${versionId}`;
    return resource.hash ? `https://civitai.com/api/v1/model-versions/by-hash/${encodeURIComponent(resource.hash)}` : '';
  }

  function resourceRows() {
    if (!state.resources.length) return '<div class="cvm-empty">No Civitai resources were found in this video.</div>';
    return state.resources.map((resource) => {
      const id = resourceId(resource);
      const title = resourceName(resource);
      const detail = resource.lookup ? `version ${escapeHtml(resource.lookup.name || resource.lookup.id)}` : resource.hash ? `hash ${escapeHtml(resource.hash)}` : 'metadata identifier';
      const status = state.added.has(id)
        ? '<span class="cvm-status cvm-ok">added</span>'
        : state.skipped.has(id)
          ? '<span class="cvm-status cvm-skip">skipped</span>'
        : state.guidedResourceId === id
          ? '<span class="cvm-status cvm-current">select now</span>'
          : resource.lookup
            ? '<span class="cvm-status cvm-ready">queued</span>'
            : '<span class="cvm-status cvm-warn">unresolved</span>';
      return `<li class="cvm-resource"><span><strong>${escapeHtml(title)}</strong><small>${detail}</small></span>${status}</li>`;
    }).join('');
  }

  function render() {
    const panel = getPanel();
    if (!panel) return;
    const metadata = state.parsed?.metadata || {};
    const prompt = globalThis.CVMMetadata.getPromptFields(metadata);
    const promptTargetReady = hasPromptTarget();
    const container = state.parsed?.container ? state.parsed.container.toUpperCase() : '';
    panel.innerHTML = `
      <div class="cvm-header">
        <div><strong>Civitai Video Metadata</strong><small>${container ? `${container} · ` : ''}${escapeHtml(state.file?.name || 'no video selected')}</small></div>
        <button type="button" class="cvm-icon" data-cvm-action="scan" title="Scan the current upload">↻</button>
      </div>
      <div class="cvm-message">${escapeHtml(state.message)}</div>
      <label class="cvm-master-mode"><input type="checkbox" data-cvm-auto-everything ${state.autoEverything ? 'checked' : ''}> Do everything automatically after I drop a video</label>
      <div class="cvm-step"><b>1</b><span><strong>Choose the video</strong><small>Drop it below. Metadata stays local until you send the file to Civitai.</small></span></div>
      <ul class="cvm-queue">${queueRows()}</ul>
      ${state.parsed ? `<div class="cvm-summary"><span>${state.resources.length} resource${state.resources.length === 1 ? '' : 's'}</span><span>${prompt.positive ? 'positive prompt' : 'no prompt text'}</span><span>${metadata.workflow ? 'workflow' : 'no workflow'}</span></div>` : ''}
      ${state.parsed ? '<div class="cvm-step"><b>2</b><span><strong>Review metadata</strong><small>Check the detected prompt, settings, and resources.</small></span></div>' : ''}
      ${prompt.positive ? `<div class="cvm-prompt"><strong>Prompt</strong><div>${escapeHtml(prompt.positive)}</div>${prompt.negative ? `<small>Negative: ${escapeHtml(prompt.negative)}</small>` : ''}</div>` : ''}
      ${state.parsed ? `<ul class="cvm-resources">${resourceRows()}</ul>` : ''}
      ${state.resources.length ? `<div class="cvm-step"><b>3</b><span><strong>Apply to Civitai</strong><small>Fill the bound video row and add exact resource matches.</small></span></div><label class="cvm-resource-mode"><input type="checkbox" data-cvm-auto-advance ${state.autoAdvanceResources ? 'checked' : ''}> Open the next resolved resource after this picker closes</label>` : ''}
      <div id="cvm-dropzone" class="cvm-dropzone" tabindex="0">
        <strong>Drop one or more MP4/WebM videos here</strong>
        <small>Videos are processed sequentially so each one stays bound to its own Civitai row.</small>
      </div>
      <div class="cvm-file-row">
        <button type="button" data-cvm-action="choose">Read local video metadata</button>
        <input id="cvm-file-picker" type="file" accept="video/mp4,video/webm,.mp4,.webm" multiple hidden>
      </div>
      <div class="cvm-section-label">Manual controls</div>
      <div class="cvm-actions">
        <button type="button" data-cvm-action="upload" ${!state.file ? 'disabled' : ''}>Use this file in Civitai upload</button>
        <button type="button" class="cvm-primary" data-cvm-action="prompt" ${state.busy || !prompt.positive || state.promptFilled || !promptTargetReady ? 'disabled' : ''}>Fill this video’s prompt</button>
        <button type="button" data-cvm-action="copy-prompt" ${!prompt.positive ? 'disabled' : ''}>Copy prompt</button>
        <button type="button" data-cvm-action="add" ${state.busy || !state.resources.length ? 'disabled' : ''}>Find next resource</button>
        <button type="button" data-cvm-action="auto-add" ${state.busy || !state.resources.some((resource) => resource.lookup) ? 'disabled' : ''}>Auto-add exact resources</button>
        <button type="button" data-cvm-action="copy" ${!state.parsed ? 'disabled' : ''}>Copy metadata</button>
      </div>
      <div class="cvm-step cvm-next-step"><b>4</b><span><strong>Continue with another video</strong><small>Keep the existing Civitai uploads and clear only this assistant.</small></span></div>
      <div class="cvm-next-action"><button type="button" data-cvm-action="next" ${!state.file && !state.parsed ? 'disabled' : ''}>Start next video</button></div>
      <details class="cvm-activity"><summary>Activity &amp; issues <span>${state.activity.length}</span></summary><ul>${activityRows()}</ul><button type="button" data-cvm-action="clear-log" ${!state.activity.length ? 'disabled' : ''}>Clear activity</button></details>
      <div class="cvm-footnote">${!promptTargetReady ? 'Multiple Civitai videos are present. Use this file in Civitai upload first so the assistant can bind it to the correct row.' : state.autoEverything ? 'Automatic mode handles the upload form but never publishes the post.' : 'The file is read locally. Nothing is uploaded or submitted automatically.'}</div>`;
    panel.querySelectorAll('[data-cvm-action]').forEach((button) => button.addEventListener('click', () => handleAction(button.dataset.cvmAction)));
    panel.querySelector('[data-cvm-auto-advance]')?.addEventListener('change', (event) => {
      state.autoAdvanceResources = event.target.checked;
    });
    panel.querySelector('[data-cvm-auto-everything]')?.addEventListener('change', (event) => {
      state.autoEverything = event.target.checked;
      if (state.autoEverything && state.parsed && activeQueueItem()?.status === 'ready') queueMicrotask(() => runAutomaticWorkflow(state.scanToken));
    });
    panel.querySelector('#cvm-file-picker')?.addEventListener('change', (event) => enqueueFiles(event.target.files || []));
    panel.querySelectorAll('[data-cvm-queue-action]').forEach((button) => button.addEventListener('click', () => handleQueueAction(button.dataset.cvmQueueAction, button.dataset.cvmId)));
    const dropzone = panel.querySelector('#cvm-dropzone');
    ['dragenter', 'dragover'].forEach((eventName) => dropzone?.addEventListener(eventName, (event) => {
      event.preventDefault();
      event.stopPropagation();
      dropzone.classList.add('cvm-dragging');
    }));
    dropzone?.addEventListener('dragleave', () => dropzone.classList.remove('cvm-dragging'));
    dropzone?.addEventListener('drop', (event) => {
      event.preventDefault();
      event.stopPropagation();
      dropzone.classList.remove('cvm-dragging');
      enqueueFiles(event.dataTransfer?.files || []);
    });
  }

  function createPanel() {
    if (getPanel()) return;
    const panel = document.createElement('section');
    panel.id = EXTENSION_ID;
    panel.setAttribute('aria-label', 'Civitai Video Metadata Assistant');
    document.body.appendChild(panel);
    render();
  }

  async function scanFile(file = getFileFromPage()) {
    let scanSucceeded = false;
    if (!file) {
      state.message = 'No video file is selected yet. Choose an MP4 or WebM, then scan again.';
      state.parsed = null;
      state.resources = [];
      render();
      return;
    }
    const key = `${file.name}:${file.size}:${file.lastModified}`;
    if (key === state.fileKey && state.parsed) return;
    if (key === state.scanningFileKey) return;
    const scanToken = ++state.scanToken;
    state.scanningFileKey = key;
    state.busy = true;
    state.file = file;
    state.fileKey = key;
    state.promptFilled = false;
    state.guidedResourceId = '';
    state.skipped.clear();
    state.added.clear();
    state.message = 'Reading the local video metadata…';
    setQueueStatus('reading', 'Reading metadata');
    render();
    try {
      const parsed = await globalThis.CVMMetadata.parseVideoFile(file);
      if (scanToken !== state.scanToken) return;
      const hints = globalThis.CVMMetadata.extractResources(parsed.metadata);
      const resources = await Promise.all(hints.map((hint) => lookupResource(hint)));
      if (scanToken !== state.scanToken) return;
      state.parsed = parsed;
      state.resources = resources;
      scanSucceeded = true;
      state.message = state.resources.length ? 'Metadata read locally. Review the detected resources, then add them.' : 'Metadata read locally, but no resource identifiers were present.';
      setQueueStatus('ready', 'Metadata ready');
      addActivity('success', `Metadata read: ${resources.length} resource${resources.length === 1 ? '' : 's'} detected.`);
    } catch (error) {
      if (scanToken !== state.scanToken) return;
      state.parsed = null;
      state.resources = [];
      state.message = error?.message || 'Unable to read this video metadata.';
      setQueueStatus('error', state.message);
      addActivity('error', state.message);
    } finally {
      if (scanToken !== state.scanToken) return;
      state.scanningFileKey = '';
      state.busy = false;
      render();
      if (scanSucceeded && state.autoEverything) queueMicrotask(() => runAutomaticWorkflow(scanToken));
    }
  }

  function dispatchInput(element, value) {
    if (element.isContentEditable) {
      element.focus();
      element.textContent = value;
      element.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: value }));
      element.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
      return;
    }
    const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
    if (setter) setter.call(element, value);
    else element.value = value;
    element.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    element.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
  }

  function visibleElements(selector, root = document) {
    return [...root.querySelectorAll(selector)].filter(visible);
  }

  function waitForDomCondition(condition, watchdogMs = 15000) {
    return new Promise((resolve) => {
      let settled = false;
      const observer = new MutationObserver(check);
      const watchdog = window.setTimeout(() => finish(null), watchdogMs);
      function finish(value) {
        if (settled) return;
        settled = true;
        observer.disconnect();
        window.clearTimeout(watchdog);
        resolve(value);
      }
      function check() {
        if (settled) return;
        let value = null;
        try {
          value = condition();
        } catch (_) {
          value = null;
        }
        if (value) finish(value);
      }
      observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, characterData: true });
      check();
    });
  }

  function waitForDomQuiet(root = document.documentElement, quietMs = 450, watchdogMs = 5000) {
    return new Promise((resolve) => {
      let quietTimer = null;
      let settled = false;
      const observer = new MutationObserver(schedule);
      const watchdog = window.setTimeout(() => finish(), watchdogMs);
      function finish() {
        if (settled) return;
        settled = true;
        observer.disconnect();
        window.clearTimeout(watchdog);
        if (quietTimer) window.clearTimeout(quietTimer);
        resolve();
      }
      function schedule() {
        if (quietTimer) window.clearTimeout(quietTimer);
        quietTimer = window.setTimeout(finish, quietMs);
      }
      observer.observe(root, { childList: true, subtree: true, attributes: true, characterData: true });
      schedule();
    });
  }

  function findResourceButton(root = currentTargetRoot()) {
    const candidates = visibleElements('button, [role="button"]', root).filter((element) => {
      if (element.closest(`#${EXTENSION_ID}`)) return false;
      const text = normalizeText(element.textContent);
      const accessibleName = normalizeText(element.getAttribute('aria-label') || element.getAttribute('title'));
      return /resource/i.test(`${text} ${accessibleName}`);
    });
    return candidates.sort((left, right) => {
      const leftText = normalizeText(`${left.textContent} ${left.getAttribute('aria-label') || ''}`);
      const rightText = normalizeText(`${right.textContent} ${right.getAttribute('aria-label') || ''}`);
      const score = (value) => (/^\+?\s*resource$/i.test(value) ? 0 : /add\s+resource/i.test(value) ? 1 : 2);
      return score(leftText) - score(rightText);
    })[0] || null;
  }

  function getDialogRoot() {
    const dialogs = visibleElements('[role="dialog"], [data-radix-dialog-content], [data-overlay-container]');
    return dialogs[dialogs.length - 1] || document.body;
  }

  function findSearchInput(root, excluded = new Set()) {
    const candidates = visibleElements('input:not([type="file"]), textarea', root)
      .filter((element) => !excluded.has(element));
    const score = (element) => {
      const descriptor = `${element.getAttribute('placeholder') || ''} ${element.getAttribute('aria-label') || ''} ${element.getAttribute('name') || ''}`;
      return (element.type === 'search' ? 40 : 0)
        + (/resource/i.test(descriptor) ? 30 : 0)
        + (/model/i.test(descriptor) ? 20 : 0)
        + (/search/i.test(descriptor) ? 10 : 0);
    };
    return candidates
      .map((element) => ({ element, score: score(element) }))
      .sort((left, right) => right.score - left.score)[0]?.element
      || candidates.find((element) => element.type === 'text' || element.tagName === 'TEXTAREA');
  }

  function dialogCandidates(root) {
    return visibleElements('button, [role="option"], [role="listbox"] [role="option"], a, [data-value]', root)
      .filter((element) => !element.closest(`#${EXTENSION_ID}`))
      .map((element) => ({ element, text: normalizeText(element.textContent) }))
      .filter(({ text }) => text && text.length < 500);
  }

  function pickerActionButton(root) {
    const candidates = visibleElements('button, [role="button"]', root)
      .filter((element) => !element.closest(`#${EXTENSION_ID}`))
      .map((element) => ({
        element,
        label: normalizeText(`${element.textContent} ${element.getAttribute('aria-label') || ''} ${element.getAttribute('title') || ''}`)
      }))
      .filter(({ label }) => /\b(select|add|confirm)\b/i.test(label));
    return candidates.sort((left, right) => {
      const rank = (label) => (/^select$/i.test(label) ? 0 : /^add$/i.test(label) ? 1 : /^confirm$/i.test(label) ? 2 : 3);
      return rank(left.label) - rank(right.label);
    })[0]?.element || null;
  }

  function clickResourceCandidate(candidate) {
    const nestedAction = visibleElements('button, [role="button"]', candidate.element)
      .find((element) => {
        const label = normalizeText(`${element.textContent} ${element.getAttribute('aria-label') || ''} ${element.getAttribute('title') || ''}`);
        return /\b(select|add|confirm)\b/i.test(label);
      });
    (nestedAction || candidate.element).click();
  }

  function matchingResourceCandidate(root, nameParts) {
    return dialogCandidates(root)
      .filter(({ text }) => {
        const lower = text.toLowerCase();
        return nameParts.length ? nameParts.every((part) => lower.includes(part)) || lower.includes(nameParts[0]) : false;
      })
      .sort((left, right) => left.text.length - right.text.length)[0] || null;
  }

  function pickerIsOpen() {
    return visibleElements('[role="dialog"], [data-radix-dialog-content], [data-overlay-container]').length > 0;
  }

  function pickerHasNoResults(root) {
    const text = normalizeText(root.textContent);
    return /no results|no models found|nothing found|no resources found/i.test(text);
  }

  async function addResourceViaPicker(resource) {
    const name = resourceName(resource);
    const lookup = resource.lookup;
    const version = lookup?.name || resource.versionName || '';
    const modelName = lookup?.model?.name || resource.modelName || resource.name || name;
    const button = findResourceButton();
    if (!button) return { ok: false, reason: 'The Civitai + RESOURCE button was not found.' };
    const existingInputs = new Set(document.querySelectorAll('input:not([type="file"]), textarea'));
    button.click();
    const picker = await waitForDomCondition(() => {
      const root = getDialogRoot();
      const input = findSearchInput(root, existingInputs);
      return input ? { root, input } : null;
    });
    if (!picker) return { ok: false, reason: 'The resource picker did not expose its search field.' };
    const input = picker.input;
    dispatchInput(input, modelName);
    const nameParts = [modelName, version].filter(Boolean).map((part) => normalizeText(part).toLowerCase());
    const searchResult = await waitForDomCondition(() => {
      const root = getDialogRoot();
      const candidate = matchingResourceCandidate(root, nameParts);
      if (candidate) return { type: 'candidate', candidate };
      if (pickerHasNoResults(root)) return { type: 'empty' };
      return null;
    });
    if (!searchResult || searchResult.type === 'empty') return { ok: false, reason: `No matching Civitai resource result was found for ${name}.` };
    const candidate = searchResult.candidate;
    clickResourceCandidate(candidate);
    const actionResult = await waitForDomCondition(() => {
      const addButton = pickerActionButton(getDialogRoot());
      if (addButton) return { type: 'button', addButton };
      if (!pickerIsOpen()) return { type: 'closed' };
      return null;
    });
    if (!actionResult) return { ok: false, reason: `Civitai found ${name}, but its Select button was not available.` };
    if (actionResult.type === 'closed') return { ok: true };
    const addButton = actionResult.addButton;
    addButton.click();
    const closed = await waitForDomCondition(() => !pickerIsOpen());
    if (!closed) return { ok: false, reason: `Civitai did not close the resource picker after selecting ${name}.` };
    return { ok: true };
  }

  function exactResourceSelectButton(root, resource) {
    const versionId = resource.lookup?.id || resource.modelVersionId;
    if (!versionId) return null;
    const link = [...root.querySelectorAll('a[href]')]
      .find((element) => new URL(element.href, location.href).searchParams.get('modelVersionId') === String(versionId));
    if (link) {
      let card = link.parentElement;
      for (let depth = 0; card && card !== root && depth < 7; depth += 1, card = card.parentElement) {
        const select = visibleElements('button, [role="button"]', card)
          .find((button) => /^select$/i.test(normalizeText(button.textContent)));
        if (select) return select;
      }
    }

    const modelName = normalizeText(resource.lookup?.model?.name || resource.modelName || resource.name).toLowerCase();
    const versionName = normalizeText(resource.lookup?.name || resource.versionName).toLowerCase();
    if (!modelName || !versionName) return null;
    for (const select of visibleElements('button, [role="button"]', root).filter((button) => /^select$/i.test(normalizeText(button.textContent)))) {
      let card = select.parentElement;
      for (let depth = 0; card && card !== root && depth < 6; depth += 1, card = card.parentElement) {
        const text = normalizeText(card.textContent).toLowerCase();
        const versions = [...card.querySelectorAll('input, textarea')].map((field) => normalizeText(field.value).toLowerCase());
        if (text.includes(modelName) && versions.includes(versionName)) return select;
        if (card.querySelectorAll('button, [role="button"]').length > 8) break;
      }
    }
    return null;
  }

  async function watchGuidedPicker(dialog, resource, autoSelect) {
    const id = resourceId(resource);
    if (autoSelect) {
      const exactButton = await waitForDomCondition(() => exactResourceSelectButton(dialog, resource), 30000);
      if (state.guidedResourceId !== id) return;
      if (exactButton) {
        state.guidedSelectionPending = true;
        exactButton.click();
      } else {
        state.resourceAutomationActive = false;
        state.message = `No exact Civitai version match appeared for ${resourceName(resource)}. Select manually or close the picker to skip it.`;
        render();
      }
    }
    const closed = await waitForDomCondition(() => !dialog.isConnected || !visible(dialog), 120000);
    if (!closed || state.guidedResourceId !== id) return;
    if (state.guidedSelectionPending) state.added.add(id);
    else state.skipped.add(id);
    const wasAdded = state.guidedSelectionPending;
    state.guidedResourceId = '';
    state.guidedSelectionPending = false;
    state.message = `${resourceName(resource)} was ${wasAdded ? 'added' : 'skipped'}.`;
    addActivity(wasAdded ? 'success' : 'warning', `${resourceName(resource)} was ${wasAdded ? 'added' : 'skipped'}.`);
    setQueueStatus('applying', `Resources: ${state.added.size} added, ${state.skipped.size} skipped`);
    render();
    if (state.resourceAutomationActive || state.autoAdvanceResources) {
      await waitForDomQuiet(document.documentElement, 450, 5000);
      if (state.resourceAutomationActive) addResources({ autoSelect: true });
      else addResources();
    }
  }

  async function addResources({ autoSelect = false } = {}) {
    if (!state.resources.length || state.busy) return;
    if (pickerIsOpen()) {
      state.message = 'Finish or close the current Civitai resource picker before searching for the next resource.';
      render();
      return;
    }
    const remaining = state.resources.filter((resource) => resource.lookup && !state.added.has(resourceId(resource)) && !state.skipped.has(resourceId(resource)));
    const resource = remaining[0];
    if (!resource) {
      state.resourceAutomationActive = false;
      const unresolved = state.resources.filter((item) => !item.lookup).length;
      state.message = unresolved
        ? `All resolved resources are complete. ${unresolved} unresolved resource${unresolved === 1 ? ' was' : 's were'} skipped.`
        : 'All detected resources are complete.';
      if (state.promptFilled) completeActiveQueueItem(state.message);
      render();
      return;
    }
    state.busy = true;
    state.message = `Opening Civitai’s picker for ${resourceName(resource)}…`;
    render();
    const button = findResourceButton();
    if (!button) {
      state.busy = false;
      state.message = 'The Civitai + RESOURCE button was not found.';
      render();
      return;
    }
    const existingInputs = new Set(document.querySelectorAll('input:not([type="file"]), textarea'));
    button.click();
    const picker = await waitForDomCondition(() => {
      const root = getDialogRoot();
      const input = findSearchInput(root, existingInputs);
      return input ? { root, input } : null;
    });
    if (picker) {
      dispatchInput(picker.input, resource.lookup?.model?.name || resource.modelName || resource.name || resourceName(resource));
      state.guidedResourceId = resourceId(resource);
      state.guidedSelectionPending = false;
      state.message = autoSelect
        ? `Looking for the exact Civitai version of ${resourceName(resource)}…`
        : state.autoAdvanceResources
        ? `Select the correct result for ${resourceName(resource)}. The next search will open automatically.`
        : `Select the correct result for ${resourceName(resource)}, then use Find next resource.`;
      watchGuidedPicker(picker.root, resource, autoSelect);
    } else {
      state.message = 'The resource picker did not expose its search field.';
    }
    state.busy = false;
    render();
  }

  function metadataClipboardText() {
    const metadata = state.parsed?.metadata || {};
    const prompt = globalThis.CVMMetadata.getPromptFields(metadata);
    const lines = ['Civitai video generation metadata'];
    if (prompt.positive) lines.push(`Positive prompt: ${prompt.positive}`);
    if (prompt.negative) lines.push(`Negative prompt: ${prompt.negative}`);
    if (prompt.settings) lines.push(`Parameters: ${prompt.settings}`);
    if (metadata.workflow) lines.push(`Workflow: ${typeof metadata.workflow === 'string' ? metadata.workflow : JSON.stringify(metadata.workflow)}`);
    if (state.resources.length) {
      lines.push('', 'Resources:');
      state.resources.forEach((resource) => lines.push(`- ${resourceName(resource)}${resourceUrl(resource) ? ` — ${resourceUrl(resource)}` : ''}`));
    }
    return lines.join('\n');
  }

  function elementLabel(element) {
    const explicit = element.id
      ? [...document.querySelectorAll('label')].find((label) => label.htmlFor === element.id)
      : null;
    const wrapping = element.closest('label');
    return normalizeText([
      explicit?.textContent,
      wrapping?.textContent,
      element.getAttribute('aria-label'),
      element.getAttribute('placeholder'),
      element.getAttribute('name'),
      element.getAttribute('data-placeholder')
    ].filter(Boolean).join(' '));
  }

  function findEditPromptButton(root = currentTargetRoot()) {
    const explicitlyNamed = visibleElements('button, [role="button"]', root)
      .filter((element) => !element.closest(`#${EXTENSION_ID}`))
      .map((element) => ({
        element,
        label: normalizeText(`${element.textContent} ${element.getAttribute('aria-label') || ''} ${element.getAttribute('title') || ''}`)
      }))
      .filter(({ label }) => /edit\s+(generation\s+)?prompt/i.test(label))
      .sort((left, right) => (/^edit prompt$/i.test(left.label) ? -1 : 1) - (/^edit prompt$/i.test(right.label) ? -1 : 1))[0]?.element || null;
    if (explicitlyNamed) return explicitlyNamed;

    const promptHeading = visibleElements('h1, h2, h3, h4, h5, h6', root)
      .find((heading) => /^prompt$/i.test(normalizeText(heading.textContent)) && !heading.closest(`#${EXTENSION_ID}`));
    if (!promptHeading) return null;
    let container = promptHeading.parentElement;
    for (let depth = 0; container && container !== document.body && depth < 4; depth += 1, container = container.parentElement) {
      const editButton = visibleElements('button, [role="button"]', container)
        .find((element) => /^edit$/i.test(normalizeText(`${element.textContent} ${element.getAttribute('aria-label') || ''} ${element.getAttribute('title') || ''}`)));
      if (editButton) return editButton;
    }
    return null;
  }

  function promptEditors(root = document) {
    return visibleElements('textarea, input:not([type]), input[type="text"], [contenteditable="true"]', root)
      .filter((element) => !element.closest(`#${EXTENSION_ID}`));
  }

  function scorePromptEditor(element, negative = false) {
    const label = elementLabel(element).toLowerCase();
    const surrounding = normalizeText(element.parentElement?.textContent || '').slice(0, 300).toLowerCase();
    const text = `${label} ${surrounding}`;
    if (negative) return (/negative\s+prompt/.test(text) ? 100 : /negative/.test(text) ? 60 : -100);
    return (/positive\s+prompt/.test(text) ? 110 : /generation\s+prompt/.test(text) ? 100 : /\bprompt\b/.test(label) ? 80 : /\bprompt\b/.test(text) ? 30 : 0)
      - (/negative/.test(text) ? 150 : 0)
      - (/search|title|description/.test(label) ? 100 : 0);
  }

  function findPromptEditor(root, negative = false) {
    const scored = promptEditors(root)
      .map((element) => ({ element, score: scorePromptEditor(element, negative) }))
      .filter(({ score }) => score > 0)
      .sort((left, right) => right.score - left.score);
    return scored[0]?.element || null;
  }

  function promptEditorRoot(editor) {
    const modal = editor.closest('[role="dialog"], [data-radix-dialog-content], [data-overlay-container], form');
    if (modal) return modal;
    let root = editor.parentElement;
    for (let depth = 0; root && root !== document.body && depth < 5; depth += 1, root = root.parentElement) {
      if (/prompt/i.test(normalizeText(root.textContent)) && root.querySelector('button, [role="button"]')) return root;
    }
    return null;
  }

  function findPromptSaveButton(root) {
    if (!root) return null;
    return visibleElements('button, [role="button"]', root)
      .filter((element) => !element.closest(`#${EXTENSION_ID}`) && !element.disabled)
      .map((element) => ({
        element,
        label: normalizeText(`${element.textContent} ${element.getAttribute('aria-label') || ''} ${element.getAttribute('title') || ''}`)
      }))
      .filter(({ label }) => /^(save|done|confirm|update)(\s+prompt)?$/i.test(label))
      .sort((left, right) => (/^save/i.test(left.label) ? -1 : 1) - (/^save/i.test(right.label) ? -1 : 1))[0]?.element || null;
  }

  async function fillCivitaiPrompt() {
    if (state.busy) return;
    if (!hasPromptTarget()) {
      state.message = 'Multiple videos are present and this file is not bound to a Civitai row. Use this file in Civitai upload first.';
      render();
      return;
    }
    const prompt = globalThis.CVMMetadata.getPromptFields(state.parsed?.metadata || {});
    if (!prompt.positive) {
      state.message = 'No positive prompt was found in the video metadata.';
      render();
      return;
    }
    const button = findEditPromptButton();
    if (!button) {
      state.message = 'Civitai’s Edit prompt button was not found. Open the uploaded video’s prompt section, then try again.';
      render();
      return;
    }
    state.busy = true;
    state.message = 'Opening Civitai’s prompt editor…';
    render();
    const existingEditors = new Set(promptEditors());
    button.click();
    const editor = await waitForDomCondition(() => {
      const dialogs = visibleElements('[role="dialog"], [data-radix-dialog-content], [data-overlay-container]');
      const root = dialogs[dialogs.length - 1] || document;
      const candidate = findPromptEditor(root);
      if (candidate && (root !== document || !existingEditors.has(candidate))) return candidate;
      return promptEditors(root).find((freshEditor) => !existingEditors.has(freshEditor)) || null;
    });
    if (!editor) {
      state.busy = false;
      state.message = 'Civitai opened no recognizable prompt editor. Use Copy prompt and paste it into Edit prompt.';
      render();
      return;
    }
    const root = promptEditorRoot(editor);
    dispatchInput(editor, prompt.positive);
    const negativeEditor = findPromptEditor(root || document, true);
    if (negativeEditor && negativeEditor !== editor && prompt.negative) dispatchInput(negativeEditor, prompt.negative);
    const generation = globalThis.CVMMetadata.getGenerationFields(state.parsed?.metadata || {});
    const fillLabeledField = (label, value) => {
      if (value === null || value === undefined || value === '') return;
      const field = visibleElements('textarea, input:not([type="file"]), [contenteditable="true"]', root || document)
        .find((element) => label.test(elementLabel(element)));
      if (field && field !== editor && field !== negativeEditor) dispatchInput(field, String(value));
    };
    fillLabeledField(/^guidance scale$/i, generation.guidanceScale);
    fillLabeledField(/^steps$/i, generation.steps);
    fillLabeledField(/^sampler$/i, generation.sampler);
    fillLabeledField(/^seed$/i, generation.seed);
    const saveButton = await waitForDomCondition(() => findPromptSaveButton(root), 3000);
    if (saveButton) {
      saveButton.click();
      await waitForDomCondition(() => !visible(editor) || !visible(saveButton), 8000);
      state.message = prompt.negative && negativeEditor
        ? 'Positive and negative prompts were added to Civitai. Review them before submitting.'
        : 'The positive prompt was added to Civitai. Review it before submitting.';
      addActivity('success', 'Prompt and available generation settings were filled.');
    } else {
      state.message = 'The prompt was inserted. Civitai’s confirmation button was not recognized, so review the editor and save it manually.';
    }
    state.promptFilled = true;
    state.busy = false;
    render();
    if (!state.resources.some((resource) => resource.lookup)) completeActiveQueueItem('Prompt filled; no resolved resources required.');
  }

  async function copyPrompt() {
    const prompt = globalThis.CVMMetadata.getPromptFields(state.parsed?.metadata || {});
    try {
      await navigator.clipboard.writeText(prompt.positive || '');
      state.message = 'Positive prompt copied to the clipboard.';
    } catch (_) {
      state.message = 'Clipboard access was unavailable.';
    }
    render();
  }

  async function copyMetadata() {
    try {
      await navigator.clipboard.writeText(metadataClipboardText());
      state.message = 'Metadata copied to the clipboard.';
    } catch (_) {
      state.message = 'Clipboard access was unavailable. Select the metadata manually from the panel.';
    }
    render();
  }

  async function handleAction(action) {
    if (action === 'scan') return scanFile();
    if (action === 'choose') return getPanel()?.querySelector('#cvm-file-picker')?.click();
    if (action === 'upload') return useFileInCivitaiUpload();
    if (action === 'add') return addResources();
    if (action === 'auto-add') {
      state.resourceAutomationActive = true;
      return addResources({ autoSelect: true });
    }
    if (action === 'copy') return copyMetadata();
    if (action === 'copy-prompt') return copyPrompt();
    if (action === 'prompt') return fillCivitaiPrompt();
    if (action === 'next') return resetForNextVideo();
    if (action === 'clear-log') {
      state.activity = [];
      return render();
    }
  }

  function handleQueueAction(action, id) {
    const item = state.queue.find((candidate) => candidate.id === id);
    if (!item) return;
    if (action === 'retry') {
      item.status = 'waiting';
      item.message = 'Waiting to retry';
      return activateQueueItem(item);
    }
    if (action === 'remove') {
      state.queue = state.queue.filter((candidate) => candidate.id !== id);
      addActivity('info', 'Removed from the queue.', item);
      if (state.activeQueueId === id) {
        state.activeQueueId = '';
        const next = state.queue.find((candidate) => candidate.status === 'waiting');
        return activateQueueItem(next);
      }
      render();
    }
  }

  function resetForNextVideo() {
    const current = activeQueueItem();
    if (current && current.status !== 'complete') {
      current.status = 'skipped';
      current.message = 'Skipped by user';
      addActivity('warning', 'Skipped before completion.', current);
    }
    const next = state.queue.find((candidate) => candidate.status === 'waiting');
    if (next) return activateQueueItem(next);
    state.activeQueueId = '';
    clearCurrentVideoState();
    state.message = 'Ready for the next video. Drop it into Step 1.';
    render();
  }

  async function runAutomaticWorkflow(scanToken) {
    const queueId = state.activeQueueId;
    if (scanToken !== state.scanToken || !state.autoEverything) return;
    await useFileInCivitaiUpload();
    if (scanToken !== state.scanToken || state.targetMediaFileKey !== state.fileKey) return;
    await fillCivitaiPrompt();
    if (scanToken !== state.scanToken || state.activeQueueId !== queueId) return;
    if (!state.resources.some((resource) => resource.lookup)) return;
    state.resourceAutomationActive = true;
    await addResources({ autoSelect: true });
  }

  let lastObservedFileKey = '';
  function detectFileChanges() {
    const file = getFileFromPage();
    const key = file ? `${file.name}:${file.size}:${file.lastModified}` : '';
    if (key && key === state.ignoredPageFileKey) return;
    if (key && key !== lastObservedFileKey) {
      state.ignoredPageFileKey = '';
      lastObservedFileKey = key;
      scanFile(file);
    }
  }

  function init() {
    const isUploadRoute = () => /^\/posts\/(?:create|\d+\/edit)\/?$/.test(location.pathname);
    const uploadRouteKey = () => isUploadRoute() ? location.pathname.replace(/\/$/, '') : '';
    let previousUploadRouteKey = uploadRouteKey();
    const syncPanel = () => {
      const currentUploadRouteKey = uploadRouteKey();
      if (currentUploadRouteKey !== previousUploadRouteKey) {
        const createBecameEdit = previousUploadRouteKey === '/posts/create'
          && /^\/posts\/\d+\/edit$/.test(currentUploadRouteKey);
        if (!createBecameEdit) resetUploadSession();
        previousUploadRouteKey = currentUploadRouteKey;
      }
      if (currentUploadRouteKey) createPanel();
      else getPanel()?.remove();
    };
    syncPanel();
    new MutationObserver(() => {
      syncPanel();
      if (isUploadRoute()) detectFileChanges();
    }).observe(document.documentElement, { childList: true, subtree: true });
    document.addEventListener('change', detectFileChanges, true);
    document.addEventListener('drop', (event) => {
      if (event.target?.closest?.(`#${EXTENSION_ID}`)) return;
      const file = [...(event.dataTransfer?.files || [])].find((candidate) => candidate.type.startsWith('video/') || /\.(mp4|webm)$/i.test(candidate.name));
      if (file) {
        lastObservedFileKey = '';
        scanFile(file);
      }
    }, true);
    document.addEventListener('click', (event) => {
      if (!state.guidedResourceId) return;
      const button = event.target?.closest?.('button, [role="button"]');
      if (!button || button.closest(`#${EXTENSION_ID}`)) return;
      if (!/^select$/i.test(normalizeText(`${button.textContent} ${button.getAttribute('aria-label') || ''}`))) return;
      const dialog = button.closest('[role="dialog"], [data-radix-dialog-content], [data-overlay-container]');
      if (!dialog) return;
      state.guidedSelectionPending = true;
    }, true);
    if (isUploadRoute()) detectFileChanges();
    window.addEventListener('message', (event) => {
      if (event.source === window && event.data?.source === 'cvm-assistant' && event.data.type === 'scan') scanFile();
    });
    const extensionApi = globalThis.browser || globalThis.chrome;
    extensionApi?.runtime?.onMessage?.addListener((message) => {
      if (message?.type === 'scan') scanFile();
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();
