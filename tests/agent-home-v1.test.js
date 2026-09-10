import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, test } from 'vitest';
import {
  allAgentHomeRoots,
  buildV1AgentPaths,
  defaultAgentchatHomeDir,
  readV1AgentManifest,
} from '../lib/agent-home-v1.js';

const cleanupDirs = new Set();

function trackTempDir(prefix) {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanupDirs.add(dir);
  return dir;
}

afterEach(() => {
  for (const dir of cleanupDirs) rmSync(dir, { recursive: true, force: true });
  cleanupDirs.clear();
});

describe('agent home v1 resolver', () => {
  test('uses absolute HAGENCY_HOMEDIR before runtime-derived homes', () => {
    const homeRoot = trackTempDir('hagency-home-root-');
    const runtimeRoot = trackTempDir('hagency-runtime-root-');

    expect(defaultAgentchatHomeDir({
      HAGENCY_HOMEDIR: homeRoot,
      HAGENCY_RUNTIME_DIR: runtimeRoot,
    })).toBe(homeRoot);

    expect(buildV1AgentPaths('Alpha Agent', {
      HAGENCY_HOMEDIR: homeRoot,
      HAGENCY_RUNTIME_DIR: runtimeRoot,
    })).toMatchObject({
      homeRoot,
      agentId: 'agent_alpha_agent',
      homeDir: path.join(homeRoot, 'agents', 'agent_alpha_agent'),
      stateDir: path.join(homeRoot, 'agents', 'agent_alpha_agent', 'state'),
      workdir: path.join(homeRoot, 'agents', 'agent_alpha_agent', 'workdir'),
    });
  });

  test('ignores relative home env values before falling back to runtime-derived homes', () => {
    const runtimeRoot = trackTempDir('hagency-runtime-root-');

    expect(defaultAgentchatHomeDir({
      HAGENCY_HOMEDIR: 'relative-home',
      HAGENCY_RUNTIME_DIR: runtimeRoot,
    })).toBe(path.join(runtimeRoot, 'homes'));
  });

  test('ignores relative runtime env values before falling back to legacy home', () => {
    expect(defaultAgentchatHomeDir({
      HAGENCY_RUNTIME_DIR: 'relative-runtime',
    })).toBe(path.join(os.homedir(), '.hagency'));
  });

  test('keeps legacy home as a lookup fallback when primary differs', () => {
    const runtimeRoot = trackTempDir('hagency-runtime-root-');
    expect(allAgentHomeRoots({ HAGENCY_RUNTIME_DIR: runtimeRoot })).toEqual([
      path.join(runtimeRoot, 'homes'),
      path.join(os.homedir(), '.hagency'),
    ]);
  });

  test('rejects manifests with relative runtime paths', () => {
    const manifestDir = trackTempDir('hagency-manifest-');
    const manifestPath = path.join(manifestDir, 'agent.json');
    mkdirSync(path.join(manifestDir, 'state'), { recursive: true });
    writeFileSync(manifestPath, JSON.stringify({
      id: 'agent_alpha',
      name: 'alpha',
      homeDir: 'relative/home',
      stateDir: path.join(manifestDir, 'state'),
      workdir: path.join(manifestDir, 'workdir'),
    }), 'utf-8');

    expect(readV1AgentManifest(manifestPath)).toBeNull();
  });
});
