// Shared form validation and response interpretation. The backend still owns
// authorization, allocation enforcement and capability qualification.
export function verificationState(body) {
  return body?.side?.accessState ?? body?.accessState ?? null;
}

export function projectSideConnectionState(side) {
  if (side?.active === false) return 'inactive';
  if (!side?.hasCredential) return 'missing';
  return ['accepted', 'unverified', 'rejected', 'blocked', 'unreachable'].includes(side.accessState)
    ? side.accessState : 'unknown';
}

export function registrationCallback(appservice, check) {
  if (appservice?.inboundVia === 'edge') return appservice.edgeRegistrationUrl ?? '';
  return check?.recommended ?? '';
}

export function allocationValue(value) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  const tokens = Number(text);
  if (!Number.isSafeInteger(tokens) || tokens < 0) throw new Error('en.invalidAllocation');
  return tokens;
}

export function approvalVerdict({ tokens, ownerMxid = '', ownerDmRoomId = '', projectRoomId, requireOwner = false }) {
  const allocatedTokens = allocationValue(tokens);
  if (!allocatedTokens) throw new Error('en.invalidApprovalAmount');
  const owner = ownerMxid.trim();
  const room = ownerDmRoomId.trim();
  if (!owner && !room) {
    if (requireOwner) throw new Error('en.ownerRequired');
    return { approve: true, allocatedTokens };
  }
  if (!/^@[^:\s]+:[^\s]+$/.test(owner) || !/^![^:\s]+:[^\s]+$/.test(room)) {
    throw new Error('en.invalidOwner');
  }
  if (room === projectRoomId) throw new Error('en.ownerRoomIsProject');
  return { approve: true, allocatedTokens, owner: { ownerMxid: owner, ownerDmRoomId: room } };
}

export function capabilityCount(row) {
  return (row.able?.length ?? 0) + (row.resources?.length ?? 0);
}

export function onboardingHealthStatus(agent) {
  if (agent?.offlineReason?.startsWith('launch-failed:')) {
    return { state: 'failed', reason: agent.offlineReason };
  }
  if (agent?.healthy === true && agent.state === 'online' && agent.serverOnline !== false) {
    return { state: 'ready' };
  }
  return { state: 'waiting' };
}
/** Labels are display-only; joins and mutations continue to use the room ID. */
export function projectLabel(project, sides = [], whitelist = []) {
  const roomId = project.projectRoomId;
  const registered = sides.flatMap(side => side.projects ?? []).find(row => row.roomId === roomId);
  return registered?.name || whitelist.find(row => row.projectRoomId === roomId)?.displayName
    || project.project || roomId;
}
