const test = require('node:test');
const assert = require('node:assert/strict');
const metadata = require('../src/metadata.js');

function u32(value) {
  return Uint8Array.from([(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255]);
}

function concat(...parts) {
  const result = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

function mp4Box(type, payload) {
  const header = concat(u32(payload.length + 8), new TextEncoder().encode(type));
  return concat(header, payload);
}

function mp4Data(value) {
  return mp4Box('data', concat(u32(1), u32(0), u32(0), new TextEncoder().encode(value)));
}

function mp4Fixture(entries) {
  const keys = [];
  const items = [];
  let index = 1;
  for (const [key, value] of Object.entries(entries)) {
    const keyBytes = new TextEncoder().encode(key);
    keys.push(concat(u32(keyBytes.length + 8), new TextEncoder().encode('mdta'), keyBytes));
    const itemPayload = mp4Data(value);
    items.push(concat(u32(itemPayload.length + 8), u32(index), itemPayload));
    index += 1;
  }
  const keysBox = mp4Box('keys', concat(u32(0), u32(keys.length), ...keys));
  const ilstBox = mp4Box('ilst', concat(...items));
  const metaBox = mp4Box('meta', concat(u32(0), keysBox, ilstBox));
  const udta = mp4Box('udta', metaBox);
  const moov = mp4Box('moov', udta);
  return concat(new TextEncoder().encode('\x00\x00\x00\x18ftypisom\x00\x00\x02\x00isomiso2'), moov);
}

function ebmlVint(value) {
  if (value < 128) return Uint8Array.from([0x80 | value]);
  if (value < 16384) return Uint8Array.from([0x40 | (value >>> 8), value & 255]);
  throw new Error('test fixture too large');
}

function ebmlElement(id, payload) {
  const idBytes = id > 0xffffff ? Uint8Array.from([(id >>> 24) & 255, (id >>> 16) & 255, (id >>> 8) & 255, id & 255]) : id > 0xffff ? Uint8Array.from([(id >>> 16) & 255, (id >>> 8) & 255, id & 255]) : id > 0xff ? Uint8Array.from([(id >>> 8) & 255, id & 255]) : Uint8Array.from([id]);
  return concat(idBytes, ebmlVint(payload.length), payload);
}

test('parses MP4 mdta prompt, workflow, parameters, and resources', () => {
  const bytes = mp4Fixture({
    prompt: '{"1":{"class_type":"KSampler"}}',
    workflow: '{"nodes":[]}',
    parameters: 'positive\nNegative prompt: negative\nSteps: 12, Civitai resources: [{"modelVersionId":123,"type":"lora"}]'
  });
  const parsed = metadata.parseVideoBytes(bytes);
  assert.equal(parsed.container, 'mp4');
  assert.deepEqual(parsed.metadata.prompt, { '1': { class_type: 'KSampler' } });
  assert.deepEqual(parsed.metadata.workflow, { nodes: [] });
  const fields = metadata.getPromptFields(parsed.metadata);
  assert.equal(fields.positive, 'positive');
  assert.equal(fields.negative, 'negative');
  assert.deepEqual(metadata.extractResources(parsed.metadata), [{ modelVersionId: 123, type: 'lora' }]);
});

test('parses WebM SimpleTag metadata', () => {
  const simpleTag = ebmlElement(0x67c8, concat(
    ebmlElement(0x45a3, new TextEncoder().encode('parameters')),
    ebmlElement(0x4487, new TextEncoder().encode('a prompt'))
  ));
  const tag = ebmlElement(0x7373, simpleTag);
  const tags = ebmlElement(0x1254c367, tag);
  const segment = ebmlElement(0x18538067, tags);
  const bytes = concat(ebmlElement(0x1a45dfa3, ebmlElement(0x4286, Uint8Array.from([1]))), segment);
  const parsed = metadata.parseVideoBytes(bytes);
  assert.equal(parsed.container, 'webm');
  assert.equal(parsed.metadata.parameters, 'a prompt');
});

test('extracts hash and AIR resources from Comfy/A1111 metadata', () => {
  const resources = metadata.extractResources({
    parameters: 'prompt\nNegative prompt: bad\nSteps: 8, Hashes: {"model":"ABCDEF1234","LORA:detail":"1234567890"}',
    workflow: JSON.stringify({ extra: 'urn:air:sdxl:lora:civitai:456@789' })
  });
  assert.ok(resources.some((resource) => resource.hash === 'ABCDEF1234' && resource.type === 'checkpoint'));
  assert.ok(resources.some((resource) => resource.hash === '1234567890' && resource.type === 'lora'));
  assert.ok(resources.some((resource) => resource.modelVersionId === 789 && resource.modelId === 456));
});

test('returns unknown for unsupported containers without throwing', () => {
  assert.deepEqual(metadata.parseVideoBytes(new Uint8Array([1, 2, 3, 4])), { container: 'unknown', metadata: {} });
});

test('extracts positive and negative prompts from structured metadata', () => {
  const fields = metadata.getPromptFields({
    generation: {
      positive_prompt: 'cinematic tracking shot',
      negativePrompt: 'blurry, artifacts',
      generation_parameters: 'Steps: 20, CFG scale: 5'
    }
  });
  assert.equal(fields.positive, 'cinematic tracking shot');
  assert.equal(fields.negative, 'blurry, artifacts');
  assert.equal(fields.settings, 'Steps: 20, CFG scale: 5');
});

test('extracts prompts from a ComfyUI graph containing Python NaN', () => {
  const fields = metadata.getPromptFields({
    prompt: '{"124":{"inputs":{"positive":"a moving camera","negative":"blur"},"class_type":"SimplePromptStandalone","is_changed":NaN}}'
  });
  assert.equal(fields.positive, 'a moving camera');
  assert.equal(fields.negative, 'blur');
});

test('extracts generation fields from a ComfyUI prompt graph', () => {
  const fields = metadata.getGenerationFields({
    prompt: JSON.stringify({
      seed: { inputs: { noise_seed: 12345 }, class_type: 'RandomNoise' },
      sampler: { inputs: { sampler_name: 'euler' }, class_type: 'KSamplerSelect' },
      schedule: { inputs: { steps: 10, cfg: 4.5, scheduler: 'karras' }, class_type: 'BasicScheduler' }
    })
  });
  assert.deepEqual(fields, { steps: 10, sampler: 'euler', scheduler: 'karras', seed: 12345, guidanceScale: 4.5 });
});

test('extracts scheduler from A1111 Schedule type', () => {
  const fields = metadata.getGenerationFields({
    parameters: 'prompt\nNegative prompt: blur\nSteps: 12, Sampler: Euler, Schedule type: beta, CFG scale: 5, Seed: 42'
  });
  assert.equal(fields.scheduler, 'beta');
});

test('prefers an embedded AutoV2 resource hash for Civitai picker searches', () => {
  const search = metadata.getResourceSearchQuery({
    hash: '08CFE94603',
    name: 'ambiguous local filename',
    lookup: { model: { name: 'Different Civitai title' } }
  });
  assert.deepEqual(search, { query: '08CFE94603', method: 'embedded AutoV2 hash' });
});

test('derives an AutoV2 picker hash from an embedded SHA-256 hash', () => {
  const search = metadata.getResourceSearchQuery({
    hash: '646BA7972C98B06AE5211265C02FA89219809D024FD232AF41C655E8B882677C'
  });
  assert.deepEqual(search, {
    query: '646BA7972C',
    method: 'AutoV2 derived from embedded SHA-256'
  });
});

test('prefers a resolved Civitai AutoV2 hash before falling back to a name', () => {
  const search = metadata.getResourceSearchQuery({
    name: 'local name',
    lookup: {
      model: { name: 'Civitai model name' },
      files: [{ hashes: { SHA256: 'ABCDEF0123456789', AutoV2: 'ABCDEF0123' } }]
    }
  });
  assert.deepEqual(search, { query: 'ABCDEF0123', method: 'Civitai AutoV2 hash' });
});

test('derives AutoV2 when a resolved file only has SHA-256', () => {
  const search = metadata.getResourceSearchQuery({
    lookup: {
      files: [{ hashes: { SHA256: '1234567890ABCDEF1234567890ABCDEF1234567890ABCDEF1234567890ABCDEF' } }]
    }
  });
  assert.deepEqual(search, {
    query: '1234567890',
    method: 'AutoV2 derived from Civitai SHA-256'
  });
});

test('falls back to the resolved Civitai model name when no hash exists', () => {
  const search = metadata.getResourceSearchQuery({
    name: 'local name',
    lookup: { model: { name: 'Civitai model name' } }
  });
  assert.deepEqual(search, { query: 'Civitai model name', method: 'name fallback' });
});

test('builds a unique hash-to-name fallback sequence for picker searches', () => {
  const searches = metadata.getResourceSearchQueries({
    hash: '646BA7972C98B06AE5211265C02FA89219809D024FD232AF41C655E8B882677C',
    name: 'local-resource.safetensors',
    modelName: 'Metadata model title',
    lookup: { model: { name: 'Resolved Civitai title' } }
  });
  assert.deepEqual(searches, [
    { query: '646BA7972C', method: 'AutoV2 derived from embedded SHA-256' },
    { query: 'Resolved Civitai title', method: 'resolved Civitai model name' },
    { query: 'Metadata model title', method: 'metadata model name' },
    { query: 'local-resource.safetensors', method: 'metadata resource name' }
  ]);
});

test('does not repeat the same name in picker fallback searches', () => {
  const searches = metadata.getResourceSearchQueries({
    name: 'Same model',
    modelName: 'same MODEL',
    lookup: { model: { name: 'Same Model' } }
  });
  assert.deepEqual(searches, [
    { query: 'Same Model', method: 'name fallback' }
  ]);
});
