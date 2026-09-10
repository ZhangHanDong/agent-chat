'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { agentLog, runtimeStatusText } from '@/lib/mock-data';
import { hasLivePane, isOnDemand, runnerActivityLabel, runnerAvailabilityLabel, transportLabel } from '@/lib/agent-detail';
import { useData } from '@/components/Data';
import { useT } from '@/components/Prefs';

/*
 * Seven tabs, not six. `Configuration` was doing two unrelated jobs and splits into
 * Profile (who this agent is) and Runtime (how it is launched and what shapes it).
 * `Oversight` is READ-ONLY: controls must not sit beside the evidence used to judge
 * them. Both decisions come from the codex content map.
 *
 * ARIA is the full contract, not the `role="tab"` veneer that round 2 called fake:
 * tablist / tab / tabpanel, aria-selected, aria-controls, aria-labelledby, and a
 * roving tabindex driven by Left/Right/Home/End.
 */

// Ids, not labels: the id is the URL hash and must not change with the language,
// while the visible word must. Keeping them in one list keeps the two in step.
/*
 * Four tabs, down from seven. `work`, `messages` and `repos` answered a
 * dispatcher's questions — which task, what queue, which repositories — and this
 * console has no dispatcher. A contributor asks: what does this agent contribute
 * (runtime), is it alive (activity), how is it being judged (oversight), and who
 * is it (profile). Runtime leads because it IS the L1 detail page: the model, the
 * preset, and whether that preset was applied or inherited.
 */
const TABS = ['runtime', 'activity', 'oversight', 'profile'];

export default function AgentTabs({ agent }) {
  const t = useT();
  const [active, setActive] = useState('activity');
  const refs = useRef([]);

  // Selection mirrors the hash so a link and the Back button both work.
  useEffect(() => {
    const fromHash = window.location.hash.replace('#', '');
    if (TABS.includes(fromHash)) setActive(fromHash);
  }, []);

  function select(id, focus = false) {
    setActive(id);
    if (typeof window !== 'undefined') history.replaceState(null, '', `#${id}`);
    if (focus) {
      const i = TABS.indexOf(id);
      refs.current[i]?.focus();
    }
  }

  function onKeyDown(e) {
    const i = TABS.indexOf(active);
    if (e.key === 'ArrowRight') { e.preventDefault(); select(TABS[(i + 1) % TABS.length], true); }
    if (e.key === 'ArrowLeft') { e.preventDefault(); select(TABS[(i - 1 + TABS.length) % TABS.length], true); }
    if (e.key === 'Home') { e.preventDefault(); select(TABS[0], true); }
    if (e.key === 'End') { e.preventDefault(); select(TABS[TABS.length - 1], true); }
  }

  return (
    <>
      <div
        className="tabs"
        role="tablist"
        aria-label={t('ag.sections', { name: agent.name })}
        onKeyDown={onKeyDown}
      >
        {TABS.map((id, i) => (
          <button
            key={id}
            ref={(el) => { refs.current[i] = el; }}
            role="tab"
            id={`tab-${id}`}
            className="tab"
            aria-selected={active === id}
            aria-controls={`panel-${id}`}
            /* Roving tabindex: only the selected tab is in the tab order. */
            tabIndex={active === id ? 0 : -1}
            onClick={() => select(id)}
          >
            {t(`ag.${id}`)}
          </button>
        ))}
      </div>

      <div role="tabpanel" id={`panel-${active}`} aria-labelledby={`tab-${active}`}>
        {active === 'activity' && <Activity agent={agent} />}
        {active === 'profile' && <Profile agent={agent} />}
        {active === 'runtime' && <Runtime agent={agent} />}
        {active === 'oversight' && <Oversight agent={agent} />}
      </div>

    </>
  );
}

/* Activity logs have no live endpoint. Samples must never be joined to a live
 * agent by name, even when that name happens to match an offline fixture. */
export function Activity({ agent }) {
  const t = useT();
  const { provenance } = useData();
  const sample = provenance.agents === 'fixture';
  const src = sample ? agentLog[agent.name] : null;
  return (
    <>
      {sample ? <div className="notice">{t('ag.fixtureActivity')}</div>
        : <PaneSection agent={agent} />}
      {src?.lines?.length ? (
        <div className="log" style={{ marginTop: 12 }}>
          {src.lines.map((line, i) => (
            <div className="log-row" key={i}>
              <span className="t">{line.at}</span>
              <span className={`k ${line.kind}`}>{line.kind}</span>
              <span>{line.text}</span>
            </div>
          ))}
        </div>
      ) : (
        <div className="empty">
          <div className="big">{t('ag.activityUnavailable')}</div>
          <p className="small">{t('ag.activityUnavailableNote')}</p>
        </div>
      )}
    </>
  );
}

export function Profile({ agent }) {
  const t = useT();
  return (
    <>
      <div className="notice">{t('ag.profileReadOnly')}</div>
      <div className="panel" style={{ marginTop: 12 }}>
        <h3>{t('ag.identity')}</h3>
        <dl className="kv">
          <dt>{t('ag.name')}</dt><dd>{agent.name}</dd>
          <dt>{t('ag.environment')}</dt><dd>{agent.environment || t('ag.notProvided')}</dd>
          <dt>{t('ag.createdOn')}</dt><dd className="dim">{agent.createdAt || t('ag.notProvided')}</dd>
        </dl>
      </div>
      <div className="panel">
        <h3>{t('ag.guidance')}</h3>
        <p className="dim">{t('ag.guidanceUnavailable')}</p>
      </div>
      <div className="panel">
        <h3>{t('ag.ownership')}</h3>
        <dl className="kv">
          <dt>{t('ag.owner')}</dt><dd className="dim">{t('ag.notProvided')}</dd>
          <dt>{t('ag.escalation')}</dt><dd className="dim">{t('ag.notProvided')}</dd>
        </dl>
      </div>
    </>
  );
}

function PaneSection({ agent }) {
  const { provenance } = useData();
  const t = useT();
  if (hasLivePane(agent, provenance.agents)) return <LivePane key={`${agent.name}:${agent.tmux}`} agent={agent} />;
  return <div className="notice">{t(isOnDemand(agent) ? 'ag.headlessPaneNote'
    : agent.transport === 'acp' ? 'ag.noPaneAcp' : 'ag.paneNotReported')}</div>;
}

/* Poll only a reported pane from the live roster. Unmounting the active tab stops
 * its timer; a sample roster must not start requests against similarly named agents. */
function LivePane({ agent }) {
  const t = useT();
  const [pane, setPane] = useState({ state: 'loading', text: '', hash: null, reason: null });
  useEffect(() => {
    let stop = false;
    let timer = null;
    const tick = async () => {
      try {
        const res = await fetch(`/api/hagency/agents/${encodeURIComponent(agent.name)}/pane`, {
          headers: { Accept: 'application/json' },
        });
        const body = await res.json().catch(() => null);
        if (stop) return;
        if (res.ok && body?.ok) {
          setPane((prev) => (prev.state === 'live' && prev.hash === body.hash
            ? prev
            : { state: 'live', text: body.text || '', hash: body.hash, reason: null }));
        } else {
          setPane({ state: 'unavailable', text: '', hash: null, reason: body?.error || `HTTP ${res.status}` });
        }
      } catch (e) {
        if (!stop) setPane({ state: 'unavailable', text: '', hash: null, reason: e?.message ?? 'fetch failed' });
      }
      if (!stop) timer = setTimeout(tick, 4000);
    };
    tick();
    return () => { stop = true; if (timer) clearTimeout(timer); };
  }, [agent.name, agent.tmux]);
  return (
    <div className="panel">
      <h3>{t('ag.livePane')}<span className="note">{t('ag.livePaneNote')}</span></h3>
      {pane.state === 'live' ? (
        <pre className="log" style={{ maxHeight: 320, overflow: 'auto', whiteSpace: 'pre' }}>{pane.text || t('ag.livePaneEmpty')}</pre>
      ) : pane.state === 'loading' ? (
        <p className="dim">{t('ag.livePaneLoading')}</p>
      ) : (
        <div className="notice warn">{t('ag.livePaneUnavailable', { why: pane.reason ?? '' })}</div>
      )}
    </div>
  );
}

/* Runtime configuration comes from the resolved profile for this agent. A preset
 * can change after launch, so it cannot override the observed runtime profile. */
export function Runtime({ agent }) {
  const t = useT();
  const { presetOf } = useData();
  const preset = presetOf(agent);
  const onDemand = isOnDemand(agent);
  const model = onDemand ? agent.runner.model : agent.runtimeProfile ? agent.runtimeProfile.model : preset?.model;
  const modelText = model || (onDemand || agent.runtimeProfile ? t('ag.providerDefault') : t('ag.notProvided'));
  return (
    <>
      <PaneSection agent={agent} />
      <div className="panel">
        <h3>{t('ag.effectiveRuntime')}</h3>
        <dl className="kv">
          <dt>{t('col.framework')}</dt><dd>{agent.framework || t('ag.notProvided')}</dd>
          <dt>{t('col.transport')}</dt><dd>{transportLabel(agent, t)}</dd>
          <dt>{t('ag.pane')}</dt><dd>{onDemand ? t('ag.headlessPaneNote')
            : agent.tmux || t(agent.transport === 'acp' ? 'ag.noPaneAcp' : 'ag.paneNotReported')}</dd>
          {onDemand && <>
            <dt>{t('ag.runnerAvailability')}</dt><dd>{runnerAvailabilityLabel(agent.runner, t)}</dd>
            <dt>{t('ag.runnerActivity')}</dt><dd>{runnerActivityLabel(agent.runner, t)}</dd>
          </>}
          {!onDemand && agent.dispatchActivity?.source === 'router-ledger' && <>
            <dt>{t('ag.runnerActivity')}</dt><dd>{runnerActivityLabel(agent.dispatchActivity, t)}</dd>
          </>}
          <dt>{t('ag.declaredModel')}</dt><dd>{modelText}</dd>
          <dt>{t('ag.workspace')}</dt><dd className={agent.workdir ? '' : 'dim'}>{agent.workdir || t('ag.workdirUnknown')}</dd>
        </dl>
      </div>
      <div className="panel">
        <h3>{t('ag.frameworkPreset')}</h3>
        <dl className="kv">
          <dt>{t('ag.applied')}</dt><dd>{preset?.name || t('ag.presetUnreported')}</dd>
          <dt>{t('ag.declaredModel')}</dt><dd>{modelText}</dd>
        </dl>
        <p className="faint" style={{ fontSize: 11.5, marginTop: 8 }}>
          {t('ag.presetNote')} <Link href="/config">{t('nav.config')}</Link>
        </p>
      </div>
      <div className="panel">
        <h3>{t('ag.roles')}</h3>
        <p className="dim">{t('ag.rolesUnavailable')}</p>
      </div>
      <div className="panel">
        <h3>{t('ag.supervisorControl')}</h3>
        <p className="dim">{t('ag.supervisionUnavailable')}</p>
      </div>
    </>
  );
}

/* ── Oversight — read only. No controls. ──────────────────────────────── */
export function Oversight({ agent }) {
  const t = useT();
  const { provenance } = useData();
  if (provenance.agents !== 'fixture') return (
    <div className="empty">
      <div className="big">{t('ag.oversightUnavailable')}</div>
      <p className="small">{t('ag.oversightUnavailableNote')}</p>
    </div>
  );
  return (
    <>
      <div className="notice">{t('ag.fixtureOversight')}</div>

      <div className="panel" style={{ marginTop: 12 }}>
        <h3>{t('ag.assessment')}</h3>
        <dl className="kv">
          <dt>{t('ag.signal')}</dt>
          <dd>
            {agent.activeNow
              ? <span className="badge ok">{t('ag.healthy')}</span>
              : <span className="badge">{t('ag.idleNoConcern')}</span>}
          </dd>
          <dt>{t('col.reason')}</dt>
          <dd className="dim">
            {agent.activeNow
              ? t('ag.reasonActive')
              : t('ag.reasonIdle', { span: runtimeStatusText(agent).replace('IDLE ', '') })}
          </dd>
          <dt>{t('ag.evaluated')}</dt><dd className="dim">{t('common.ago', { n: '42s' })}</dd>
          <dt>{t('ag.recommended')}</dt><dd>{t('ag.noAction')}</dd>
        </dl>
      </div>

      <div className="panel">
        <h3>{t('ag.workEvidence')}</h3>
        <p className="faint" style={{ fontSize: 11.5 }}>
          {/*
            * The link used to point at `/tasks`, a route this console does not have — so the one place that
            * says "the authoritative record is elsewhere" sent the reader to a 404. The sentence is worth
            * more than the link: it stands alone rather than pointing somewhere wrong.
            */}
          {t('ag.evidenceNote')}
        </p>
        <div className="log" style={{ marginTop: 8 }}>
          <div className="dim">{t('ag.captured', { n: '6m' })}</div>
          <div style={{ marginTop: 6 }}>{t('ag.progressLine')}</div>
        </div>
      </div>

      <div className="panel">
        <h3>{t('ag.pathStatus')}</h3>
        <dl className="kv">
          <dt>{t('ag.activePath')}</dt><dd>{t('ag.authoritative')}</dd>
          <dt>{t('ag.stage')}</dt><dd className="dim">{t('ag.stageIdle')}</dd>
          <dt>{t('ag.lastInjection')}</dt><dd className="dim">{t('common.ago', { n: '18m' })}</dd>
        </dl>
      </div>

      <div className="panel">
        <h3>{t('ag.decisions')}</h3>
        <div className="tbl-wrap">
          <table className="tbl">
            <thead><tr><th>{t('col.when')}</th><th>{t('col.decision')}</th><th>{t('col.reason')}</th></tr></thead>
            <tbody>
              {[
                { at: '42s', decision: 'ag.noAction', reason: 'ag.healthy' },
                { at: '15m', decision: 'ag.noAction', reason: 'ag.healthy' },
                { at: '4h', decision: 'ag.recycled', reason: 'ag.promptTimeout' },
              ].map((d, i) => (
                <tr key={i}>
                  <td className="dim">{t('common.ago', { n: d.at })}</td>
                  <td>{t(d.decision)}</td>
                  <td className="dim">{t(d.reason)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="faint" style={{ fontSize: 11.5, marginTop: 8 }}>{t('ag.oneCollection')}</p>
      </div>
    </>
  );
}
