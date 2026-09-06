'use client';

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Toast, useToast } from '@/components/Toast';
import { useT } from '@/components/Prefs';
import { send } from '@/lib/api';
import { useData } from '@/components/Data';

/*
 * Stop and Remove, deliberately exiled.
 *
 * Round 1 put these in the page header beside the refresh controls. Codex objected:
 * rare destructive controls do not belong next to frequent navigation, and a
 * confirmation helps after a slip, not before one. So they sit below everything,
 * behind a divider, with their own label — and Remove requires typing the name,
 * because a confirm dialog is a reflex whereas typing is a decision.
 */
export default function AgentActions({ agent }) {
  const t = useT();
  const [confirming, setConfirming] = useState(null);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [toast, say] = useToast();
  const router = useRouter();
  const { refresh, provenance } = useData();
  const live = provenance?.agents === 'live';
  const submitting = useRef(false);
  const currentRecord = useRef(null);
  currentRecord.current = { live, name: agent.name, typed, confirming };

  /*
   * REAL, as of now. Both of these were `setConfirming(null); say('ok', …)` — a toast and nothing
   * else. Remove announced "removed" and issued no request at all, which is exactly what was
   * reported: "remove agent ui worked but agent is not removed". The typed-name confirmation made it
   * read as the most deliberate control on the page while being the emptiest.
   *
   * `?force=true` is required, and the backend says why in its own response: a plain DELETE answers
   * `{ok: true, deprecated: true, "unregister is disabled; agent marked inactive"}` — 200 with
   * ok:true while the agent stays. A caller that checks only `ok` reports success either way, which
   * is the same trap in a different place.
   */
  async function removeAgent() {
    const current = currentRecord.current;
    if (!current.live || current.name !== agent.name || current.typed !== agent.name
      || current.confirming !== 'remove' || submitting.current) return;
    // The ref closes the same-render double-click window before React updates
    // disabled state. Keep it held while the successful deletion is refreshed.
    submitting.current = true;
    setBusy(true);
    try {
      const res = await send(`agents/${encodeURIComponent(agent.name)}?force=true`, { method: 'DELETE' });
      if (!res.ok) return say('fail', res.error);
      if (res.body?.deleted !== true) {
        // Refused to claim a deletion the backend did not confirm.
        return say('fail', t('ag.removeNotConfirmed', { name: agent.name }));
      }
      setConfirming(null);
      await refresh();
      say('ok', t('ag.removed', { name: agent.name }));
      // The agent's own page is now a 404; leaving the operator on it would be a dead end.
      router.push('/workforce');
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }

  return (
    <>
      <div className="danger-zone">
        <span className="lbl">{t('ag.agentActions')}</span>
        {!live && <span className="dim">{t('ag.actionsLiveOnly')}</span>}
        {confirming === null && (
          <>
            <button className="btn warn" disabled={!live || busy} onClick={() => setConfirming('stop')}>{t('ag.stopAgent')}</button>
            <button className="btn danger" disabled={!live || busy} onClick={() => { setConfirming('remove'); setTyped(''); }}>
              {t('ag.removeAgent')}
            </button>
          </>
        )}
      </div>

      {confirming === 'stop' && (
        <div className="notice warn" style={{ marginTop: 10 }}>
          {t('ag.stopConfirm', { name: agent.name })}
          <div className="btn-row" style={{ marginTop: 10 }}>
            {/*
              * Stop is NOT wired, because there is nothing to wire it to: the only "go offline"
              * route is POST /api/agents/:name/offline, guarded by the AGENT's own token — it is how
              * an agent reports itself down, not how an operator stops one. Killing the tmux session
              * would need an endpoint that does not exist. Left disabled and labelled rather than
              * left saying "stopped" while nothing stops.
              */}
            <button className="btn warn" disabled title={t('ag.stopUnavailable')} onClick={() => setConfirming(null)}>
              {t('ag.stopIt')}
            </button>
            <button className="btn" onClick={() => setConfirming(null)}>{t('act.cancel')}</button>
          </div>
        </div>
      )}

      {confirming === 'remove' && (
        <div className="notice warn" style={{ marginTop: 10, borderColor: 'var(--bad)', color: 'var(--bad)', background: 'var(--bad-soft)' }}>
          {t('ag.removeConfirm', { name: agent.name })}
          <div className="btn-row" style={{ marginTop: 10 }}>
            <input
              value={typed}
              disabled={!live || busy}
              onChange={(e) => setTyped(e.target.value)}
              placeholder={agent.name}
              aria-label={t('ag.typeToConfirm', { name: agent.name })}
              style={{ font: '400 12px var(--sans)', padding: '5px 9px', border: '1px solid var(--bad)', borderRadius: 5 }}
            />
            <button
              className="btn danger"
              disabled={!live || busy || typed !== agent.name}
              onClick={removeAgent}
            >
              {t('ag.removePermanently')}
            </button>
            <button className="btn" disabled={busy} onClick={() => setConfirming(null)}>{t('act.cancel')}</button>
          </div>
        </div>
      )}

      <Toast toast={toast} />
    </>
  );
}
