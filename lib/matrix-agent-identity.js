// Naming authority comes from the accepted side registration. An import must not
// depend on a process-wide prefix that may belong to another project's agents.
export function projectSideAgentPrefix({ side, credential } = {}, legacyPrefix = 'ac_') {
  if (credential?.kind !== 'appservice') return legacyPrefix;
  const fleetId = /^(hf_[a-f0-9]{32})_representative$/.exec(credential.senderLocalpart ?? '')?.[1];
  if (!fleetId) return legacyPrefix;
  const server = side?.serverName;
  if (typeof server !== 'string' || !server) throw new Error('managed_fleet_identity_scope_invalid');
  const escaped = server.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (credential.namespace !== `^@${fleetId}_[a-z0-9_]+:${escaped}$`) {
    throw new Error('managed_fleet_identity_scope_invalid');
  }
  return `${fleetId}_agent_`;
}

export function projectSideAgentMxid(name, acting, legacyPrefix = 'ac_') {
  if (!acting?.side?.serverName) throw new Error('agent_identity_side_missing');
  return `@${projectSideAgentPrefix(acting, legacyPrefix)}${name}:${acting.side.serverName}`.toLowerCase();
}
