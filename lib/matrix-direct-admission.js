/** An invitation selects an existing allocation; it never allocates resources. */
export async function resolveDirectAdmission({ agent, humanMxid, roomId, existing = null,
  engagements, bindings, eligible, membersForProject }) {
  if (!agent || !eligible || !/^@[^:\s]+:\S+$/.test(humanMxid || '') || !/^![^:]+:.+/.test(roomId || '')) {
    throw new Error('direct_chat_not_authorized');
  }
  if (existing && (existing.agent !== agent.name || existing.mode !== 'group' && existing.humanMxid !== humanMxid)) throw new Error('direct_room_identity_mismatch');
  const projects = new Map();
  for (const engagement of engagements) {
    if (engagement.agent !== agent.name || engagement.state !== 'active' || engagement.endedAt
      || !engagement.projectRoomId || engagement.projectRoomId === roomId
      || (existing && engagement.id !== existing.engagementId)) continue;
    const owner = bindings.find(binding => binding.agent === agent.name && binding.active !== false
      && binding.projectRoomId === engagement.projectRoomId && binding.ownerMxid && binding.ownerDmRoomId);
    if (!owner || owner.ownerDmRoomId === roomId) continue;
    if (roomId.slice(roomId.indexOf(':') + 1) !== engagement.projectRoomId.slice(engagement.projectRoomId.indexOf(':') + 1)) continue;
    const membership = await membersForProject(engagement.projectRoomId);
    if (!membership.known) throw new Error('project_membership_unavailable');
    if (membership.members.includes(humanMxid)) projects.set(engagement.id, engagement);
  }
  if (projects.size !== 1) throw new Error(projects.size ? 'direct_chat_project_ambiguous' : 'direct_chat_not_authorized');
  const engagement = [...projects.values()][0];
  return { roomId, agent: agent.name, humanMxid: existing?.humanMxid || humanMxid, projectRoomId: engagement.projectRoomId, engagementId: engagement.id };
}
