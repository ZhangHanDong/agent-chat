// Parse locally. No token is sent anywhere until the operator explicitly saves.
export function parseFleetCredentialImport(text, side) {
  const invalid = () => { throw new Error('cr.importInvalid'); };
  if (typeof text !== 'string' || text.length > 65536) invalid();
  let envelope;
  try { envelope = JSON.parse(text); } catch { invalid(); }
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) invalid();
  const registration = envelope.registration ?? envelope;
  const serverName = side?.serverName ?? side?.id;
  if (typeof serverName !== 'string' || !serverName) invalid();
  if (envelope.serverName && envelope.serverName !== serverName) throw new Error('cr.importWrongServer');
  if (envelope.credentialVersion !== undefined && envelope.credentialVersion !== 1
    || envelope.v !== undefined && envelope.v !== 1) invalid();
  const fleetId = registration.id;
  if (typeof fleetId !== 'string' || !/^hf_[a-f0-9]{32}$/.test(fleetId)
    || envelope.fleetId && envelope.fleetId !== fleetId
    || registration.sender_localpart !== `${fleetId}_representative`) invalid();
  const escapedServer = serverName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const namespace = `^@${fleetId}_[a-z0-9_]+:${escapedServer}$`;
  const users = registration.namespaces?.users;
  if (!Array.isArray(users) || users.length !== 1 || users[0].exclusive !== true || users[0].regex !== namespace
    || !Array.isArray(registration.namespaces?.rooms) || registration.namespaces.rooms.length
    || !Array.isArray(registration.namespaces?.aliases) || registration.namespaces.aliases.length) invalid();
  for (const key of ['as_token', 'hs_token']) {
    if (typeof registration[key] !== 'string' || !registration[key].trim() || registration[key].length > 4096) invalid();
  }
  if (registration.as_token === registration.hs_token) invalid();
  let transport;
  if (envelope.transport !== undefined) {
    const value = envelope.transport;
    if (!value || typeof value !== 'object' || Array.isArray(value) || value.mode !== 'outbound'
      || Object.keys(value).some(key => !['mode', 'url', 'token', 'generation'].includes(key))
      || !Number.isSafeInteger(value.generation) || value.generation < 1
      || typeof value.token !== 'string' || value.token.length < 16 || value.token.length > 4096
      || /\s/.test(value.token) || [registration.as_token, registration.hs_token].includes(value.token)) invalid();
    try {
      const url = new URL(value.url);
      if (url.username || url.password || url.search || url.hash
        || url.pathname.replace(/\/$/, '') !== `/api/fleet/v2/${fleetId}`
        || !(url.protocol === 'https:' || url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))) invalid();
      transport = { mode: 'outbound', url: url.href.replace(/\/$/, ''), token: value.token, generation: value.generation };
    } catch { invalid(); }
  }
  try {
    const url = new URL(registration.url);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) invalid();
  } catch { invalid(); }
  return { fleetId, serverName, agentPrefix: `${fleetId}_agent_`, credential: {
    kind: 'appservice', asToken: registration.as_token, hsToken: registration.hs_token,
    namespace, senderLocalpart: registration.sender_localpart, url: registration.url,
    ...(transport ? { transport } : {}),
  } };
}

// This allowlist is also the completion view. Credentials never become UI summary data.
export function fleetImportSummary(imported) {
  return {
    imported: true,
    fleetId: imported.fleetId,
    serverName: imported.serverName,
    representative: `@${imported.credential.senderLocalpart}:${imported.serverName}`,
    namespace: imported.credential.namespace,
    url: imported.credential.url,
    ...(imported.credential.transport ? { connectionMode: 'outbound', endpoint: imported.credential.transport.url } : {}),
  };
}

export async function connectFleetCredentialImport(text, side, { send, onSaved }) {
  // Revalidate against the current selection at save time, not just file selection.
  const imported = parseFleetCredentialImport(text, side);
  const path = `project-sides/${encodeURIComponent(side.id ?? side.serverName)}`;
  const saved = await send(`${path}/credential`, {
    method: 'PUT', body: { credential: imported.credential },
  });
  if (!saved.ok) return { saved: false, error: saved.error || '凭据保存失败，请重试。' };
  const summary = fleetImportSummary(imported);
  // Forget file contents before the network verification, including when it fails.
  onSaved?.(summary);
  const verification = await send(`${path}/verify`, { method: 'POST' });
  return { saved: true, summary, verification };
}
