import { createHash } from 'node:crypto';

// Public catalog IDs are stable references, not internal preset IDs or authority.
export const publicResourceId = preset => `resource_${createHash('sha256').update(preset.id).digest('hex').slice(0, 24)}`;

export function normalizeProjectAgentDefinition(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || typeof value.name !== 'string' || !/^[a-z][a-z0-9_-]{0,63}$/.test(value.name)
    || typeof value.resourceId !== 'string' || !/^resource_[a-f0-9]{24}$/.test(value.resourceId)
    || Object.keys(value).some(key => !['name', 'resourceId'].includes(key))) {
    throw Object.assign(new Error('Agent definition requires a lowercase name (64 characters maximum) and a published resource ID.'),
      { code: 'invalid_agent_definition', status: 400 });
  }
  return { name: value.name, resourceId: value.resourceId };
}

export function projectAgentRuntimeName(context) {
  const suffix = createHash('sha256').update(JSON.stringify([context.fleetId, context.targetProjectId, context.requestId])).digest('hex').slice(0, 16);
  return `pa_${context.agentDefinition.name.slice(0, 32).replace(/-/g, '_')}_${suffix}`;
}
