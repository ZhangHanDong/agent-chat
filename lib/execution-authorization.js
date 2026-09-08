import { createHash } from 'node:crypto';
import path from 'node:path';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const keysWithin = (value, keys) => object(value) && Object.keys(value).every(key => keys.includes(key));
const bounded = value => typeof value === 'string' && value.length > 0 && value.length <= 8192 && !value.includes('\0');
const absolute = value => bounded(value) && path.isAbsolute(value);
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (object(value)) return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
const digest = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');

export function normalizeExecutionPolicy(value, framework) {
  if (value === undefined || value === null) return { yolo: false };
  if (!keysWithin(value, ['yolo']) || typeof value.yolo !== 'boolean') {
    throw Object.assign(new Error('executionPolicy requires a boolean yolo'), { code: 'bad_request' });
  }
  if (value.yolo && framework !== 'codex') {
    throw Object.assign(new Error('YOLO is supported only for Codex'), { code: 'bad_request' });
  }
  return { yolo: value.yolo };
}

function permissionProfile(value) {
  if (!keysWithin(value, ['network', 'fileSystem'])) return null;
  const result = {}, descriptions = [];
  if (value.network != null) {
    if (!keysWithin(value.network, ['enabled']) || typeof value.network.enabled !== 'boolean') return null;
    result.network = { enabled: value.network.enabled };
    if (value.network.enabled) descriptions.push('Network access: all destinations (not limited to a domain)');
  }
  if (value.fileSystem != null) {
    const fs = value.fileSystem;
    if (!keysWithin(fs, ['read', 'write', 'entries', 'globScanMaxDepth']) || fs.globScanMaxDepth != null) return null;
    const normalized = {};
    for (const mode of ['read', 'write']) {
      if (fs[mode] == null) continue;
      if (!Array.isArray(fs[mode]) || fs[mode].length > 64 || !fs[mode].every(absolute)) return null;
      normalized[mode] = [...new Set(fs[mode].map(p => path.normalize(p)))].sort();
      for (const p of normalized[mode]) descriptions.push(`${mode}: ${p}`);
    }
    if (fs.entries != null) {
      if (!Array.isArray(fs.entries) || fs.entries.length > 64) return null;
      normalized.entries = [];
      for (const entry of fs.entries) {
        if (!keysWithin(entry, ['access', 'path']) || !['read', 'write'].includes(entry.access)
          || !keysWithin(entry.path, ['type', 'path']) || entry.path.type !== 'path' || !absolute(entry.path.path)) return null;
        const p = path.normalize(entry.path.path);
        normalized.entries.push({ access: entry.access, path: { type: 'path', path: p } });
        descriptions.push(`${entry.access}: ${p}`);
      }
      normalized.entries.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    }
    result.fileSystem = normalized;
  }
  return descriptions.length ? { value: result, description: descriptions.join('\n') } : null;
}

// Host-owned JSON-RPC metadata only. Never derive privileges from reason text,
// preview text, an Agent HTTP body, or a locally parsed shell prefix.
export function deriveExecutionAuthorization(input) {
  if (!object(input) || !bounded(input.agentId) || !absolute(input.workspace)
    || typeof input.mayWrite !== 'boolean' || !object(input.params)) return null;
  const p = input.params;
  if (p.environmentId != null && !bounded(p.environmentId)) return null;
  const common = ['threadId', 'turnId', 'itemId', 'approvalId', 'startedAtMs', 'reason', 'environmentId'];
  let scope;
  if (input.method === 'item/commandExecution/requestApproval') {
    if (!keysWithin(p, [...common, 'command', 'cwd', 'commandActions', 'kind', 'networkApprovalContext',
      'proposedExecpolicyAmendment', 'proposedNetworkPolicyAmendments', 'availableDecisions', 'additionalPermissions'])
      || (p.kind != null && p.kind !== 'command')) return null;
    if (p.networkApprovalContext != null) {
      const net = p.networkApprovalContext;
      if (!keysWithin(net, ['host', 'protocol']) || !bounded(net.host)
        || !/^[a-z0-9.-]+(?::[0-9]{1,5})?$/i.test(net.host)
        || !['http', 'https', 'socks5Tcp', 'socks5Udp'].includes(net.protocol)
        || p.additionalPermissions != null) return null;
      const host = net.host.toLowerCase();
      scope = { kind: 'network_host', value: { host, protocol: net.protocol },
        description: `Network host: ${host}\nProtocol: ${net.protocol}` };
    } else {
      if (!bounded(p.command) || !absolute(p.cwd)) return null;
      const additional = p.additionalPermissions == null ? null : permissionProfile(p.additionalPermissions);
      if (p.additionalPermissions != null && !additional) return null;
      scope = { kind: 'exact_command', value: { command: p.command, cwd: path.normalize(p.cwd), additionalPermissions: additional?.value ?? null },
        description: `Exact command (including requested sandbox escalation):\n${p.command}\nWorking directory: ${path.normalize(p.cwd)}${additional ? `\n${additional.description}` : ''}` };
    }
  } else if (input.method === 'item/permissions/requestApproval') {
    if (!keysWithin(p, [...common, 'cwd', 'permissions']) || !absolute(p.cwd)) return null;
    const profile = permissionProfile(p.permissions);
    if (!profile) return null;
    scope = { kind: 'permission_profile', value: { cwd: path.normalize(p.cwd), permissions: profile.value }, description: profile.description };
  } else {
    // File changes without an exact patch and arbitrary MCP elicitations do not
    // carry enough supported authority to promise a reusable permission.
    return null;
  }
  if (scope.description.length > 12000) return null;
  const workspace = path.normalize(input.workspace);
  const identity = { workspace, mayWrite: input.mayWrite, environmentId: p.environmentId ?? null };
  return {
    agentId: input.agentId, taskId: bounded(input.taskId) ? input.taskId : null,
    ...identity,
    scope: { kind: scope.kind, key: digest({ ...identity, kind: scope.kind, value: scope.value }),
      description: scope.description },
  };
}

export const SCOPED_APPROVAL_ACTIONS = ['approve_once', 'approve_task', 'approve_always', 'deny'];
