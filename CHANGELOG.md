# Changelog

## 0.6.21 - 2026-09-21

- Queue every video dropped directly onto Civitai and bind each file to its own media row.
- Recover the correct media row after Civitai rerenders it while prompts and resources are being applied.
- Ignore unrelated page dialogs when deciding whether the Civitai resource picker is open.

## 0.6.20 - 2026-09-21

- Prevent asynchronous resource-picker work from one queued video leaking into the next video when both contain the same resources.
- Advance the multi-video queue immediately after the final resolved resource is added or skipped.

## 0.6.19 - 2026-09-21

- Fix MP4 metadata parsing dropping the first four characters of positive prompts written by FFmpeg.
- Validate MP4 metadata parsing against a real FFmpeg-generated fixture in addition to synthetic atom tests.

## 0.6.18 - 2026-09-17

- Automatically open a resource card's version dropdown and select the exact Civitai model version resolved from the video's metadata before pressing Select.
- Prefer exact version IDs and require exact version-name matches so older versions are not confused with similarly named newer releases.

## 0.6.17 - 2026-09-16

- Preserve the `icons/` and `src/` directory structure in Windows release ZIPs.
- Make packaging fail when any icon, popup, script, or stylesheet referenced by the manifest is absent at its exact archive path.

## 0.6.16 - 2026-09-16

- Refine the extension icon into an original red faceted hexagon that combines a video play symbol with metadata rows while remaining distinct from Civitai's official logo.

## 0.6.15 - 2026-09-16

- Replace the toolbar and extension-listing artwork with a high-contrast video-and-metadata icon designed to remain recognizable at 16–32 px.

## 0.6.14 - 2026-09-16

- Scope already-attached resource detection to the current video row so repeated resources are added independently to every uploaded video.
- Add tool, extension, workflow, and other auxiliary resources before LoRAs and base checkpoints to avoid Civitai's model-compatibility filtering hiding them later.

## 0.6.13 - 2026-08-29

- Add a dedicated video-and-metadata icon for browser toolbars and extension listings.

## 0.6.12 - 2026-08-29

- Build the assistant panel entirely with DOM APIs instead of parsing dynamic HTML.
- Pass Mozilla's add-on validator with no errors, warnings, or notices.

## 0.6.11 - 2026-08-29

- Declare that the Firefox extension does not collect data, as required by Mozilla's built-in data-consent validation.
- Replace dynamic `innerHTML` assignments with DOM fragment replacement and keep all interpolated values escaped.

## 0.6.10 - 2026-08-29

- Bind direct Civitai video drops to the newly created media row before applying prompts or resources.
- Identify new uploads by media-row count and position so rerendered older video elements cannot steal the binding.

## 0.6.9 - 2026-08-29

- Scan the complete Civitai Resources card instead of stopping at its header row.
- Recover from an already-open duplicate picker by recognizing the attached model and closing the picker.

## 0.6.8 - 2026-08-29

- Detect resources Civitai preattaches when a post is started from a model gallery.
- Skip duplicate searches by exact version ID, model ID, or the visible model name when IDs are not exposed.

## 0.6.7 - 2026-08-28

- Retry resource searches by resolved and embedded model names when AutoV2 returns an explicit no-results state.
- Ignore the resource picker's initial empty state until the entered query has produced a DOM transition.

## 0.6.6 - 2026-08-28

- Search Civitai's resource picker with 10-character AutoV2 hashes.
- Derive AutoV2 from embedded full SHA-256 hashes and prefer Civitai's explicit AutoV2 value when available.

## 0.6.5 - 2026-08-28

- Search Civitai's resource picker by embedded model hash instead of ambiguous resource names.
- Fall back to hashes from Civitai's version API, then to the model name only when no hash is available.

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
