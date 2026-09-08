import { expect, test, vi } from 'vitest';
import { reconcileAgentDisplayName } from '../lib/matrix-agent-profile.js';

test('repairs generated Matrix names and preserves custom profiles with verified readback', async () => {
  const mxid = '@hf_agent_pa_edison_hash:project.test';
  let profile = mxid.slice(1, mxid.indexOf(':'));
  let persist = true;
  const fetchImpl = vi.fn(async (url, options) => {
    expect(url.searchParams.get('user_id')).toBe(mxid);
    expect(decodeURIComponent(url.pathname)).toContain(`/profile/${mxid}/displayname`);
    expect(options.headers.Authorization).toBe('Bearer fixture-token');
    if (options.method === 'PUT' && persist) profile = JSON.parse(options.body).displayname;
    return { ok: true, json: async () => ({ displayname: profile }) };
  });
  const args = { mxid, asUserId: mxid, token: 'fixture-token', baseUrl: 'https://project.invalid',
    agentName: 'pa_edison_hash', displayName: 'edison', fetchImpl };
  expect(await reconcileAgentDisplayName(args)).toMatchObject({ changed: true, displayName: 'edison' });
  expect(fetchImpl).toHaveBeenCalledTimes(3);
  expect(await reconcileAgentDisplayName(args)).toMatchObject({ changed: false });
  profile = 'Edison 我的助手';
  expect(await reconcileAgentDisplayName(args)).toMatchObject({ changed: false, custom: true });
  profile = 'pa_edison_hash'; persist = false;
  await expect(reconcileAgentDisplayName(args)).rejects.toThrow('readback mismatch');
  persist = true;
  expect(await reconcileAgentDisplayName(args)).toMatchObject({ changed: true });
  await expect(reconcileAgentDisplayName({ ...args, fetchImpl: async () => ({ ok: false, status: 503 }) })).rejects.toThrow('HTTP 503');
});
