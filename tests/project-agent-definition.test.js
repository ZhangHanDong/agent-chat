import { expect, test } from 'vitest';
import { createHash } from 'node:crypto';
import { normalizeProjectAgentDefinition, projectAgentRuntimeName } from '../lib/project-agent-definition.js';

const resourceId = `resource_${'a'.repeat(24)}`;
const context = { fleetId: 'fleet-one', targetProjectId: 'project-one', requestId: 'request-one' };

test('Unicode project names keep display text and safe distinct runtime identities', () => {
  for (const name of ['小白', '孙悟空-01', 'Edison', 'Édison', '小'.repeat(64)]) {
    const definition = normalizeProjectAgentDefinition({ name: name.normalize('NFD'), resourceId });
    expect(definition).toEqual({ name, resourceId });
    const request = { ...context, agentDefinition: definition };
    const runtime = projectAgentRuntimeName(request);
    expect(runtime).toMatch(/^pa_[a-z0-9_]{1,32}_[a-f0-9]{16}$/);
    expect(projectAgentRuntimeName(request)).toBe(runtime);
    expect(projectAgentRuntimeName({ ...request, requestId: 'request-two' })).not.toBe(runtime);
    expect(projectAgentRuntimeName({ ...request, targetProjectId: 'project-two' })).not.toBe(runtime);
  }
  for (const name of ['', '../小白', '小白/二', '小白\n命令', '小\u202E白', '小\u200B白', '小'.repeat(65)]) {
    expect(() => normalizeProjectAgentDefinition({ name, resourceId })).toThrow();
  }
  const suffix = createHash('sha256').update(JSON.stringify(Object.values(context))).digest('hex').slice(0, 16);
  for (const name of ['edison', 'fast--one', 'a'.repeat(64)]) {
    expect(projectAgentRuntimeName({ ...context, agentDefinition: { name, resourceId } }))
      .toBe(`pa_${name.slice(0, 32).replace(/-/g, '_')}_${suffix}`);
  }
});
