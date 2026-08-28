(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.CVMMetadata = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const MAX_FILE_BYTES = 512 * 1024 * 1024;
  const MAX_METADATA_BYTES = 4 * 1024 * 1024;
  const MAX_VALUE_BYTES = 2 * 1024 * 1024;
  const MAX_ELEMENTS = 10000;
  const textDecoder = new TextDecoder('utf-8', { fatal: false });

  function ascii(bytes, start, end) {
    let value = '';
    for (let index = start; index < end; index += 1) {
      const code = bytes[index];
      value += code >= 32 && code <= 126 ? String.fromCharCode(code) : '\u0000';
    }
    return value;
  }

  function utf8(bytes, start, end) {
    return textDecoder.decode(bytes.subarray(start, end)).replace(/\u0000+$/g, '').trim();
  }

  function uint32(bytes, offset) {
    if (offset + 4 > bytes.length) return null;
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, false);
  }

  function uint64(bytes, offset) {
    if (offset + 8 > bytes.length) return null;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const high = view.getUint32(offset, false);
    const low = view.getUint32(offset + 4, false);
    const value = high * 4294967296 + low;
    return Number.isSafeInteger(value) ? value : null;
  }

  function fourcc(bytes, offset) {
    return offset + 4 <= bytes.length ? ascii(bytes, offset, offset + 4) : '';
  }

  function readMp4Box(bytes, offset, limit) {
    if (offset + 8 > limit || offset + 8 > bytes.length) return null;
    const declaredSize = uint32(bytes, offset);
    if (declaredSize === null) return null;
    const type = fourcc(bytes, offset + 4);
    let headerSize = 8;
    let size = declaredSize;
    if (declaredSize === 1) {
      size = uint64(bytes, offset + 8);
      headerSize = 16;
    } else if (declaredSize === 0) {
      size = limit - offset;
    }
    if (size === null || size < headerSize || offset + size > limit || offset + size > bytes.length) return null;
    return { offset, size, type, headerSize, dataStart: offset + headerSize, end: offset + size };
  }

  function safeJson(value) {
    if (typeof value !== 'string') return value;
    const trimmed = value.trim();
    if (!trimmed || !['{', '[', '"'].includes(trimmed[0])) return value;
    try {
      return JSON.parse(trimmed);
    } catch (_) {
      // Python's json encoder may emit non-standard NaN/Infinity values in
      // ComfyUI prompt graphs. Replace only values in JSON positions, not
      // matching words inside quoted prompt text.
      const normalized = trimmed.replace(
        /([:\[,]\s*)(?:NaN|-?Infinity)(?=\s*[,}\]])/g,
        '$1null'
      );
      if (normalized !== trimmed) {
        try {
          return JSON.parse(normalized);
        } catch (_) {
          // Keep the original metadata text when it is not JSON after all.
        }
      }
      return value;
    }
  }

  function canonicalKey(key) {
    const normalized = String(key).trim().toLowerCase().replace(/[^a-z0-9]/g, '');
    const aliases = {
      comfyuiprompt: 'prompt',
      comfyprompt: 'prompt',
      comfyuiworkflow: 'workflow',
      comfyworkflow: 'workflow',
      generationparameters: 'parameters',
      generationparameter: 'parameters',
      extrametadata: 'extraMetadata',
      civitairesources: 'civitaiResources',
      civitairesource: 'civitaiResources'
    };
    if (aliases[normalized]) return aliases[normalized];
    if (normalized === 'prompt') return 'prompt';
    if (normalized === 'workflow') return 'workflow';
    if (normalized === 'parameters' || normalized === 'parameter') return 'parameters';
    if (normalized === 'extrametadata' || normalized === 'metadata') return 'extraMetadata';
    if (normalized === 'civitairesources') return 'civitaiResources';
    return String(key).trim();
  }

  function addMetadataValue(target, key, value) {
    if (!key || value === undefined || value === null) return;
    const text = typeof value === 'string' ? value.trim() : value;
    if (text === '') return;
    const canonical = canonicalKey(key);
    if (typeof text === 'string' && text.length > MAX_VALUE_BYTES) return;
    target[canonical] = safeJson(text);
  }

  function parseMp4Keys(bytes, box, keys) {
    const start = box.dataStart;
    if (start + 8 > box.end) return;
    const count = uint32(bytes, start + 4);
    if (count === null || count > MAX_ELEMENTS) return;
    let cursor = start + 8;
    for (let index = 1; index <= count && cursor + 4 <= box.end; index += 1) {
      const entrySize = uint32(bytes, cursor);
      if (entrySize === null || entrySize < 8 || cursor + entrySize > box.end) break;
      const name = ascii(bytes, cursor + 8, cursor + entrySize).replace(/\u0000/g, '').trim();
      if (name) keys[index] = name;
      cursor += entrySize;
    }
  }

  function readMp4DataValue(bytes, dataBox) {
    const start = dataBox.dataStart;
    if (start + 12 > dataBox.end) return null;
    const dataType = uint32(bytes, start + 4);
    const valueStart = start + 12;
    if (valueStart >= dataBox.end || dataBox.end - valueStart > MAX_VALUE_BYTES) return null;
    if (dataType === 1 || dataType === 0) return utf8(bytes, valueStart, dataBox.end);
    return null;
  }

  function parseMp4Ilst(bytes, box, keys, target) {
    let cursor = box.dataStart;
    let count = 0;
    while (cursor < box.end && count < MAX_ELEMENTS) {
      const item = readMp4Box(bytes, cursor, box.end);
      if (!item) break;
      count += 1;
      const keyIndex = uint32(bytes, item.offset + 4);
      const keyName = keyIndex !== null ? keys[keyIndex] : null;
      if (keyName) {
        let childCursor = item.dataStart;
        while (childCursor < item.end) {
          const child = readMp4Box(bytes, childCursor, item.end);
          if (!child) break;
          if (child.type === 'data') {
            const value = readMp4DataValue(bytes, child);
            if (value !== null) addMetadataValue(target, keyName, value);
          }
          childCursor = child.end;
        }
      }
      cursor = item.end;
    }
  }

  function parseMp4Meta(bytes, box, target) {
    if (box.dataStart + 4 > box.end) return;
    let keys = {};
    let ilst = null;
    let cursor = box.dataStart + 4;
    while (cursor < box.end) {
      const child = readMp4Box(bytes, cursor, box.end);
      if (!child) break;
      if (child.type === 'keys') parseMp4Keys(bytes, child, keys);
      if (child.type === 'ilst') ilst = child;
      cursor = child.end;
    }
    if (ilst) parseMp4Ilst(bytes, ilst, keys, target);
  }

  function parseMp4(bytes) {
    const result = {};
    const containers = new Set(['moov', 'udta', 'trak', 'mdia', 'minf', 'stbl', 'edts', 'dinf', 'mvex', 'moof']);
    let visited = 0;
    function walk(start, end, depth) {
      if (depth > 8 || visited >= MAX_ELEMENTS) return;
      let cursor = start;
      while (cursor < end && visited < MAX_ELEMENTS) {
        const box = readMp4Box(bytes, cursor, end);
        if (!box) break;
        visited += 1;
        if (box.type === 'meta') parseMp4Meta(bytes, box, result);
        else if (containers.has(box.type)) walk(box.dataStart, box.end, depth + 1);
        cursor = box.end;
      }
    }
    walk(0, bytes.length, 0);
    return result;
  }

  function readEbmlVint(bytes, offset, forSize) {
    if (offset >= bytes.length) return null;
    const first = bytes[offset];
    let width = 1;
    let mask = 0x80;
    while (width <= 8 && (first & mask) === 0) {
      mask >>= 1;
      width += 1;
    }
    if (width > 8 || offset + width > bytes.length) return null;
    let value = first & (mask - 1);
    for (let index = 1; index < width; index += 1) value = value * 256 + bytes[offset + index];
    if (forSize && value === Math.pow(2, width * 7) - 1) value = -1;
    return { value, width };
  }

  function readEbmlId(bytes, offset) {
    if (offset >= bytes.length) return null;
    const first = bytes[offset];
    let width = 1;
    let mask = 0x80;
    while (width <= 4 && (first & mask) === 0) {
      mask >>= 1;
      width += 1;
    }
    if (width > 4 || offset + width > bytes.length) return null;
    let value = first;
    for (let index = 1; index < width; index += 1) value = value * 256 + bytes[offset + index];
    return { value, width };
  }

  const EBML = {
    TAGS: 0x1254c367,
    TAG: 0x7373,
    SIMPLE_TAG: 0x67c8,
    TAG_NAME: 0x45a3,
    TAG_STRING: 0x4487,
    TAG_BINARY: 0x4484,
    EBML: 0x1a45dfa3,
    SEGMENT: 0x18538067
  };

  function parseWebm(bytes) {
    const result = {};
    let visited = 0;
    function parseSimpleTag(start, end) {
      let name = '';
      let value = '';
      let cursor = start;
      while (cursor < end && visited < MAX_ELEMENTS) {
        const id = readEbmlId(bytes, cursor);
        if (!id) break;
        const size = readEbmlVint(bytes, cursor + id.width, true);
        if (!size) break;
        const dataStart = cursor + id.width + size.width;
        const dataEnd = size.value < 0 ? end : Math.min(end, dataStart + size.value);
        if (dataEnd < dataStart) break;
        visited += 1;
        if (id.value === EBML.TAG_NAME) name = utf8(bytes, dataStart, dataEnd);
        if (id.value === EBML.TAG_STRING) value = utf8(bytes, dataStart, dataEnd);
        cursor = dataEnd;
      }
      if (name && value) addMetadataValue(result, name, value);
    }
    function walk(start, end, depth) {
      if (depth > 12 || visited >= MAX_ELEMENTS) return;
      let cursor = start;
      while (cursor < end && visited < MAX_ELEMENTS) {
        const id = readEbmlId(bytes, cursor);
        if (!id) break;
        const size = readEbmlVint(bytes, cursor + id.width, true);
        if (!size) break;
        const dataStart = cursor + id.width + size.width;
        const dataEnd = size.value < 0 ? end : Math.min(end, dataStart + size.value);
        if (dataEnd < dataStart) break;
        visited += 1;
        if (id.value === EBML.SIMPLE_TAG) parseSimpleTag(dataStart, dataEnd);
        else if (id.value === EBML.TAGS || id.value === EBML.TAG || id.value === EBML.SEGMENT || id.value === EBML.EBML) {
          walk(dataStart, dataEnd, depth + 1);
        }
        cursor = dataEnd;
      }
    }
    walk(0, bytes.length, 0);
    return result;
  }

  function detectContainer(bytes) {
    if (bytes.length >= 8 && fourcc(bytes, 4) === 'ftyp') return 'mp4';
    if (bytes.length >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) return 'webm';
    return 'unknown';
  }

  function parseVideoBytes(bytes) {
    if (!(bytes instanceof Uint8Array)) bytes = new Uint8Array(bytes);
    if (bytes.length > MAX_FILE_BYTES) throw new Error('Video exceeds the supported local parsing limit.');
    const container = detectContainer(bytes);
    let metadata = {};
    if (container === 'mp4') metadata = parseMp4(bytes);
    if (container === 'webm') metadata = parseWebm(bytes);
    return { container, metadata };
  }

  async function parseVideoFile(file) {
    if (!file || typeof file.arrayBuffer !== 'function') throw new Error('No readable video file was supplied.');
    const bytes = new Uint8Array(await file.arrayBuffer());
    return { ...parseVideoBytes(bytes), name: file.name, size: file.size, type: file.type };
  }

  function extractBalancedJson(text, label) {
    const index = text.toLowerCase().indexOf(label.toLowerCase());
    if (index < 0) return null;
    const start = text.slice(index + label.length).search(/[\[{]/);
    if (start < 0) return null;
    const absolute = index + label.length + start;
    const opener = text[absolute];
    const closer = opener === '{' ? '}' : ']';
    let depth = 0;
    let quoted = false;
    let escaped = false;
    for (let cursor = absolute; cursor < text.length; cursor += 1) {
      const character = text[cursor];
      if (quoted) {
        if (escaped) escaped = false;
        else if (character === '\\') escaped = true;
        else if (character === '"') quoted = false;
        continue;
      }
      if (character === '"') quoted = true;
      else if (character === opener) depth += 1;
      else if (character === closer) {
        depth -= 1;
        if (depth === 0) {
          try {
            return JSON.parse(text.slice(absolute, cursor + 1));
          } catch (_) {
            return null;
          }
        }
      }
    }
    return null;
  }

  function parseA1111Parameters(text) {
    if (typeof text !== 'string' || !text.trim()) return {};
    const output = { raw: text };
    const negativeIndex = text.indexOf('\nNegative prompt:');
    const settingsIndex = text.indexOf('\nSteps:');
    if (negativeIndex >= 0) {
      output.positive = text.slice(0, negativeIndex).trim();
      output.negative = text.slice(negativeIndex + '\nNegative prompt:'.length, settingsIndex >= 0 ? settingsIndex : text.length).trim();
    } else if (settingsIndex >= 0) {
      output.positive = text.slice(0, settingsIndex).trim();
    }
    if (settingsIndex >= 0) output.settings = text.slice(settingsIndex + 1).trim();
    output.civitaiResources = extractBalancedJson(text, 'Civitai resources:');
    output.hashes = extractBalancedJson(text, 'Hashes:');
    const modelHash = text.match(/(?:^|,\s*)Model hash:\s*([^,\s]+)/i);
    if (modelHash) output.modelHash = modelHash[1];
    const modelName = text.match(/(?:^|,\s*)Model:\s*([^,]+?)(?:,\s*(?:Hashes|Version|Civitai resources):|$)/i);
    if (modelName) output.modelName = modelName[1].trim();
    return output;
  }

  function addResource(list, resource) {
    if (!resource || typeof resource !== 'object') return;
    const normalized = { ...resource };
    if (normalized.modelVersionId !== undefined) normalized.modelVersionId = Number(normalized.modelVersionId);
    if (!Number.isInteger(normalized.modelVersionId) || normalized.modelVersionId <= 0) delete normalized.modelVersionId;
    if (normalized.weight !== undefined) {
      const weight = Number(normalized.weight);
      if (Number.isFinite(weight)) normalized.weight = weight;
      else delete normalized.weight;
    }
    const air = typeof normalized.air === 'string' ? normalized.air : '';
    const airMatch = air.match(/civitai:(\d+)(?:@(\d+))?/i);
    if (airMatch && !normalized.modelVersionId && airMatch[2]) normalized.modelVersionId = Number(airMatch[2]);
    if (airMatch && !normalized.modelId) normalized.modelId = Number(airMatch[1]);
    const key = normalized.modelVersionId ? `id:${normalized.modelVersionId}` : normalized.hash ? `hash:${String(normalized.hash).toLowerCase()}` : normalized.air ? `air:${normalized.air}` : null;
    if (!key) return;
    const existing = list.find((item) => item._key === key);
    if (existing) {
      Object.assign(existing, Object.fromEntries(Object.entries(normalized).filter(([, value]) => value !== undefined && value !== null && value !== '')));
      return;
    }
    list.push({ ...normalized, _key: key });
  }

  function extractResources(metadata) {
    const resources = [];
    const visited = new Set();
    function scan(value, hint = '', depth = 0) {
      if (depth > 12 || value === null || value === undefined) return;
      if (typeof value === 'string') {
        const trimmed = value.trim();
        if (!trimmed) return;
        const airPattern = /urn:air:[^\s"',]+:civitai:(\d+)(?:@(\d+))?/gi;
        let match;
        while ((match = airPattern.exec(trimmed))) addResource(resources, { air: match[0], modelId: Number(match[1]), ...(match[2] ? { modelVersionId: Number(match[2]) } : {}), type: hint.toLowerCase().includes('lora') ? 'lora' : undefined });
        const parsed = safeJson(trimmed);
        if (parsed !== value) scan(parsed, hint, depth + 1);
        if (trimmed.toLowerCase().includes('civitai resources:')) {
          const parsedResources = extractBalancedJson(trimmed, 'Civitai resources:');
          if (parsedResources) scan(parsedResources, 'civitaiResources', depth + 1);
        }
        if (trimmed.toLowerCase().includes('hashes:')) {
          const parsedHashes = extractBalancedJson(trimmed, 'Hashes:');
          if (parsedHashes) scan(parsedHashes, 'hashes', depth + 1);
        }
        return;
      }
      if (typeof value === 'number' || typeof value === 'boolean') return;
      if (visited.has(value)) return;
      visited.add(value);
      if (Array.isArray(value)) {
        value.slice(0, MAX_ELEMENTS).forEach((item) => scan(item, hint, depth + 1));
        return;
      }
      if (typeof value === 'object') {
        const directId = value.modelVersionId ?? value.versionId;
        const directHash = value.hash ?? value.modelHash;
        if (directId !== undefined || directHash || value.air) addResource(resources, { ...value, ...(directHash ? { hash: directHash } : {}) });
        for (const [key, child] of Object.entries(value)) {
          const lower = key.toLowerCase();
          if (typeof child === 'string' && (lower.includes('hash') || lower.includes('lora') || lower.includes('embed') || lower === 'model')) {
            const hash = child.trim();
            if (/^[a-z0-9]{6,64}$/i.test(hash) && (lower !== 'model' || !/^\d+$/.test(hash))) addResource(resources, { hash, name: key, type: lower.includes('lora') ? 'lora' : lower.includes('embed') ? 'embed' : lower === 'model' ? 'checkpoint' : undefined });
          }
          scan(child, key, depth + 1);
        }
      }
    }
    scan(metadata);
    return resources.map(({ _key, ...resource }) => resource);
  }

  function getPromptFields(metadata) {
    const parameters = typeof metadata.parameters === 'string' ? parseA1111Parameters(metadata.parameters) : {};
    const textValue = (value) => {
      if (typeof value === 'string') return value.trim();
      if (Array.isArray(value) && value.every((item) => typeof item === 'string')) return value.join('\n').trim();
      return '';
    };
    const findStructuredValue = (aliases, root = metadata) => {
      const visited = new Set();
      function scan(value, depth = 0) {
        if (depth > 8 || value === null || value === undefined) return '';
        if (typeof value !== 'object' || visited.has(value)) return '';
        visited.add(value);
        if (Array.isArray(value)) {
          for (const item of value) {
            const found = scan(item, depth + 1);
            if (found) return found;
          }
          return '';
        }
        for (const [key, child] of Object.entries(value)) {
          const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
          if (aliases.has(normalized)) {
            const found = textValue(child);
            if (found) return found;
          }
        }
        for (const child of Object.values(value)) {
          const found = scan(child, depth + 1);
          if (found) return found;
        }
        return '';
      }
      return scan(root);
    };
    const promptGraph = typeof metadata.prompt === 'string' ? safeJson(metadata.prompt) : metadata.prompt;
    const searchableMetadata = promptGraph && typeof promptGraph === 'object'
      ? { ...metadata, prompt: promptGraph }
      : metadata;
    const structuredValue = (aliases) => findStructuredValue(aliases, searchableMetadata);
    const positive = parameters.positive
      || structuredValue(new Set(['positive', 'positiveprompt', 'promptpositive']))
      || (typeof promptGraph === 'string' && !/class_type|"inputs"\s*:/i.test(promptGraph) ? promptGraph.trim() : '');
    const negative = parameters.negative
      || structuredValue(new Set(['negative', 'negativeprompt', 'promptnegative']));
    const settings = parameters.settings
      || structuredValue(new Set(['settings', 'generationparameters', 'generationparameter']));
    return {
      positive,
      negative,
      settings,
      rawParameters: typeof metadata.parameters === 'string' ? metadata.parameters : ''
    };
  }

  function getGenerationFields(metadata) {
    const parameters = typeof metadata.parameters === 'string' ? parseA1111Parameters(metadata.parameters) : {};
    const source = typeof metadata.prompt === 'string' ? safeJson(metadata.prompt) : metadata.prompt;
    const root = source && typeof source === 'object' ? source : metadata;
    const aliases = {
      steps: new Set(['steps', 'step']),
      sampler: new Set(['sampler', 'samplername']),
      scheduler: new Set(['scheduler', 'schedulername', 'scheduletype']),
      seed: new Set(['seed', 'noiseseed']),
      guidanceScale: new Set(['cfg', 'cfgscale', 'guidance', 'guidancescale'])
    };
    const find = (wanted) => {
      const visited = new Set();
      function scan(value, depth = 0) {
        if (depth > 10 || value === null || value === undefined || typeof value !== 'object' || visited.has(value)) return null;
        visited.add(value);
        if (!Array.isArray(value)) {
          for (const [key, child] of Object.entries(value)) {
            const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
            if (wanted.has(normalized) && (typeof child === 'string' || typeof child === 'number')) return child;
          }
        }
        for (const child of Object.values(value)) {
          const found = scan(child, depth + 1);
          if (found !== null && found !== '') return found;
        }
        return null;
      }
      return scan(root);
    };
    const settings = parameters.settings || '';
    const setting = (name) => settings.match(new RegExp(`(?:^|,\\s*)${name}:\\s*([^,]+)`, 'i'))?.[1]?.trim() || null;
    return {
      steps: find(aliases.steps) ?? setting('Steps'),
      sampler: find(aliases.sampler) ?? setting('Sampler'),
      scheduler: find(aliases.scheduler) ?? setting('Schedule type') ?? setting('Scheduler'),
      seed: find(aliases.seed) ?? setting('Seed'),
      guidanceScale: find(aliases.guidanceScale) ?? setting('CFG scale')
    };
  }

  function getResourceSearchQuery(resource) {
    const clean = (value) => typeof value === 'string' ? value.trim() : '';
    const isHexHash = (value, length) => new RegExp(`^[a-f0-9]{${length}}$`, 'i').test(value);
    const toPickerHash = (value) => isHexHash(value, 64) ? value.slice(0, 10) : value;
    const embeddedHash = clean(resource?.hash || resource?.modelHash);
    if (embeddedHash) {
      const query = toPickerHash(embeddedHash);
      const method = isHexHash(embeddedHash, 64)
        ? 'AutoV2 derived from embedded SHA-256'
        : isHexHash(embeddedHash, 10)
          ? 'embedded AutoV2 hash'
          : 'embedded hash';
      return { query, method };
    }

    const files = Array.isArray(resource?.lookup?.files) ? resource.lookup.files : [];
    for (const hashName of ['AutoV2', 'SHA256', 'CRC32']) {
      const fileHash = files
        .map((file) => clean(file?.hashes?.[hashName]))
        .find(Boolean);
      if (fileHash) {
        const query = toPickerHash(fileHash);
        const method = hashName === 'SHA256' && query !== fileHash
          ? 'AutoV2 derived from Civitai SHA-256'
          : `Civitai ${hashName} hash`;
        return { query, method };
      }
    }

    const name = clean(
      resource?.lookup?.model?.name
      || resource?.modelName
      || resource?.name
      || resource?.lookup?.name
    );
    return { query: name, method: 'name fallback' };
  }

  function getResourceSearchQueries(resource) {
    const primary = getResourceSearchQuery(resource);
    const candidates = [
      primary,
      { query: resource?.lookup?.model?.name, method: 'resolved Civitai model name' },
      { query: resource?.modelName, method: 'metadata model name' },
      { query: resource?.name, method: 'metadata resource name' }
    ];
    const seen = new Set();
    return candidates.filter(({ query }) => {
      if (typeof query !== 'string' || !query.trim()) return false;
      const key = query.trim().toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).map(({ query, method }) => ({ query: query.trim(), method }));
  }

  return {
    parseVideoBytes,
    parseVideoFile,
    parseA1111Parameters,
    extractResources,
    getPromptFields,
    getGenerationFields,
    getResourceSearchQuery,
    getResourceSearchQueries,
    detectContainer,
    constants: { MAX_FILE_BYTES, MAX_METADATA_BYTES, MAX_VALUE_BYTES, MAX_ELEMENTS }
  };
});
