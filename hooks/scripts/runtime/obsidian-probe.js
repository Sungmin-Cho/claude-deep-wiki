'use strict';

const childProcess = require('node:child_process');
const nodeFs = require('node:fs');
const path = require('node:path');

const PROBE_TIMEOUT_MS = 3000;
const MAX_PROBE_SPAWNS = 3;
const MAX_PROBE_OUTPUT_BYTES = 64 * 1024;
const MAX_ERROR_CHARS = 200;
const POSIX_BINARY_NAMES = ['obsidian', 'Obsidian'];
const WINDOWS_BINARY_NAMES = ['obsidian.exe', 'Obsidian.exe', 'obsidian.cmd', 'obsidian.bat'];

function flavor(platform) {
  return platform === 'win32' ? path.win32 : path.posix;
}

function resolveHome(env, platform) {
  if (typeof env.HOME === 'string' && env.HOME.trim()) return env.HOME.trim();
  if (platform === 'win32' && typeof env.USERPROFILE === 'string' && env.USERPROFILE.trim()) {
    return env.USERPROFILE.trim();
  }
  return null;
}

function pathEntries(env, platform) {
  const raw = typeof env.PATH === 'string' ? env.PATH
    : (platform === 'win32' && typeof env.Path === 'string' ? env.Path : '');
  const delimiter = platform === 'win32' ? ';' : ':';
  return raw.split(delimiter).map((entry) => entry.trim()).filter((entry) => entry !== '');
}

function wellKnownLocations(env, platform) {
  const api = flavor(platform);
  const home = resolveHome(env, platform);
  if (platform === 'darwin') {
    const locations = ['/Applications/Obsidian.app/Contents/MacOS/Obsidian'];
    if (home) locations.push(api.join(home, 'Applications', 'Obsidian.app', 'Contents', 'MacOS', 'Obsidian'));
    return locations;
  }
  if (platform === 'win32') {
    const locations = [];
    const localAppData = typeof env.LOCALAPPDATA === 'string' && env.LOCALAPPDATA.trim()
      ? env.LOCALAPPDATA.trim()
      : (home ? api.join(home, 'AppData', 'Local') : null);
    if (localAppData) locations.push(api.join(localAppData, 'Programs', 'obsidian', 'Obsidian.exe'));
    const programFiles = typeof env.ProgramFiles === 'string' && env.ProgramFiles.trim()
      ? env.ProgramFiles.trim()
      : (typeof env.PROGRAMFILES === 'string' ? env.PROGRAMFILES.trim() : '');
    if (programFiles) locations.push(api.join(programFiles, 'Obsidian', 'Obsidian.exe'));
    return locations;
  }
  const locations = [
    '/usr/bin/obsidian',
    '/usr/local/bin/obsidian',
    '/opt/Obsidian/obsidian',
    '/var/lib/flatpak/exports/bin/md.obsidian.Obsidian',
    '/snap/bin/obsidian',
  ];
  if (home) locations.push(api.join(home, '.local', 'bin', 'obsidian'));
  return locations;
}

function discoverCandidates(options) {
  const env = options.env;
  const platform = options.platform;
  const exists = options.exists;
  const api = flavor(platform);
  const names = platform === 'win32' ? WINDOWS_BINARY_NAMES : POSIX_BINARY_NAMES;
  const seen = new Set();
  const candidates = [];

  function add(executable, source) {
    const key = platform === 'win32' ? executable.toLowerCase() : executable;
    if (seen.has(key) || !exists(executable)) return;
    seen.add(key);
    candidates.push({ executable, source });
  }

  const override = typeof env.DEEP_WIKI_OBSIDIAN_BIN === 'string' ? env.DEEP_WIKI_OBSIDIAN_BIN.trim() : '';
  if (override && api.isAbsolute(override)) add(override, 'env');
  for (const directory of pathEntries(env, platform)) {
    for (const name of names) add(api.join(directory, name), 'path');
  }
  for (const location of wellKnownLocations(env, platform)) add(location, 'well-known');
  return candidates;
}

function parseVaultOutput(stdout) {
  const fields = {};
  for (const line of String(stdout).split('\n')) {
    const separator = line.indexOf('\t');
    if (separator <= 0) continue;
    fields[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
  }
  if (typeof fields.name !== 'string' && typeof fields.path !== 'string') return null;
  return { name: fields.name ?? null, path: fields.path ?? null };
}

function firstErrorLine(spawnResult) {
  if (spawnResult.error) {
    if (spawnResult.error.code === 'ETIMEDOUT') return 'probe timed out';
    return String(spawnResult.error.message || spawnResult.error.code || 'spawn failed')
      .split('\n')[0].slice(0, MAX_ERROR_CHARS);
  }
  const stderrLine = String(spawnResult.stderr || '').split('\n')
    .map((line) => line.trim()).find((line) => line !== '');
  if (stderrLine) return stderrLine.slice(0, MAX_ERROR_CHARS);
  return `exit status ${spawnResult.status}`;
}

function probeObsidian(options = {}) {
  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  const exists = options.exists || nodeFs.existsSync;
  const spawnSync = options.spawnSync || childProcess.spawnSync;
  const timeoutMs = options.timeoutMs || PROBE_TIMEOUT_MS;

  const candidates = discoverCandidates({ env, platform, exists });
  let checked = 0;
  let firstFailure = null;

  for (const candidate of candidates) {
    if (checked >= MAX_PROBE_SPAWNS) break;
    checked += 1;
    let result;
    try {
      result = spawnSync(candidate.executable, ['vault'], {
        shell: false,
        timeout: timeoutMs,
        killSignal: 'SIGKILL',
        encoding: 'utf8',
        maxBuffer: MAX_PROBE_OUTPUT_BYTES,
        windowsHide: true,
      });
    } catch (error) {
      result = { status: null, stdout: '', stderr: '', error };
    }
    if (result.status === 0 && !result.error) {
      return {
        found: true,
        reachable: true,
        executable: candidate.executable,
        source: candidate.source,
        vault: parseVaultOutput(result.stdout),
        error: null,
        candidatesChecked: checked,
      };
    }
    if (!firstFailure) {
      firstFailure = {
        executable: candidate.executable,
        source: candidate.source,
        error: firstErrorLine(result),
      };
    }
  }

  if (firstFailure) {
    return {
      found: true,
      reachable: false,
      executable: firstFailure.executable,
      source: firstFailure.source,
      vault: null,
      error: firstFailure.error,
      candidatesChecked: checked,
    };
  }
  return {
    found: false,
    reachable: false,
    executable: null,
    source: null,
    vault: null,
    error: null,
    candidatesChecked: 0,
  };
}

module.exports = {
  PROBE_TIMEOUT_MS,
  discoverCandidates,
  parseVaultOutput,
  probeObsidian,
};
