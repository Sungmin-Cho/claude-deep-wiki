#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const EXEC_MARKER = '<!-- deep-wiki:exec -->';
const DATA_MARKER = '<!-- deep-wiki:data -->';
const SHELL_FENCES = new Set(['bash', 'sh', 'shell', 'cmd', 'bat', 'powershell', 'ps1']);
const EXEC_KEYS = new Set(['executable', 'argv', 'timeout_ms']);
const HOOK_KEYS = new Set(['type', 'command', 'commandWindows', 'timeout', 'statusMessage']);

class CommandSyntaxError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'CommandSyntaxError';
    this.code = code;
  }
}

function violation(reason, line, column = 1) {
  return { reason, line, column };
}

function fenceAt(line) {
  const match = /^( {0,3})(`{3,}|~{3,})(.*)$/.exec(line);
  if (!match) return null;
  const info = match[3].trim().split(/\s+/, 1)[0].toLowerCase();
  return {
    indent: match[1].length,
    character: match[2][0],
    length: match[2].length,
    info,
  };
}

function closingFence(line, opener) {
  const match = /^( {0,3})(`+|~+)\s*$/.exec(line);
  return Boolean(
    match
      && match[2][0] === opener.character
      && match[2].length >= opener.length,
  );
}

function findFenceEnd(lines, start, opener) {
  for (let index = start + 1; index < lines.length; index += 1) {
    if (closingFence(lines[index], opener)) return index;
  }
  return -1;
}

function parseExecObject(body, line, column, violations) {
  let value;
  try {
    value = JSON.parse(body.trim());
  } catch {
    violations.push(violation('EXEC_JSON_INVALID', line, column));
    return null;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    violations.push(violation('EXEC_OBJECT_INVALID', line, column));
    return null;
  }
  const unknown = Object.keys(value).filter((key) => !EXEC_KEYS.has(key));
  if (unknown.length > 0) {
    violations.push(violation('EXEC_UNKNOWN_KEY', line, column));
    return null;
  }
  if (typeof value.executable !== 'string' || !Array.isArray(value.argv)
      || !value.argv.every((entry) => typeof entry === 'string')) {
    violations.push(violation('EXEC_OBJECT_INVALID', line, column));
    return null;
  }
  if (Object.hasOwn(value, 'timeout_ms')
      && (!Number.isInteger(value.timeout_ms) || value.timeout_ms <= 0)) {
    violations.push(violation('EXEC_OBJECT_INVALID', line, column));
    return null;
  }
  return {
    kind: 'exec',
    executable: value.executable,
    argv: [...value.argv],
    timeout_ms: value.timeout_ms ?? null,
    line,
    column,
  };
}

function parseMarkdownCommands(markdown) {
  const lines = String(markdown).replace(/\r\n?/g, '\n').split('\n');
  const commands = [];
  const violations = [];

  for (let index = 0; index < lines.length; index += 1) {
    const trimmed = lines[index].trim();
    const marker = trimmed === EXEC_MARKER || trimmed === DATA_MARKER ? trimmed : null;
    if (marker) {
      const opener = index + 1 < lines.length ? fenceAt(lines[index + 1]) : null;
      if (!opener) {
        violations.push(violation(
          marker === EXEC_MARKER ? 'EXEC_MARKER_NOT_FOLLOWED' : 'DATA_MARKER_NOT_FOLLOWED',
          index + 1,
        ));
        continue;
      }
      const end = findFenceEnd(lines, index + 1, opener);
      if (end < 0) {
        violations.push(violation('FENCE_UNCLOSED', index + 2));
        break;
      }
      if (marker === EXEC_MARKER) {
        if (opener.info !== 'deep-wiki-exec') {
          violations.push(violation('EXEC_MARKER_WRONG_FENCE', index + 2));
        } else {
          const bodyStart = index + 2;
          const body = lines.slice(bodyStart, end).join('\n');
          const firstBody = lines[bodyStart] || '';
          const column = Math.max(1, firstBody.search(/\S/) + 1);
          const command = parseExecObject(body, bodyStart + 1, column, violations);
          if (command) commands.push(command);
        }
      }
      index = end;
      continue;
    }

    const opener = fenceAt(lines[index]);
    if (!opener) continue;
    const end = findFenceEnd(lines, index, opener);
    if (end < 0) {
      violations.push(violation('FENCE_UNCLOSED', index + 1));
      break;
    }
    if (opener.info === 'deep-wiki-exec') {
      violations.push(violation('EXEC_FENCE_OUTSIDE_POSITION', index + 1));
    } else if (SHELL_FENCES.has(opener.info)) {
      violations.push(violation('UNCLASSIFIED_EXECUTABLE_FENCE', index + 1));
    } else {
      violations.push(violation('UNCLASSIFIED_DATA_FENCE', index + 1));
    }
    index = end;
  }

  return { commands, violations };
}

function containsArgOperator(value) {
  return /\$\(|`|[|;&<>]|[\r\n]/.test(value);
}

function isAllowedRuntimeScript(value) {
  return value === '<plugin_root>/scripts/wiki-runtime.js'
    || value === '${CLAUDE_PLUGIN_ROOT}/scripts/wiki-runtime.js'
    || value === '%CLAUDE_PLUGIN_ROOT%\\scripts\\wiki-runtime.js';
}

function normalizeCommandPolicy(policy) {
  if (Array.isArray(policy) && policy.every((entry) => typeof entry === 'string')) {
    return { families: new Set(policy), commands: [] };
  }
  const commands = policy && Array.isArray(policy.commands) ? policy.commands : [];
  return {
    families: new Set(commands.map((command) => command[0])),
    commands,
  };
}

function matchesCommandContract(argv, contract) {
  if (!Array.isArray(contract) || argv.length !== contract.length) return false;
  return contract.every((expected, index) => expected === null
    ? typeof argv[index] === 'string' && argv[index] !== '' && !argv[index].startsWith('--')
    : argv[index] === expected);
}

function validateSkillCommands(file, markdown, allowlist) {
  const parsed = parseMarkdownCommands(markdown);
  const violations = [...parsed.violations];
  const policy = normalizeCommandPolicy(allowlist);

  for (const command of parsed.commands) {
    if (command.executable === 'node') {
      if (command.argv.length < 2 || !isAllowedRuntimeScript(command.argv[0])) {
        violations.push(violation('NODE_SCRIPT_NOT_ALLOWED', command.line, command.column));
        continue;
      }
      if (command.argv.slice(1).some(containsArgOperator)) {
        violations.push(violation('ARGV_OPERATOR', command.line, command.column));
        continue;
      }
      if (!policy.families.has(command.argv[1])) {
        violations.push(violation('COMMAND_FAMILY_NOT_ALLOWED', command.line, command.column));
      } else if (policy.commands.length > 0
          && !policy.commands.some((contract) => matchesCommandContract(command.argv.slice(1), contract))) {
        violations.push(violation('COMMAND_ARGV_NOT_ALLOWED', command.line, command.column));
      }
      continue;
    }

    violations.push(violation('EXECUTABLE_NOT_ALLOWED', command.line, command.column));
  }

  return { file, commands: parsed.commands, violations };
}

function tokenizeCommand(command, windows) {
  const text = String(command);
  const tokens = [];
  let token = '';
  let quote = null;
  let tokenStarted = false;

  function pushToken() {
    if (tokenStarted) tokens.push(token);
    token = '';
    tokenStarted = false;
  }

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];

    if (char === '`' || (char === '$' && next === '(')) {
      throw new CommandSyntaxError('COMMAND_OPERATOR', 'command substitution is not allowed');
    }

    if (quote) {
      if (char === quote) {
        quote = null;
        tokenStarted = true;
      } else if (!windows && char === '\\' && quote === '"' && next !== undefined) {
        token += next;
        tokenStarted = true;
        index += 1;
      } else {
        token += char;
        tokenStarted = true;
      }
      continue;
    }

    if (char === '"' || (!windows && char === "'")) {
      quote = char;
      tokenStarted = true;
      continue;
    }
    if (/\s/.test(char)) {
      pushToken();
      continue;
    }
    if ('<>|;&'.includes(char)) {
      throw new CommandSyntaxError('COMMAND_OPERATOR', 'shell operators are not allowed');
    }
    if (!windows && char === '\\' && next !== undefined) {
      token += next;
      tokenStarted = true;
      index += 1;
      continue;
    }
    token += char;
    tokenStarted = true;
  }

  if (quote) throw new CommandSyntaxError('COMMAND_UNTERMINATED_QUOTE', 'unterminated quote');
  pushToken();
  return tokens;
}

function tokenizePosixCommand(command) {
  return tokenizeCommand(command, false);
}

function tokenizeWindowsCommand(command) {
  return tokenizeCommand(command, true);
}

function modelHookInvocation(command, variant, options = {}) {
  const pluginRoot = options.pluginRoot || (variant === 'commandWindows'
    ? 'C:\\Deep Wiki Plugin'
    : '/opt/deep wiki plugin');
  if (variant === 'command') {
    const expanded = String(command).replaceAll('${CLAUDE_PLUGIN_ROOT}', pluginRoot);
    return { outerExecutable: null, outerArgv: [], command: expanded, argv: tokenizePosixCommand(expanded) };
  }
  if (variant === 'commandWindows') {
    const expanded = String(command).replaceAll('${CLAUDE_PLUGIN_ROOT}', pluginRoot);
    const comspec = options.comspec || 'C:\\Windows\\System32\\cmd.exe';
    return {
      outerExecutable: comspec,
      outerArgv: ['/C', expanded],
      command: expanded,
      argv: tokenizeWindowsCommand(expanded),
    };
  }
  throw new CommandSyntaxError('HOOK_VARIANT_INVALID', 'hook variant is invalid');
}

function collectHandlerObjects(document) {
  const handlers = [];
  const registrations = document && document.hooks && document.hooks.SessionStart;
  if (!Array.isArray(registrations)) return handlers;
  for (const registration of registrations) {
    if (!registration || !Array.isArray(registration.hooks)) continue;
    for (const handler of registration.hooks) handlers.push(handler);
  }
  return handlers;
}

function findOutOfPositionCommands(value, handlers, violations, currentPath = '$') {
  if (!value || typeof value !== 'object') return;
  if (handlers.has(value)) {
    for (const [key, child] of Object.entries(value)) {
      if (key === 'command' || key === 'commandWindows') continue;
      findOutOfPositionCommands(child, handlers, violations, `${currentPath}.${key}`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => findOutOfPositionCommands(
      entry,
      handlers,
      violations,
      `${currentPath}[${index}]`,
    ));
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (key === 'command' || key === 'commandWindows') {
      violations.push({ reason: 'HOOK_COMMAND_OUTSIDE_HANDLER', path: `${currentPath}.${key}` });
    }
    findOutOfPositionCommands(child, handlers, violations, `${currentPath}.${key}`);
  }
}

function validateHookVariant(handler, variant, violations, commands) {
  if (!Object.hasOwn(handler, variant)) return;
  const raw = handler[variant];
  if (typeof raw !== 'string' || raw.trim() === '') {
    violations.push({ reason: 'HOOK_COMMAND_MISSING', variant });
    return;
  }
  let tokens;
  try {
    tokens = variant === 'commandWindows'
      ? tokenizeWindowsCommand(raw)
      : tokenizePosixCommand(raw);
  } catch (error) {
    violations.push({
      reason: error.code === 'COMMAND_OPERATOR' ? 'HOOK_OPERATOR' : 'HOOK_COMMAND_PARSE',
      variant,
    });
    return;
  }
  if (tokens[0] !== 'node') {
    violations.push({ reason: 'HOOK_EXECUTABLE_NOT_ALLOWED', variant });
    return;
  }
  if (tokens.length > 2) {
    violations.push({ reason: 'HOOK_EXTRA_ARGV', variant });
    return;
  }
  const expected = variant === 'commandWindows'
    ? '${CLAUDE_PLUGIN_ROOT}\\hooks\\scripts\\scan-vault-changes.js'
    : '${CLAUDE_PLUGIN_ROOT}/hooks/scripts/scan-vault-changes.js';
  if (tokens.length !== 2 || tokens[1] !== expected) {
    violations.push({ reason: 'HOOK_SCRIPT_NOT_ALLOWED', variant });
    return;
  }
  commands.push({ executable: 'node', argv: [tokens[1]], variant });
}

function validateHookCommands(document) {
  const commands = [];
  const violations = [];
  const handlerObjects = collectHandlerObjects(document);
  const handlerSet = new Set(handlerObjects);
  const registrations = document && document.hooks && document.hooks.SessionStart;
  if (!Array.isArray(registrations)
      || registrations.length !== 1
      || !registrations[0]
      || !Array.isArray(registrations[0].hooks)
      || registrations[0].hooks.length !== 1) {
    violations.push({ reason: 'HOOK_SESSION_START_SHAPE' });
  }
  findOutOfPositionCommands(document, handlerSet, violations);

  for (const handler of handlerObjects) {
    if (!handler || typeof handler !== 'object' || Array.isArray(handler)) {
      violations.push({ reason: 'HOOK_ENTRY_INVALID' });
      continue;
    }
    if (Object.keys(handler).some((key) => !HOOK_KEYS.has(key))) {
      violations.push({ reason: 'HOOK_ENTRY_KEYS_UNSUPPORTED' });
    }
    if (handler.type !== 'command') violations.push({ reason: 'HOOK_TYPE_UNSUPPORTED' });
    if (handler.timeout !== 15) violations.push({ reason: 'HOOK_TIMEOUT_INVALID' });
    if (!Object.hasOwn(handler, 'command')) violations.push({ reason: 'HOOK_COMMAND_MISSING' });
    validateHookVariant(handler, 'command', violations, commands);
    validateHookVariant(handler, 'commandWindows', violations, commands);
  }
  return { commands, violations };
}

const SKILL_COMMAND_CONTRACTS = {
  'wiki-setup': { commands: [
    ['config', 'resolve', '--json'],
    ['setup', '--wiki-root', null, '--config-host', 'claude', '--json'],
    ['setup', '--wiki-root', null, '--config-host', 'codex', '--json'],
    ['setup', '--rebind-authority-from', null, '--wiki-root', null, '--config-host', 'claude', '--json'],
    ['setup', '--rebind-authority-from', null, '--wiki-root', null, '--config-host', 'codex', '--json'],
    ['probe', 'obsidian', '--json'],
  ] },
  'wiki-ingest': { commands: [
    ['config', 'resolve', '--json'],
    ['snapshot', '--wiki-root', null, '--json'],
    ['obsidian', 'search', '--query', null, '--limit', null, '--json'],
    ['obsidian', 'search', '--query', null, '--json'],
    ['obsidian', 'backlinks', '--path', null, '--json'],
    ['obsidian', 'tags', '--json'],
    ['lock', 'acquire', '--wiki-root', null, '--operation', 'ingest', '--json'],
    ['inbox', 'cleanup', '--wiki-root', null, '--lock-token', null, '--max-age-days', '7', '--json'],
    ['commit', '--wiki-root', null, '--lock-token', null, '--manifest-file', null, '--json'],
    ['transaction', 'recover', '--wiki-root', null, '--lock-token', null, '--operation-id', null, '--json'],
    ['scan-window', 'promote', '--wiki-root', null, '--lock-token', null, '--expected', null, '--json'],
    ['scan-window', 'fail', '--wiki-root', null, '--lock-token', null, '--source', null, '--json'],
    ['lock', 'release', '--wiki-root', null, '--token', null, '--json'],
  ] },
  'wiki-query': { commands: [
    ['index', 'read', '--wiki-root', null, '--json'],
    ['lock', 'acquire', '--wiki-root', null, '--operation', 'query-filed', '--json'],
    ['commit', '--wiki-root', null, '--lock-token', null, '--manifest-file', null, '--json'],
    ['transaction', 'recover', '--wiki-root', null, '--lock-token', null, '--operation-id', null, '--json'],
    ['lock', 'release', '--wiki-root', null, '--token', null, '--json'],
  ] },
  'wiki-lint': { commands: [
    ['lint', 'inspect', '--wiki-root', null, '--json'],
    ['lint', 'fix', '--wiki-root', null, '--json'],
    ['lock', 'status', '--wiki-root', null, '--json'],
    ['lock', 'recover', '--wiki-root', null, '--stale-ms', null, '--json'],
    ['transaction', 'quarantine', '--wiki-root', null, '--operation-id', null, '--json'],
  ] },
  'wiki-rebuild': { commands: [
    ['lock', 'acquire', '--wiki-root', null, '--operation', 'rebuild', '--json'],
    ['commit', '--wiki-root', null, '--lock-token', null, '--manifest-file', null, '--json'],
    ['lock', 'status', '--wiki-root', null, '--json'],
    ['transaction', 'recover', '--wiki-root', null, '--lock-token', null, '--operation-id', null, '--json'],
    ['lint', 'inspect', '--wiki-root', null, '--json'],
    ['lock', 'release', '--wiki-root', null, '--token', null, '--json'],
  ] },
};

function printViolations(file, violations) {
  for (const item of violations) {
    const position = item.line ? `:${item.line}:${item.column || 1}` : '';
    process.stderr.write(`${file}${position} ${item.reason}\n`);
  }
}

function cli(argv) {
  const root = path.resolve(__dirname, '..', '..');
  const mode = argv[2];
  if (mode !== '--check-hooks' && mode !== '--check') {
    process.stderr.write('usage: executable-contract.js --check-hooks|--check\n');
    return 2;
  }
  let failures = 0;
  const hookFile = path.join(root, 'hooks', 'hooks.json');
  const hookResult = validateHookCommands(JSON.parse(fs.readFileSync(hookFile, 'utf8')));
  printViolations('hooks/hooks.json', hookResult.violations);
  failures += hookResult.violations.length;

  if (mode === '--check') {
    for (const [skill, allowlist] of Object.entries(SKILL_COMMAND_CONTRACTS)) {
      const relative = `skills/${skill}/SKILL.md`;
      const content = fs.readFileSync(path.join(root, relative), 'utf8');
      const result = validateSkillCommands(relative, content, allowlist);
      printViolations(relative, result.violations);
      failures += result.violations.length;
    }
  }
  return failures === 0 ? 0 : 1;
}

module.exports = {
  parseMarkdownCommands,
  validateSkillCommands,
  validateHookCommands,
  tokenizePosixCommand,
  tokenizeWindowsCommand,
  modelHookInvocation,
  SKILL_COMMAND_CONTRACTS,
};

if (require.main === module) process.exitCode = cli(process.argv);
