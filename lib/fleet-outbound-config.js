/** Validate a write-only machine credential without including its value in errors. */
export function normalizeOutboundTransport(value, fleetId) {
  const invalid = () => { throw new Error('invalid outbound fleet configuration'); };
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !['mode', 'url', 'token', 'generation'].includes(key))
    || value.mode !== 'outbound' || !/^hf_[a-f0-9]{32}$/.test(fleetId ?? '')
    || typeof value.token !== 'string' || value.token.length < 16 || value.token.length > 4096
    || /\s/.test(value.token) || !Number.isSafeInteger(value.generation) || value.generation < 1) invalid();
  let url;
  try { url = new URL(value.url); } catch { invalid(); }
  if (url.username || url.password || url.search || url.hash
    || url.pathname.replace(/\/$/, '') !== `/api/fleet/v2/${fleetId}`
    || !(url.protocol === 'https:' || url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))) invalid();
  return { mode: 'outbound', url: url.href.replace(/\/$/, ''), token: value.token, generation: value.generation };
}
