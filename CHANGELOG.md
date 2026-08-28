# Changelog

## 0.6.4 - 2026-08-28

- Commit and blur Civitai's controlled Seed input before the extension programmatically saves the prompt form.

## 0.6.3 - 2026-08-28

- Fill Civitai's specially controlled Seed input through native text insertion and verify that React retained the complete value.

## 0.6.2 - 2026-08-28

- Wait for Civitai's complete prompt form instead of racing its delayed secondary-field render.
- Target Civitai's stable field names for guidance, steps, sampler, seed, and negative prompt.
- Select sampler values through the Mantine dropdown rather than assigning uncommitted text.

## 0.6.1 - 2026-08-28

- Fixed Civitai's nested prompt-dialog detection so negative prompt and generation fields are filled alongside the positive prompt.
- Recognize labels supplied by `aria-labelledby` and single-control field wrappers.

## 0.6.0 - 2026-08-28

- Added a persistent collapse/expand control to the on-page upload assistant for smaller screens.
- Added scheduler extraction and conditional filling alongside prompt, negative prompt, steps, sampler, seed, and guidance scale.
- Show detected generation settings in the metadata review summary before filling Civitai.

## 0.5.3 - 2026-08-27

- Pointed metadata-creation guidance to the maintained ComfyUI Video Saver fork.
- Added a companion saver link to the extension popup.

## 0.5.2 - 2026-08-27

- Added sequential multi-video queues with automatic and manual processing.
- Bound metadata actions to the correct Civitai video row.
- Added prompt, negative prompt, steps, sampler, seed, and guidance-scale filling.
- Added exact Civitai resource matching, guided fallback, skip handling, and activity reporting.
- Added automatic session cleanup when leaving Civitai's create/edit workflow.
- Added Firefox, Edge, Chrome, `civitai.com`, and `civitai.red` support.
- Added local MP4/WebM metadata parsing and ComfyUI/A1111 metadata extraction.
