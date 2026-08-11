'use strict';

const nodeFs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { assertBeforeDeadline } = require('./deadline.js');
const { regularFileIdentity, regularFileIdentitiesMatch } = require('./fs-safe.js');

const ISO_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

class ConfigError extends Error {
  constructor(code, message, cause) {
    super(message, cause ? { cause } : undefined);
    this.name = 'ConfigError';
    this.code = code;
  }
}

function stripComment(line) {
  let quote = null;
  let escaped = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (escaped) { escaped = false; continue; }
    if (character === '\\' && quote === '"') { escaped = true; continue; }
    if (quote) {
      if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") { quote = character; continue; }
    if (character === '#') return line.slice(0, index);
  }
  return line;
}

function scalarValue(raw) {
  const value = raw.trim();
  if (value.length < 2 || value[0] !== value.at(-1) || !['"', "'"].includes(value[0])) return value;
  if (value[0] === "'") return value.slice(1, -1).replaceAll("''", "'");
  try {
    return JSON.parse(value);
  } catch (cause) {
    throw new ConfigError('CONFIG_INVALID', 'invalid double-quoted supported scalar', cause);
  }
}

function inlineList(raw) {
  const value = raw.trim();
  if (!value.startsWith('[') || !value.endsWith(']')) return null;
  const body = value.slice(1, -1);
  const output = [];
  let current = '';
  let quote = null;
  let escaped = false;
  for (const character of body) {
    if (escaped) { current += character; escaped = false; continue; }
    if (character === '\\' && quote === '"') { current += character; escaped = true; continue; }
    if (quote) {
      current += character;
      if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") { quote = character; current += character; continue; }
    if (character === ',') {
      if (current.trim()) output.push(scalarValue(current));
      current = '';
      continue;
    }
    current += character;
  }
  if (quote) throw new ConfigError('CONFIG_INVALID', 'invalid inline list in supported config key');
  if (current.trim()) output.push(scalarValue(current));
  return output;
}

function parseBoolean(raw, keyPath) {
  const value = scalarValue(raw).trim().toLowerCase();
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new ConfigError('CONFIG_INVALID', `${keyPath} must be true or false`);
}

function hasKeyToken(text, key) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escaped}(?=\\s|:|$)`).test(text);
}

const SUPPORTED_LEAF_KEYS = [
  'ignore_globs', 'require_tag', 'available', 'vault_path', 'vault_name', 'wiki_prefix',
];

const SUPPORTED_CONFIG_KEYS = new Set([
  'wiki_root', 'auto_ingest', 'obsidian_cli',
  'auto_ingest.ignore_globs', 'auto_ingest.require_tag',
  'obsidian_cli.available', 'obsidian_cli.vault_path',
  'obsidian_cli.vault_name', 'obsidian_cli.wiki_prefix',
  ...SUPPORTED_LEAF_KEYS,
]);

function hasSupportedLeafToken(text) {
  return SUPPORTED_LEAF_KEYS.some((key) => hasKeyToken(text, key));
}

function hasKnownDottedLeafToken(text) {
  return /^(?:auto_ingest|obsidian_cli)\.(?:ignore_globs|require_tag|available|vault_path|vault_name|wiki_prefix)(?=\s|:|$)/.test(text);
}

function withoutBlockListMarkers(text) {
  let value = text.trimStart();
  while (value === '-' || /^-\s+/.test(value)) value = value.slice(1).trimStart();
  return value;
}

function hasSupportedConfigToken(text) {
  const value = withoutBlockListMarkers(text);
  return SUPPORTED_CONFIG_KEYS.has(structuralMappingEntry(value)?.key)
    || hasKeyToken(value, 'wiki_root')
    || hasKeyToken(value, 'auto_ingest')
    || hasKeyToken(value, 'obsidian_cli')
    || hasKnownDottedLeafToken(value)
    || hasSupportedLeafToken(value);
}

function flowCollectionHasSupportedKey(text) {
  const value = withoutBlockListMarkers(text);
  if (!value.startsWith('{') && !value.startsWith('[')) return false;
  const skipQuoted = (start) => {
    const quote = value[start];
    let index = start + 1;
    while (index < value.length) {
      if (quote === '"' && value[index] === '\\') {
        index += 2;
        continue;
      }
      if (quote === "'" && value[index] === "'" && value[index + 1] === "'") {
        index += 2;
        continue;
      }
      if (value[index] === quote) return index + 1;
      index += 1;
    }
    return value.length;
  };
  let index = 0;
  while (index < value.length) {
    if (value[index] === '"' || value[index] === "'") {
      index = skipQuoted(index);
      continue;
    }
    if (!['[', '{', ','].includes(value[index])) {
      index += 1;
      continue;
    }
    index += 1;
    while (/\s/.test(value[index] || '')) index += 1;
    if (value[index] === '?') {
      index += 1;
      while (/\s/.test(value[index] || '')) index += 1;
    }
    let key = null;
    let afterKey = index;
    if (value[index] === '"' || value[index] === "'") {
      afterKey = skipQuoted(index);
      if (afterKey <= value.length) {
        try { key = scalarValue(value.slice(index, afterKey)); } catch { key = null; }
      }
    } else {
      const match = value.slice(index).match(/^([A-Za-z_][A-Za-z0-9_.-]*)/);
      if (match) {
        key = match[1];
        afterKey = index + match[1].length;
      }
    }
    while (/\s/.test(value[afterKey] || '')) afterKey += 1;
    if (value[afterKey] === ':' && SUPPORTED_CONFIG_KEYS.has(key)) return true;
  }
  return false;
}

function quotedScalarEnd(value, start = 0) {
  const quote = value[start];
  if (quote !== '"' && quote !== "'") return null;
  let index = start + 1;
  while (index < value.length) {
    if (quote === '"' && value[index] === '\\') {
      index += 2;
      continue;
    }
    if (quote === "'" && value[index] === "'" && value[index + 1] === "'") {
      index += 2;
      continue;
    }
    if (value[index] === quote) return index + 1;
    index += 1;
  }
  return null;
}

function stripNodeProperties(text) {
  const value = text.trimStart();
  let cursor = 0;
  let count = 0;
  const tags = [];
  while (cursor < value.length) {
    const rest = value.slice(cursor);
    let token = null;
    if (rest.startsWith('!<')) {
      const end = rest.indexOf('>');
      if (end < 3) return { value, count: 0, tags: [] };
      token = rest.slice(0, end + 1);
    } else if (rest[0] === '!') {
      token = rest.match(/^!(?:[^\s]+)?/)?.[0] || null;
    } else if (rest[0] === '&') {
      token = rest.match(/^&[^\s[\]{},]+/)?.[0] || null;
    }
    if (!token) break;
    const next = cursor + token.length;
    if (next < value.length && !/\s/.test(value[next])) break;
    if (token[0] === '!') tags.push(token);
    count += 1;
    cursor = next;
    while (/\s/.test(value[cursor] || '')) cursor += 1;
  }
  return { value: value.slice(cursor), count, tags };
}

function decodeStructuralScalarKey(text) {
  const properties = stripNodeProperties(text);
  const value = properties.value;
  let key;
  let cursor;
  let quoted = false;
  if (value[0] === '"' || value[0] === "'") {
    quoted = true;
    cursor = quotedScalarEnd(value);
    if (cursor === null) return null;
    try { key = scalarValue(value.slice(0, cursor)); } catch { return null; }
  } else {
    const match = value.match(/^([A-Za-z_][A-Za-z0-9_.-]*)/);
    if (!match) return null;
    key = match[1];
    cursor = match[1].length;
  }
  return {
    key,
    remainder: value.slice(cursor),
    nodeProperties: properties.count,
    quoted,
  };
}

function structuralMappingEntry(text) {
  let value = text.trimStart();
  const explicit = /^\?\s+/.test(value);
  if (explicit) value = value.replace(/^\?\s+/, '');
  const decoded = decodeStructuralScalarKey(value);
  if (!decoded) return null;
  const remainder = explicit ? decoded.remainder.trim() : decoded.remainder.trimStart();
  if (explicit) {
    if (remainder !== '' && !remainder.startsWith(':')) return null;
  } else if (!remainder.startsWith(':')) {
    return null;
  }
  return {
    key: decoded.key,
    value: remainder.startsWith(':') ? remainder.slice(1).trimStart() : null,
    nodeProperties: decoded.nodeProperties,
    quoted: decoded.quoted,
    explicit,
  };
}

function mappingEntry(text) {
  const entry = structuralMappingEntry(text);
  return entry?.explicit ? null : entry;
}

function hasUnsupportedAliasOrMergeMappingKey(text) {
  let value = withoutBlockListMarkers(text);
  const explicit = /^\?\s+/.test(value);
  if (explicit) value = value.replace(/^\?\s+/, '');
  const properties = stripNodeProperties(value);
  const taggedMerge = properties.tags.some((tag) => (
    tag === '!!merge' || tag === '!<tag:yaml.org,2002:merge>'
  ));
  const body = properties.value;
  if (/^<<\s*:/.test(body) || (explicit && /^<<\s*$/.test(body))) return true;
  if (taggedMerge && (/^(?:<<|"<<"|'<<')\s*:/.test(body)
      || (explicit && /^(?:<<|"<<"|'<<')\s*$/.test(body)))) return true;
  return /^\*[^\s[\]{},:]+(?=\s*:|\s*$)/.test(body);
}

function hasAlternateSupportedMappingKey(text) {
  const entry = structuralMappingEntry(text);
  return SUPPORTED_CONFIG_KEYS.has(entry?.key)
    && (entry.explicit || entry.nodeProperties > 0 || entry.quoted);
}

function isBlockListLine(text) {
  return /^-(?:\s|$)/.test(text.trimStart());
}

function isMappingEntry(text) {
  return mappingEntry(text) !== null;
}

function containerEntryKind(text) {
  if (isBlockListLine(text)) return 'list';
  if (isMappingEntry(text)) return 'mapping';
  return 'nonmapping';
}

function parseConfig(input) {
  const text = String(input).replace(/^\uFEFF/, '').replaceAll('\r\n', '\n').replaceAll('\r', '\n');
  const result = {
    wikiRoot: null,
    autoIngestDefined: false,
    autoIngest: { ignoreGlobs: [], requireTag: null },
    obsidianCli: { available: null, vaultPath: null, vaultName: null, wikiPrefix: null },
  };
  const scalars = new Map();
  const unsupportedKeys = {
    topLevel: new Set(),
    autoIngest: new Set(),
    obsidianCli: new Set(),
  };
  const setScalar = (keyPath, value, assign) => {
    if (scalars.has(keyPath) && scalars.get(keyPath) !== value) {
      throw new ConfigError('CONFIG_INVALID', `conflicting duplicate ${keyPath}`);
    }
    scalars.set(keyPath, value);
    assign(value);
  };
  const recordUnsupportedKey = (context, key) => {
    if (unsupportedKeys[context].has(key)) {
      throw new ConfigError('CONFIG_INVALID', `duplicate unsupported ${context} mapping key`);
    }
    unsupportedKeys[context].add(key);
  };
  let section = null;
  let sectionChildIndent = null;
  let ignoreListIndent = null;
  let unknownContainer = null;
  const lines = text.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const withoutComment = stripComment(lines[index]);
    if (!withoutComment.trim()) continue;
    const leading = withoutComment.match(/^[ \t]*/)[0];
    const indent = leading.length;
    const trimmed = withoutComment.trim();
    if (leading.includes('\t')) {
      throw new ConfigError('CONFIG_INVALID', 'config indentation must use spaces only');
    }

    if (unknownContainer !== null) {
      if (indent <= unknownContainer.indent) {
        unknownContainer = null;
      } else {
        if (unknownContainer.childIndent === null) unknownContainer.childIndent = indent;
        if (indent < unknownContainer.childIndent) {
          throw new ConfigError('CONFIG_INVALID', 'unknown config container has inconsistent child indentation');
        }
        if (indent === unknownContainer.childIndent) {
          const entryKind = containerEntryKind(trimmed);
          if (unknownContainer.kind === 'pending') unknownContainer.kind = entryKind;
          else if (entryKind !== unknownContainer.kind) {
            throw new ConfigError('CONFIG_INVALID', 'unknown config container mixes mapping and list entries');
          }
        }
        if (unknownContainer.kind === 'mapping') continue;
        if (hasSupportedConfigToken(trimmed)) {
          throw new ConfigError('CONFIG_INVALID', 'supported config token is in an unknown non-mapping container');
        }
        continue;
      }
    }

    if (ignoreListIndent !== null) {
      const item = withoutComment.match(/^\s*-\s*(.+?)\s*$/);
      if (item && indent > ignoreListIndent) {
        result.autoIngest.ignoreGlobs.push(scalarValue(item[1]));
        continue;
      }
      ignoreListIndent = null;
    }

    if (indent === 0) {
      section = null;
      sectionChildIndent = null;
      unknownContainer = null;
      if (hasUnsupportedAliasOrMergeMappingKey(trimmed)) {
        throw new ConfigError('CONFIG_INVALID', 'YAML alias and merge mapping keys are not supported');
      }
      if ((isBlockListLine(trimmed) && hasSupportedConfigToken(trimmed))
          || flowCollectionHasSupportedKey(trimmed)) {
        throw new ConfigError('CONFIG_INVALID', 'supported config token is in a top-level collection');
      }
      if (hasAlternateSupportedMappingKey(trimmed)) {
        throw new ConfigError('CONFIG_INVALID', 'supported config key uses unsupported block mapping syntax');
      }
      if (/^wiki_root\s*:/.test(trimmed)) {
        const raw = trimmed.replace(/^wiki_root\s*:\s*/, '');
        if (!raw) throw new ConfigError('CONFIG_INVALID', 'wikiRoot must not be empty');
        setScalar('wikiRoot', scalarValue(raw), (value) => { result.wikiRoot = value; });
        continue;
      }
      if (/^wiki_root\b/.test(trimmed)) throw new ConfigError('CONFIG_INVALID', 'malformed wikiRoot definition');
      if (/^obsidian_cli\s*:\s*$/.test(trimmed)) { section = 'obsidianCli'; continue; }
      if (hasKeyToken(trimmed, 'obsidian_cli')) {
        throw new ConfigError('CONFIG_INVALID', 'malformed obsidianCli section definition');
      }
      if (/^auto_ingest\s*:\s*$/.test(trimmed)) {
        result.autoIngestDefined = true;
        section = 'autoIngest';
        continue;
      }
      if (/^auto_ingest\.ignore_globs\s*:/.test(trimmed)) {
        result.autoIngestDefined = true;
        const raw = trimmed.replace(/^auto_ingest\.ignore_globs\s*:\s*/, '');
        const values = inlineList(raw);
        if (!values) throw new ConfigError('CONFIG_INVALID', 'autoIngest.ignoreGlobs dotted form must be an inline list');
        result.autoIngest.ignoreGlobs.push(...values);
        continue;
      }
      if (hasKeyToken(trimmed, 'auto_ingest.ignore_globs')) {
        throw new ConfigError('CONFIG_INVALID', 'malformed autoIngest.ignoreGlobs dotted definition');
      }
      if (hasKnownDottedLeafToken(trimmed) || hasSupportedLeafToken(trimmed)) {
        throw new ConfigError('CONFIG_INVALID', 'supported config leaf is in the wrong context');
      }
      if (hasKeyToken(trimmed, 'auto_ingest')) {
        throw new ConfigError('CONFIG_INVALID', 'malformed autoIngest section definition');
      }
      const unknownEntry = structuralMappingEntry(trimmed);
      if (unknownEntry) {
        recordUnsupportedKey('topLevel', unknownEntry.key);
      }
      if (!unknownEntry?.explicit && unknownEntry?.value === '') {
        unknownContainer = { indent, childIndent: null, kind: 'pending' };
      }
      continue;
    }

    if (section === null) {
      if (hasUnsupportedAliasOrMergeMappingKey(trimmed)) {
        throw new ConfigError('CONFIG_INVALID', 'YAML alias and merge mapping keys are not supported');
      }
      if (hasAlternateSupportedMappingKey(trimmed)) {
        throw new ConfigError('CONFIG_INVALID', 'supported config key uses unsupported block mapping syntax');
      }
      if (hasSupportedConfigToken(trimmed)) {
        throw new ConfigError('CONFIG_INVALID', 'supported config token is in the wrong top-level context');
      }
      continue;
    }
    if (sectionChildIndent === null) sectionChildIndent = indent;
    if (hasUnsupportedAliasOrMergeMappingKey(trimmed)) {
      throw new ConfigError('CONFIG_INVALID', 'YAML alias and merge mapping keys are not supported');
    }
    if (indent !== sectionChildIndent) {
      if (hasSupportedConfigToken(trimmed)) {
        throw new ConfigError('CONFIG_INVALID', 'supported config leaf is in the wrong context');
      }
      continue;
    }
    if (hasKnownDottedLeafToken(trimmed)) {
      throw new ConfigError('CONFIG_INVALID', 'supported config leaf is in the wrong context');
    }
    if (hasAlternateSupportedMappingKey(trimmed)) {
      throw new ConfigError('CONFIG_INVALID', 'supported config key uses unsupported block mapping syntax');
    }

    if (section === 'autoIngest') {
      if (/^ignore_globs\s*:/.test(trimmed)) {
        const raw = trimmed.replace(/^ignore_globs\s*:\s*/, '');
        if (!raw) { ignoreListIndent = indent; continue; }
        const values = inlineList(raw);
        if (!values) throw new ConfigError('CONFIG_INVALID', 'autoIngest.ignoreGlobs must be a list');
        result.autoIngest.ignoreGlobs.push(...values);
        continue;
      }
      if (/^require_tag\s*:/.test(trimmed)) {
        const raw = trimmed.replace(/^require_tag\s*:\s*/, '');
        const value = scalarValue(raw);
        setScalar('autoIngest.requireTag', value, (next) => { result.autoIngest.requireTag = next; });
        continue;
      }
      if (hasKeyToken(trimmed, 'ignore_globs') || hasKeyToken(trimmed, 'require_tag')) {
        throw new ConfigError('CONFIG_INVALID', 'malformed supported autoIngest key');
      }
      if (hasSupportedConfigToken(trimmed)) {
        throw new ConfigError('CONFIG_INVALID', 'supported config leaf is in the wrong context');
      }
      const unknownEntry = structuralMappingEntry(trimmed);
      if (unknownEntry) recordUnsupportedKey('autoIngest', unknownEntry.key);
      if (!unknownEntry?.explicit && unknownEntry?.value === '') {
        unknownContainer = { indent, childIndent: null, kind: 'pending' };
      }
      continue;
    }

    if (section === 'obsidianCli') {
      const supported = {
        available: ['obsidianCli.available', (raw) => parseBoolean(raw, 'obsidianCli.enabled')],
        vault_path: ['obsidianCli.vaultPath', scalarValue],
        vault_name: ['obsidianCli.vaultName', scalarValue],
        wiki_prefix: ['obsidianCli.wikiPrefix', scalarValue],
      };
      const match = trimmed.match(/^([a-z_]+)\s*:\s*(.*)$/);
      if (!match || !supported[match[1]]) {
        if (Object.hasOwn(supported, trimmed.match(/^([a-z_]+)/)?.[1] || '')
            && Object.keys(supported).some((key) => hasKeyToken(trimmed, key))) {
          throw new ConfigError('CONFIG_INVALID', 'malformed supported obsidianCli key');
        }
        if (hasSupportedConfigToken(trimmed)) {
          throw new ConfigError('CONFIG_INVALID', 'supported config leaf is in the wrong context');
        }
        const unknownEntry = structuralMappingEntry(trimmed);
        if (unknownEntry) recordUnsupportedKey('obsidianCli', unknownEntry.key);
        if (!unknownEntry?.explicit && unknownEntry?.value === '') {
          unknownContainer = { indent, childIndent: null, kind: 'pending' };
        }
        continue;
      }
      const [keyPath, parser] = supported[match[1]];
      const value = parser(match[2]);
      setScalar(keyPath, value, (next) => {
        if (match[1] === 'available') result.obsidianCli.available = next;
        if (match[1] === 'vault_path') result.obsidianCli.vaultPath = next;
        if (match[1] === 'vault_name') result.obsidianCli.vaultName = next;
        if (match[1] === 'wiki_prefix') result.obsidianCli.wikiPrefix = next;
      });
    }
  }
  return result;
}

function pathApi(platform) {
  return platform === 'win32' ? path.win32 : path.posix;
}

function normalizeWikiRoot(raw, platform = process.platform, home) {
  if (typeof raw !== 'string' || raw.trim() === '') throw new ConfigError('CONFIG_INVALID', 'wikiRoot is required');
  const api = pathApi(platform);
  let value = raw.trim();
  if (value === '~' || value.startsWith('~/') || value.startsWith('~\\')) {
    if (!home || !api.isAbsolute(home)) throw new ConfigError('CONFIG_INVALID', 'an absolute home is required for ~ expansion');
    value = value === '~' ? home : api.join(home, value.slice(2));
  } else if (value.startsWith('~')) {
    throw new ConfigError('CONFIG_INVALID', 'only a standalone leading ~ may be expanded');
  }
  if (!api.isAbsolute(value)) throw new ConfigError('CONFIG_INVALID', 'wikiRoot must be absolute');
  return api.normalize(value);
}

function resolveHome(env = process.env, platform = process.platform) {
  const api = pathApi(platform);
  const selected = typeof env.HOME === 'string' && env.HOME.trim()
    ? env.HOME.trim()
    : (platform === 'win32' && typeof env.USERPROFILE === 'string' ? env.USERPROFILE.trim() : '');
  if (!selected || !api.isAbsolute(selected)) throw new ConfigError('CONFIG_INVALID', 'resolved home must be absolute');
  return api.normalize(selected);
}

function realpathNative(fs, value) {
  const realpath = fs.realpathSync?.native || fs.realpathSync;
  return realpath.call(fs.realpathSync, value);
}

function normalizePrefix(value) {
  if (value === null || value === undefined || String(value).trim() === '') return null;
  const raw = String(value).trim();
  if (raw.includes('\0')) throw new ConfigError('CONFIG_INVALID', 'obsidianCli.wikiPrefix must not contain NUL');
  const slash = raw.replaceAll('\\', '/');
  if (path.posix.isAbsolute(raw) || path.win32.isAbsolute(raw)
      || /^[A-Za-z]:/.test(raw) || slash.startsWith('//')) {
    throw new ConfigError('CONFIG_INVALID', 'obsidianCli.wikiPrefix must be relative');
  }
  if (slash.split('/').includes('..')) {
    throw new ConfigError('CONFIG_INVALID', 'obsidianCli.wikiPrefix traversal is not allowed');
  }
  const normalized = path.posix.normalize(slash);
  if (/^[A-Za-z]:/.test(normalized)) {
    throw new ConfigError('CONFIG_INVALID', 'obsidianCli.wikiPrefix must be relative');
  }
  if (normalized === '..' || normalized.startsWith('../') || normalized.includes('/../')) {
    throw new ConfigError('CONFIG_INVALID', 'obsidianCli.wikiPrefix traversal is not allowed');
  }
  return normalized === '.' ? '.' : normalized.replace(/^\.\//, '').replace(/\/$/, '');
}

function codePointCompare(left, right) {
  const a = Array.from(left, (value) => value.codePointAt(0));
  const b = Array.from(right, (value) => value.codePointAt(0));
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return a.length - b.length;
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function physicalPath(raw, { platform, fs, home }) {
  const normalized = normalizeWikiRoot(raw, platform, home);
  if (!fs.existsSync(normalized)) return normalized;
  return pathApi(platform).normalize(realpathNative(fs, normalized));
}

function normalizeConfigSemantics(config, options = {}) {
  const platform = options.platform || process.platform;
  const fs = options.fs || nodeFs;
  const home = options.home || (() => {
    try { return resolveHome(options.env || process.env, platform); } catch { return undefined; }
  })();
  const ignoreGlobs = [...new Set((config.autoIngest?.ignoreGlobs || [])
    .map((value) => String(value).trim().replaceAll('\\', '/'))
    .filter(Boolean))].sort(codePointCompare);
  const obsidian = config.obsidianCli || {};
  const result = {
    wikiRoot: physicalPath(config.wikiRoot, { platform, fs, home }),
    autoIngestDefined: config.autoIngestDefined === true,
    autoIngest: {
      requireTag: String(config.autoIngest?.requireTag || '').trim() || null,
      ignoreGlobs,
    },
    obsidianCli: {
      enabled: obsidian.available === true,
      vaultPath: obsidian.vaultPath ? physicalPath(obsidian.vaultPath, { platform, fs, home }) : null,
      vaultName: String(obsidian.vaultName || '').trim() || null,
      wikiPrefix: normalizePrefix(obsidian.wikiPrefix),
    },
  };
  return deepFreeze(result);
}

function normalizeAutoIngestPolicy(autoIngest = {}) {
  const ignoreGlobs = [...new Set((autoIngest.ignoreGlobs || [])
    .map((value) => String(value).trim().replaceAll('\\', '/'))
    .filter(Boolean))].sort(codePointCompare);
  for (const glob of ignoreGlobs) compilePortableGlob(glob);
  return deepFreeze({
    ignoreGlobs,
    requireTag: String(autoIngest.requireTag || '').trim() || null,
  });
}

function decodeUtf8(buffer) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch (cause) {
    throw new ConfigError('CONFIG_INVALID', 'wiki-local config is not valid UTF-8', cause);
  }
}

function scanJsonObjectKeys(source) {
  let index = 0;
  const whitespace = () => {
    while (/\s/u.test(source[index] || '')) index += 1;
  };
  const string = () => {
    const start = index;
    index += 1;
    let escaped = false;
    while (index < source.length) {
      const character = source[index];
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') {
        index += 1;
        try { return JSON.parse(source.slice(start, index)); }
        catch (cause) { throw new ConfigError('CONFIG_INVALID', 'malformed wiki-local JSON string', cause); }
      }
      index += 1;
    }
    throw new ConfigError('CONFIG_INVALID', 'malformed wiki-local JSON string');
  };
  const value = (depth) => {
    whitespace();
    if (source[index] === '{') return object(depth + 1);
    if (source[index] === '[') {
      if (depth >= 256) throw new ConfigError('CONFIG_INVALID', 'wiki-local JSON nesting is too deep');
      index += 1;
      whitespace();
      if (source[index] === ']') { index += 1; return; }
      while (true) {
        value(depth + 1); whitespace();
        if (source[index] === ']') { index += 1; return; }
        if (source[index] !== ',') throw new ConfigError('CONFIG_INVALID', 'malformed wiki-local JSON array');
        index += 1;
      }
    }
    if (source[index] === '"') { string(); return; }
    const match = source.slice(index).match(/^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/);
    if (!match) throw new ConfigError('CONFIG_INVALID', 'malformed wiki-local JSON value');
    index += match[0].length;
  };
  const object = (depth) => {
    if (depth > 256) throw new ConfigError('CONFIG_INVALID', 'wiki-local JSON nesting is too deep');
    index += 1;
    const keys = new Set();
    whitespace();
    if (source[index] === '}') { index += 1; return; }
    while (true) {
      whitespace();
      if (source[index] !== '"') throw new ConfigError('CONFIG_INVALID', 'malformed wiki-local JSON object');
      let key;
      try { key = string(); } catch (cause) {
        if (cause instanceof ConfigError) throw cause;
        throw new ConfigError('CONFIG_INVALID', 'malformed wiki-local JSON string', cause);
      }
      if (keys.has(key)) throw new ConfigError('CONFIG_INVALID', 'duplicate wiki-local JSON key');
      keys.add(key);
      whitespace();
      if (source[index] !== ':') throw new ConfigError('CONFIG_INVALID', 'malformed wiki-local JSON object');
      index += 1;
      value(depth); whitespace();
      if (source[index] === '}') { index += 1; return; }
      if (source[index] !== ',') throw new ConfigError('CONFIG_INVALID', 'malformed wiki-local JSON object');
      index += 1;
    }
  };
  whitespace();
  if (source[index] !== '{') return;
  object(0); whitespace();
  if (index !== source.length) throw new ConfigError('CONFIG_INVALID', 'malformed wiki-local JSON');
}

function loadWikiLocalConfig(wikiRoot, options = {}) {
  const fs = options.fs || nodeFs;
  const api = pathApi(options.platform || process.platform);
  const target = api.join(wikiRoot, '.wiki-meta', '.config.json');
  let before;
  try { before = fs.lstatSync(target, { bigint: true }); } catch (cause) {
    if (cause.code === 'ENOENT') return { status: 'absent', path: target, autoIngestDefined: false, config: null };
    throw new ConfigError('CONFIG_INVALID', 'wiki-local config cannot be inspected', cause);
  }
  if (before.isSymbolicLink() || !before.isFile()) {
    throw new ConfigError('CONFIG_INVALID', 'wiki-local config must be a regular non-symlink file');
  }
  if (before.size > 64n * 1024n) throw new ConfigError('CONFIG_INVALID', 'wiki-local config exceeds 64 KiB');
  const identity = regularFileIdentity(before);
  if (!identity) throw new ConfigError('CONFIG_INVALID', 'wiki-local config identity is unavailable or linked');
  let bytes;
  try { bytes = fs.readFileSync(target); } catch (cause) {
    throw new ConfigError('CONFIG_INVALID', 'wiki-local config cannot be read', cause);
  }
  let after;
  try { after = fs.lstatSync(target, { bigint: true }); } catch (cause) {
    throw new ConfigError('CONFIG_INVALID', 'wiki-local config identity was lost', cause);
  }
  if (after.isSymbolicLink() || !after.isFile() || !regularFileIdentitiesMatch(identity, regularFileIdentity(after))) {
    throw new ConfigError('CONFIG_INVALID', 'wiki-local config identity changed while reading');
  }
  const source = decodeUtf8(bytes);
  scanJsonObjectKeys(source);
  let parsed;
  try { parsed = JSON.parse(source); } catch (cause) {
    throw new ConfigError('CONFIG_INVALID', 'malformed wiki-local JSON', cause);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ConfigError('CONFIG_INVALID', 'wiki-local config must be a JSON object');
  }
  const allowed = new Set(['auto_ingest', 'a5_fanout_threshold', 'a5_worker_timeout_sec']);
  for (const key of Object.keys(parsed)) {
    if (!allowed.has(key)) throw new ConfigError('CONFIG_INVALID', 'wiki-local config contains an unsupported key');
  }
  const autoIngestDefined = Object.hasOwn(parsed, 'auto_ingest');
  const result = {};
  if (autoIngestDefined) {
    const auto = parsed.auto_ingest;
    if (!auto || typeof auto !== 'object' || Array.isArray(auto)) throw new ConfigError('CONFIG_INVALID', 'auto_ingest must be an object');
    for (const key of Object.keys(auto)) {
      if (key !== 'ignore_globs' && key !== 'require_tag') throw new ConfigError('CONFIG_INVALID', 'auto_ingest contains an unsupported key');
    }
    if (Object.hasOwn(auto, 'ignore_globs') && (!Array.isArray(auto.ignore_globs)
        || auto.ignore_globs.some((value) => typeof value !== 'string' || value.trim() === ''))) {
      throw new ConfigError('CONFIG_INVALID', 'auto_ingest.ignore_globs must be an array of non-empty strings');
    }
    if (Object.hasOwn(auto, 'require_tag') && typeof auto.require_tag !== 'string') {
      throw new ConfigError('CONFIG_INVALID', 'auto_ingest.require_tag must be a string');
    }
    result.autoIngest = normalizeAutoIngestPolicy({
      ignoreGlobs: auto.ignore_globs || [], requireTag: auto.require_tag || null,
    });
  }
  for (const [jsonKey, configKey] of [['a5_fanout_threshold', 'a5FanoutThreshold'], ['a5_worker_timeout_sec', 'a5WorkerTimeoutSec']]) {
    if (!Object.hasOwn(parsed, jsonKey)) continue;
    if (!Number.isInteger(parsed[jsonKey])) throw new ConfigError('CONFIG_INVALID', `${jsonKey} must be an integer`);
    result[configKey] = parsed[jsonKey];
  }
  return { status: 'present', path: target, autoIngestDefined, config: deepFreeze(result) };
}

function resolveEffectivePolicy({ globalConfig, localConfig }) {
  const globalDefined = globalConfig?.autoIngestDefined === true;
  const localDefined = localConfig?.status === 'present' && localConfig.autoIngestDefined === true;
  const globalPolicy = normalizeAutoIngestPolicy(globalConfig?.autoIngest || {});
  const localPolicy = localDefined ? normalizeAutoIngestPolicy(localConfig.config?.autoIngest || {}) : null;
  if (!localDefined && !globalDefined) return { policy: globalPolicy, policySource: 'default', migrationRequired: false };
  if (!localDefined) return { policy: globalPolicy, policySource: 'global_legacy', migrationRequired: true };
  if (!globalDefined) return { policy: localPolicy, policySource: 'wiki_local', migrationRequired: false };
  if (semanticDiff(globalPolicy, localPolicy).length > 0) {
    throw new ConfigError('CONFIG_CONFLICT', 'CONFIG_CONFLICT local and legacy auto-ingest policies differ');
  }
  return { policy: localPolicy, policySource: 'wiki_local_migrated', migrationRequired: false };
}

function canonicalPolicyDigest(policy) {
  const normalized = normalizeAutoIngestPolicy(policy);
  const source = `${JSON.stringify({ ignore_globs: normalized.ignoreGlobs, require_tag: normalized.requireTag })}\n`;
  return crypto.createHash('sha256').update(source).digest('hex');
}

function semanticDiff(left, right, prefix = '') {
  if (Object.is(left, right)) return [];
  if (Array.isArray(left) && Array.isArray(right)) {
    if (left.length === right.length && left.every((value, index) => Object.is(value, right[index]))) return [];
    return [prefix];
  }
  if (left && right && typeof left === 'object' && typeof right === 'object') {
    const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort(codePointCompare);
    return keys.flatMap((key) => semanticDiff(left[key], right[key], prefix ? `${prefix}.${key}` : key));
  }
  return [prefix];
}

function canonicalCandidate(candidate, fs, platform) {
  const api = pathApi(platform);
  const normalized = api.normalize(candidate);
  return fs.existsSync(normalized) ? api.normalize(realpathNative(fs, normalized)) : normalized;
}

function readConfigCandidate(candidate, fs, platform) {
  let before;
  try { before = fs.lstatSync(candidate.path, { bigint: true }); } catch (cause) {
    throw new ConfigError('CONFIG_INVALID', `${candidate.label} config candidate cannot be inspected`, cause);
  }
  if (before.isSymbolicLink() || !before.isFile()) {
    throw new ConfigError('CONFIG_INVALID', `${candidate.label} config candidate must be a regular non-symlink file`);
  }
  if (typeof fs.openSync !== 'function' || typeof fs.fstatSync !== 'function'
      || typeof fs.closeSync !== 'function') {
    try { return fs.readFileSync(candidate.path, 'utf8'); } catch (cause) {
      throw new ConfigError('CONFIG_INVALID', `${candidate.label} config candidate cannot be read`, cause);
    }
  }
  let descriptor = null;
  try {
    const constants = nodeFs.constants;
    const flags = constants.O_RDONLY
      | (platform === 'win32' ? 0 : (constants.O_NONBLOCK || 0))
      | (constants.O_NOFOLLOW || 0);
    descriptor = fs.openSync(candidate.path, flags);
    const opened = fs.fstatSync(descriptor, { bigint: true });
    if (!opened.isFile()) {
      throw new ConfigError('CONFIG_INVALID', `${candidate.label} config candidate must be a regular non-symlink file`);
    }
    return fs.readFileSync(descriptor, 'utf8');
  } catch (cause) {
    if (cause instanceof ConfigError) throw cause;
    throw new ConfigError('CONFIG_INVALID', `${candidate.label} config candidate cannot be read`, cause);
  } finally {
    if (descriptor !== null) {
      try { fs.closeSync(descriptor); } catch { /* best-effort descriptor cleanup */ }
    }
  }
}

function resolveConfig(env = process.env, options = {}) {
  const platform = options.platform || process.platform;
  const fs = options.fs || nodeFs;
  const api = pathApi(platform);
  let home;
  try { home = resolveHome(env, platform); } catch { home = null; }
  const candidates = [];
  if (env.DEEP_WIKI_CONFIG) candidates.push({ label: 'explicit', path: env.DEEP_WIKI_CONFIG });
  if (env.CODEX_HOME) candidates.push({ label: 'codex_home', path: api.join(env.CODEX_HOME, 'deep-wiki-config.yaml') });
  if (home) {
    candidates.push({ label: 'home_codex', path: api.join(home, '.codex', 'deep-wiki-config.yaml') });
    candidates.push({ label: 'home_claude', path: api.join(home, '.claude', 'deep-wiki-config.yaml') });
  }
  const unique = [];
  const keys = new Set();
  for (const candidate of candidates) {
    if (!api.isAbsolute(candidate.path)) throw new ConfigError('CONFIG_INVALID', `${candidate.label} config path must be absolute`);
    const canonical = canonicalCandidate(candidate.path, fs, platform);
    const key = platform === 'win32' ? canonical.toLowerCase() : canonical;
    if (keys.has(key)) continue;
    keys.add(key);
    unique.push({ ...candidate, path: canonical });
  }
  const extant = unique.filter((candidate) => fs.existsSync(candidate.path)).map((candidate) => {
    const parsed = parseConfig(readConfigCandidate(candidate, fs, platform));
    return { ...candidate, config: normalizeConfigSemantics(parsed, { platform, fs, home, env }) };
  });
  if (extant.length === 0) throw new ConfigError('CONFIG_NOT_FOUND', 'deep-wiki config not found');
  const first = extant[0];
  const conflicts = [];
  for (const candidate of extant.slice(1)) {
    const differences = semanticDiff(first.config, candidate.config);
    if (differences.length > 0) conflicts.push({ label: candidate.label, differences });
  }
  if (conflicts.length > 0) {
    const labels = [first.label, ...conflicts.map((value) => value.label)].join(',');
    const fields = [...new Set(conflicts.flatMap((value) => value.differences))].sort(codePointCompare).join(',');
    throw new ConfigError('CONFIG_CONFLICT', `CONFIG_CONFLICT candidates=${labels} fields=${fields}`);
  }
  const localConfig = loadWikiLocalConfig(first.config.wikiRoot, { fs, platform });
  const effective = resolveEffectivePolicy({ globalConfig: first.config, localConfig });
  return {
    path: first.path,
    label: first.label,
    config: first.config,
    local_config_path: localConfig.path,
    policy_source: effective.policySource,
    migration_required: effective.migrationRequired,
    policy_digest: canonicalPolicyDigest(effective.policy),
  };
}

function resolveConfigWriteTarget(env = process.env, host, options = {}) {
  const platform = options.platform || process.platform;
  const fs = options.fs || nodeFs;
  const api = pathApi(platform);
  let home;
  let target;
  if (host === 'codex') {
    if (env.CODEX_HOME !== undefined && env.CODEX_HOME !== null && typeof env.CODEX_HOME !== 'string') {
      throw new ConfigError('CONFIG_INVALID', 'CODEX_HOME must be an absolute path');
    }
    const rawCodexHome = typeof env.CODEX_HOME === 'string' ? env.CODEX_HOME.trim() : '';
    if (rawCodexHome) {
      let codexHome = rawCodexHome;
      if (codexHome === '~' || codexHome.startsWith('~/') || codexHome.startsWith('~\\')) {
        home = resolveHome(env, platform);
        codexHome = codexHome === '~' ? home : api.join(home, codexHome.slice(2));
      } else if (codexHome.startsWith('~')) {
        throw new ConfigError('CONFIG_INVALID', 'only a standalone leading ~ may be expanded in CODEX_HOME');
      }
      if (!api.isAbsolute(codexHome)) throw new ConfigError('CONFIG_INVALID', 'CODEX_HOME must be absolute');
      target = api.join(api.normalize(codexHome), 'deep-wiki-config.yaml');
    } else {
      home = resolveHome(env, platform);
      target = api.join(home, '.codex', 'deep-wiki-config.yaml');
    }
  } else if (host === 'claude') {
    home = resolveHome(env, platform);
    target = api.join(home, '.claude', 'deep-wiki-config.yaml');
  } else {
    throw new ConfigError('CONFIG_INVALID', 'config host must be codex or claude');
  }
  target = api.normalize(target);
  if (!api.isAbsolute(target)) throw new ConfigError('CONFIG_INVALID', 'config write target must be absolute');
  if (!Object.hasOwn(options, 'desiredConfigText')) return target;
  let desired;
  try {
    desired = normalizeConfigSemantics(parseConfig(options.desiredConfigText), { platform, fs, home, env });
  } catch (cause) {
    throw new ConfigError('CONFIG_TARGET_CONFLICT', 'desired config is invalid', cause);
  }
  let status = 'created';
  if (fs.existsSync(target)) {
    try {
      if (fs.lstatSync(target).isSymbolicLink()) throw new Error('config target is a symlink');
      const existing = normalizeConfigSemantics(parseConfig(fs.readFileSync(target, 'utf8')), { platform, fs, home, env });
      const { autoIngestDefined: ignoredExistingPresence, ...existingWriteComparable } = existing;
      const { autoIngestDefined: ignoredDesiredPresence, ...desiredWriteComparable } = desired;
      if (semanticDiff(existingWriteComparable, desiredWriteComparable).length === 0) return { path: target, status: 'alias' };
      if (!options.replaceConfig) throw new Error('supported config semantics differ');
      status = 'replaced';
    } catch (cause) {
      if (cause instanceof ConfigError && cause.code === 'CONFIG_TARGET_CONFLICT') throw cause;
      if (!options.replaceConfig || /symlink/.test(cause.message)) {
        throw new ConfigError('CONFIG_TARGET_CONFLICT', 'existing config target is not a replaceable semantic alias', cause);
      }
      status = 'replaced';
    }
  }
  const { atomicWriteFile } = require('./fs-safe.js');
  atomicWriteFile(target, options.desiredConfigText);
  return { path: target, status };
}

function compilePortableGlob(pattern) {
  if (typeof pattern !== 'string' || pattern.trim() === '') throw new ConfigError('CONFIG_INVALID', 'glob must not be empty');
  const normalized = pattern.trim().replaceAll('\\', '/');
  let source = '';
  for (let index = 0; index < normalized.length; index += 1) {
    const character = normalized[index];
    if (character === '*') {
      while (normalized[index + 1] === '*') index += 1;
      source += '.*';
    } else if (character === '?') source += '.';
    else source += character.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${source}$`, 'u');
}

function readLogicalLines(file, fs, deadline, limit) {
  if (typeof fs.openSync !== 'function' || typeof fs.readSync !== 'function' || typeof fs.closeSync !== 'function') {
    throw new ConfigError('CONFIG_INVALID', 'bounded streaming frontmatter adapter is unavailable');
  }
  const descriptor = fs.openSync(file, 'r');
  const lines = [];
  let current = [];
  const byte = Buffer.allocUnsafe(1);
  try {
    while (lines.length < limit) {
      const count = fs.readSync(descriptor, byte, 0, 1, null);
      if (count === 0) {
        if (current.length > 0) {
          assertBeforeDeadline(deadline, `frontmatter-line-${lines.length + 1}`);
          lines.push(Buffer.from(current).toString('utf8').replace(/\r$/, ''));
        }
        break;
      }
      if (byte[0] === 0x0a) {
        assertBeforeDeadline(deadline, `frontmatter-line-${lines.length + 1}`);
        lines.push(Buffer.from(current).toString('utf8').replace(/\r$/, ''));
        current = [];
      } else {
        current.push(byte[0]);
      }
    }
  } finally {
    fs.closeSync(descriptor);
  }
  if (lines.length > 0) lines[0] = lines[0].replace(/^\uFEFF/, '');
  return lines;
}

function readFrontmatterTags(file, options = {}) {
  const fs = options.fs || nodeFs;
  const { deadline } = options;
  if (!deadline) throw new TypeError('readFrontmatterTags requires a deadline');
  assertBeforeDeadline(deadline, 'frontmatter-open');
  const lines = readLogicalLines(file, fs, deadline, 200);
  if (lines.length === 0) return [];
  assertBeforeDeadline(deadline, 'frontmatter-line-1');
  if (lines[0] !== '---') return [];
  const tags = [];
  let inTags = false;
  for (let index = 1; index < lines.length; index += 1) {
    assertBeforeDeadline(deadline, `frontmatter-line-${index + 1}`);
    const line = stripComment(lines[index]);
    if (line.trim() === '---') break;
    const inline = line.match(/^tags\s*:\s*(.*)$/);
    if (inline) {
      const values = inlineList(inline[1]);
      if (values) tags.push(...values);
      inTags = inline[1].trim() === '';
      continue;
    }
    const item = line.match(/^\s+-\s*(.+?)\s*$/);
    if (inTags && item) tags.push(scalarValue(item[1]));
    else if (line.trim() && !/^\s/.test(line)) inTags = false;
  }
  return tags;
}

module.exports = {
  ISO_UTC_RE,
  parseConfig,
  normalizeConfigSemantics,
  loadWikiLocalConfig,
  resolveEffectivePolicy,
  canonicalPolicyDigest,
  resolveHome,
  resolveConfig,
  resolveConfigWriteTarget,
  normalizeWikiRoot,
  compilePortableGlob,
  readFrontmatterTags,
};
