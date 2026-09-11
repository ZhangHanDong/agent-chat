/* Closed native browser protocol. Credentials exist only in the fragment exchange
 * and HttpOnly cookie; usage facts never enter local/session storage. */
export const NATIVE_MODE = process.env.NEXT_PUBLIC_HAGENCY_NATIVE_CONSOLE === '1';
const ROOT = '/console';
const KINDS = ['input', 'output', 'cacheWrite', 'cacheRead'];
const STATES = ['pending', 'reserved', 'active', 'rejected', 'revoked', 'failed'];
const CLEANUP = ['not_required', 'pending', 'uncertain', 'complete'];
const id = (v) => typeof v === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(v);
const number = (v) => Number.isSafeInteger(v) && v >= 0;
const object = (v, keys) => v !== null && typeof v === 'object' && !Array.isArray(v)
  && Object.keys(v).length === keys.length && keys.every((k) => Object.hasOwn(v, k));
const counts = (v, nullable) => object(v, KINDS) && KINDS.every((k) => number(v[k]) || (nullable && v[k] === null));
const evidence = (v) => v === 'host_attributed_untrusted_usage';
const period = (v) => v === null || (object(v, ['kind', 'key', 'observed_growth', 'known_growth_lower_bound', 'incomplete', 'observations', 'evidence'])
  && ['daily', 'monthly'].includes(v.kind) && typeof v.key === 'string' && v.key.length <= 10
  && counts(v.observed_growth, true) && counts(v.known_growth_lower_bound, false)
  && typeof v.incomplete === 'boolean' && number(v.observations) && evidence(v.evidence));

export function validateReport(v, selected) {
  const s = v?.summary;
  if (!object(v, ['engagement_id', 'at_ms', 'summary', 'daily', 'monthly']) || v.engagement_id !== selected || !number(v.at_ms)
    || !object(s, ['sources', 'latest_counts', 'known_high_water_lower_bound', 'latest_incomplete_sources', 'historically_incomplete_sources', 'regression_observations', 'evidence'])
    || !['sources', 'latest_incomplete_sources', 'historically_incomplete_sources', 'regression_observations'].every((k) => number(s[k]))
    || !(s.latest_counts === null || counts(s.latest_counts, true))
    || !(s.known_high_water_lower_bound === null || counts(s.known_high_water_lower_bound, false))
    || !evidence(s.evidence) || !period(v.daily) || !period(v.monthly)) throw new Error('invalid_native_response');
  return v;
}
export function validateEngagements(v) {
  if (!object(v, ['engagements', 'next_after']) || !Array.isArray(v.engagements) || v.engagements.length > 16
    || !(v.next_after === null || id(v.next_after)) || v.engagements.some((e) => !object(e, ['id', 'agentName', 'projectName', 'role', 'state', 'cleanup'])
      || !id(e.id) || typeof e.agentName !== 'string' || e.agentName.length > 128
      || !(e.projectName === null || (typeof e.projectName === 'string' && e.projectName.length <= 256))
      || typeof e.role !== 'string' || e.role.length > 128 || !STATES.includes(e.state) || !CLEANUP.includes(e.cleanup))) throw new Error('invalid_native_response');
  return v;
}
async function request(path, options = {}) {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 5000);
  try {
    const response = await fetch(`${ROOT}${path}`, { ...options, credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: abort.signal });
    if (!response.headers.get('content-type')?.startsWith('application/json')) throw new Error('invalid_native_response');
    const reader = response.body.getReader();
    const chunks = []; let size = 0;
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.length;
      if (size > 64 * 1024) { await reader.cancel(); throw new Error('invalid_native_response'); }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!response.ok) throw new Error(response.status === 401 ? 'console_access_required' : (response.status === 404 ? 'not_found' : 'native_unavailable'));
    return value;
  } catch (error) {
    if (['console_access_required', 'not_found', 'invalid_native_response', 'invalid_selection'].includes(error.message)) throw error;
    throw new Error('native_unavailable');
  } finally { clearTimeout(timer); }
}
export function selection(location) {
  const query = new URLSearchParams(location.search);
  if ([...query.keys()].some((k) => k !== 'engagement_id') || query.getAll('engagement_id').length > 1) throw new Error('invalid_selection');
  const value = query.get('engagement_id');
  if (value !== null && !id(value)) throw new Error('invalid_selection');
  return value;
}
export async function exchangeAccess(location, history, previousLogout = Promise.resolve()) {
  const fragment = location.hash;
  if (!fragment) return;
  history.replaceState(history.state, '', `${location.pathname}${location.search}`);
  if (!/^#access=[a-f0-9]{64}$/.test(fragment)) throw new Error('console_access_required');
  await previousLogout;
  await request('/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ticket: fragment.slice(8) }) });
}
export async function fetchNative(selected, after = '') {
  if ((selected !== null && !id(selected)) || (after && !id(after))) throw new Error('invalid_selection');
  const list = validateEngagements(await request(`/api/engagements?limit=16${after ? `&after=${after}` : ''}`));
  const chosen = selected ?? list.engagements[0]?.id ?? null;
  const report = chosen === null ? null : validateReport(await request(`/api/engagements/${chosen}/usage`), chosen);
  return { ...list, selected: chosen, report };
}
export async function logoutNative() { await request('/session', { method: 'DELETE' }); }
