import { randomUUID } from 'node:crypto';
import { EngagementError } from './engagement-store.js';

// Definitions share their resource's persistence transaction. They contain no
// runtime credentials and are not agent instances until allocation is approved.
export function createResourceAgentDefinitions({ presets, save, agents, engagements, qualifies }) {
  const all = () => presets.flatMap(preset => (preset.agentDefinitions || []).map(definition => ({ preset, definition })));
  const reserved = name => engagements().some(e => e.agent === name && e.fulfillment
    && e.state === 'pending' && e.fulfillment.phase !== 'failed');
  const inUse = name => Boolean(agents()[name]) || reserved(name);
  const find = id => all().find(row => row.definition.id === id) || null;
  function edit(presetId, id, input) {
    const preset = presets.find(p => p.id === presetId);
    if (!preset) throw new EngagementError('not_found', 'Resource not found');
    const previous = preset.agentDefinitions || [];
    const old = id ? previous.find(d => d.id === id) : null;
    if (id && !old) throw new EngagementError('not_found', 'Agent definition not found');
    let next;
    if (input === null) {
      if (inUse(old.name)) throw new EngagementError('conflict', 'This Agent is already provisioned or reserved; disable future allocation instead');
      next = previous.filter(d => d.id !== id);
    } else {
      const name = String(input.name ?? old?.name ?? '').trim();
      const role = String(input.role ?? old?.role ?? '').trim();
      if (!/^[a-z][a-z0-9_-]{0,63}$/.test(name)) throw new EngagementError('bad_request', 'Agent name must start with a lowercase letter and contain only lowercase letters, numbers, underscores or hyphens (64 characters maximum)');
      if (all().some(row => row.definition.id !== id && row.definition.name === name)
        || agents()[name] && agents()[name].resourceDefinitionId !== id) throw new EngagementError('conflict', 'Agent name is already in use');
      if (old && inUse(old.name) && (name !== old.name || role !== old.role)) throw new EngagementError('conflict', 'A provisioned or reserved Agent cannot be renamed or moved to another role');
      if (!qualifies(preset, role)) throw new EngagementError('bad_request', 'This resource cannot supply the selected role; check its model, framework and ceiling');
      if (!old && previous.length >= 200) throw new EngagementError('bad_request', 'This resource already has 200 Agent definitions');
      if (input.enabled !== undefined && typeof input.enabled !== 'boolean') throw new EngagementError('bad_request', 'enabled must be a boolean');
      const definition = { id: old?.id || `rad_${randomUUID()}`, name, role,
        enabled: input.enabled ?? old?.enabled ?? true, createdAt: old?.createdAt || Date.now() };
      next = old ? previous.map(d => d.id === id ? definition : d) : [...previous, definition];
    }
    preset.agentDefinitions = next;
    if (!save()) { preset.agentDefinitions = previous; throw new EngagementError('persist_failed', 'Agent definition could not be saved'); }
    return next.find(d => d.id === id) || next.at(-1) || null;
  }
  return { all, find, edit, reserved, inUse,
    list(preset) { return (preset.agentDefinitions || []).map(d => ({ ...d,
      status: agents()[d.name]?.resourceDefinitionId === d.id ? 'provisioned' : reserved(d.name) ? 'reserved' : 'defined',
      activeEngagements: engagements().filter(e => e.agent === d.name && e.state === 'active').length,
    })); },
  };
}
