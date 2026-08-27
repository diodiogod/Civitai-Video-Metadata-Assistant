(function () {
  'use strict';
  const api = globalThis.browser || globalThis.chrome;
  const button = document.getElementById('scan');
  const status = document.getElementById('status');

  async function sendScan(tabId) {
    try {
      await api.tabs.sendMessage(tabId, { type: 'scan' });
      return { ok: true };
    } catch (messageError) {
      // If the add-on was loaded after the Civitai tab, the manifest content
      // script was not injected into that already-open page. Inject it from
      // the action popup without reloading the upload form.
      if (!api.scripting) return { ok: false, reason: 'Firefox did not expose the scripting API. Reload the temporary add-on.' };
      try {
        try {
          await api.scripting.insertCSS({ target: { tabId }, files: ['src/content.css'] });
        } catch (_) {
          // CSS is already supplied by the manifest on normal page loads;
          // do not prevent JavaScript injection if CSS insertion is rejected.
        }
        await api.scripting.executeScript({ target: { tabId }, files: ['src/metadata.js', 'src/content.js'] });
        await new Promise((resolve) => setTimeout(resolve, 100));
        await api.tabs.sendMessage(tabId, { type: 'scan' });
        return { ok: true };
      } catch (injectionError) {
        const detail = injectionError?.message || messageError?.message || String(injectionError);
        return { ok: false, reason: detail };
      }
    }
  }

  button.addEventListener('click', async () => {
    button.disabled = true;
    status.textContent = 'Connecting to the current Civitai page…';
    const tabs = await api.tabs.query({ active: true, currentWindow: true });
    const tab = tabs[0];
    if (!tab?.id) {
      status.textContent = 'No active tab was found.';
      button.disabled = false;
      return;
    }
    const result = await sendScan(tab.id);
    status.textContent = result.ok
      ? 'Assistant activated on the page. Close this popup and use its panel.'
      : `Could not activate the assistant: ${result.reason}`;
    button.disabled = false;
  });
})();
