import { createHash } from 'node:crypto';

// Public catalog IDs are stable references, not internal preset IDs or authority.
export const publicResourceId = preset => `resource_${createHash('sha256').update(preset.id).digest('hex').slice(0, 24)}`;

export function normalizeProjectAgentDefinition(value) {
  const name = typeof value?.name === 'string' ? value.name.normalize('NFC') : '';
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || name.length > 64 || !/^\p{L}[\p{L}\p{M}\p{N}_-]*$/u.test(name)
    || typeof value.resourceId !== 'string' || !/^resource_[a-f0-9]{24}$/.test(value.resourceId)
    || Object.keys(value).some(key => !['name', 'resourceId'].includes(key))) {
    throw Object.assign(new Error('Agent definition requires a name starting with a letter, using letters (including Chinese), numbers, underscores or hyphens (64 characters maximum), and a published resource ID.'),
      { code: 'invalid_agent_definition', status: 400 });
  }
  return { name, resourceId: value.resourceId };
}

export function projectAgentRuntimeName(context) {
  const suffix = createHash('sha256').update(JSON.stringify([context.fleetId, context.targetProjectId, context.requestId])).digest('hex').slice(0, 16);
  const name = context.agentDefinition.name;
  // Keep existing identities stable. Display names never become paths or Matrix
  // localparts; new Unicode names use an ASCII stem and the scoped request hash.
  const stem = /^[a-z][a-z0-9_-]{0,63}$/.test(name) ? name.slice(0, 32).replace(/-/g, '_')
    : name.normalize('NFKD').toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 32) || 'agent';
  return `pa_${stem}_${suffix}`;
}
