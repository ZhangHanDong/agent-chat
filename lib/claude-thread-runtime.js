import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export class ClaudeRuntimeConfigurationError extends Error {}

function readObject(file) {
  if (!existsSync(file)) return {};
  if (lstatSync(file).isSymbolicLink()) throw new ClaudeRuntimeConfigurationError(`refusing symlink runtime configuration: ${file}`);
  let value;
  try { value = JSON.parse(readFileSync(file, 'utf8')); }
  catch (error) {
    if (error instanceof SyntaxError) throw new ClaudeRuntimeConfigurationError(`invalid runtime configuration: ${file}`);
    throw error;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ClaudeRuntimeConfigurationError(`invalid runtime configuration: ${file}`);
  return value;
}

function writeObject(file, value) {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  if (existsSync(file) && readFileSync(file, 'utf8') === text) return;
  const temporary = `${file}.${randomUUID()}.tmp`;
  writeFileSync(temporary, text, { mode: 0o600, flag: 'wx' });
  renameSync(temporary, file);
}

/** Prepare the same channel and protected-operation rules as the managed launcher. */
export function prepareClaudeThreadRuntime(agent, { repoRoot, runtimeRoot, apiBaseUrl, serverName }) {
  if (!agent.workdir || !path.isAbsolute(agent.workdir)) throw new ClaudeRuntimeConfigurationError('Claude thread runtime requires an absolute managed workdir');
  const mcpPath = path.join(agent.workdir, '.mcp.json');
  const config = readObject(mcpPath);
  if (config.mcpServers !== undefined && (!config.mcpServers || typeof config.mcpServers !== 'object' || Array.isArray(config.mcpServers))) {
    throw new ClaudeRuntimeConfigurationError('invalid Claude mcpServers configuration');
  }
  config.mcpServers ??= {};
  config.mcpServers[serverName] = {
    command: process.execPath,
    args: [path.join(repoRoot, 'mcp-server.js')],
    // Tokens and dispatch capabilities are inherited at spawn time, never saved here.
    env: { AGENT_NAME: agent.name, HAFLEET_API: apiBaseUrl, HAFLEET_RUNTIME_DIR: runtimeRoot,
      HAFLEET_MCP_SERVER_NAME: serverName, HAFLEET_AGENT_STATE_DIR: agent.stateDir },
  };
  const settingsDir = path.join(agent.workdir, '.claude');
  if (existsSync(settingsDir) && lstatSync(settingsDir).isSymbolicLink()) throw new ClaudeRuntimeConfigurationError('refusing symlink Claude settings directory');
  mkdirSync(settingsDir, { recursive: true });
  const settingsPath = path.join(settingsDir, 'settings.json');
  const settings = readObject(settingsPath);
  if (settings.permissions === undefined) settings.permissions = {};
  if (!settings.permissions || typeof settings.permissions !== 'object' || Array.isArray(settings.permissions)) throw new ClaudeRuntimeConfigurationError('invalid Claude permissions configuration');
  if (settings.permissions.ask === undefined) settings.permissions.ask = [];
  if (!Array.isArray(settings.permissions.ask) || settings.permissions.ask.some((rule) => typeof rule !== 'string')) {
    throw new ClaudeRuntimeConfigurationError('invalid Claude permission ask rules');
  }
  for (const rule of ['Bash(gh *)', 'Bash(git push *)']) {
    if (!settings.permissions.ask.includes(rule)) settings.permissions.ask.push(rule);
  }
  writeObject(mcpPath, config);
  writeObject(settingsPath, settings);
  return mcpPath;
}

export function claudeThreadModel(agent, override) {
  const model = override || agent.runtimeProfile?.primary?.model || null;
  if (model !== null && (typeof model !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(model))) {
    throw new ClaudeRuntimeConfigurationError('invalid Claude runtime model');
  }
  return model;
}
