'use client';

import PageHead from '@/components/PageHead';
import { fmtTokens } from '@/lib/mock-data';
import { runtimeLabel, transportLabel } from '@/lib/agent-detail';
import { useData } from '@/components/Data';
import { Blank } from '@/components/Blank';
import { useT } from '@/components/Prefs';

/*
 * Split out of the route so app/agents/[name]/page.jsx can stay a server component
 * and keep generateStaticParams — the header is the only part of it that needs the
 * locale.
 *
 * Pane polling belongs to the pane component. The former header controls only
 * changed a local badge/toast and never reached that component's timer.
 */
export default function AgentHeader({ agent }) {
  const {
    presetOf, tierOf, familyOf, remaining, committed, engagements, roleCapacity,
  } = useData();
  const t = useT();

  // What this agent CONTRIBUTES, on the record where the contributor looks. The
  // previous console showed which bench an agent belonged to and which projects
  // it was a member of — a dispatcher's framing. A lender asks three things: what
  // model am I giving away, how much of my ceiling is already promised, and who
  // is currently drawing on it.
  const preset = presetOf(agent);
  const tier = tierOf(preset);
  const serving = engagements.filter((e) => e.agent === agent.name && e.state === 'active');

  return (
    <>
      <PageHead title={agent.name} />

      <div className="btn-row" style={{ margin: '-8px 0 4px' }}>
        <span className={`badge${agent.activeNow || agent.runner?.activity === 'running' || agent.dispatchActivity?.activity === 'running' ? ' ok' : ''}`}>{runtimeLabel(agent, t)}</span>
        <span className="badge">{transportLabel(agent, t)}</span>
        <span className="badge">{agent.framework ?? t('ag.notProvided')}</span>
        {agent.mcp && <span className="badge ok">{t('ag.mcpConnected')}</span>}
      </div>

      <div className="affil">
        <div className="af-row">
          <span className="af-line">{t('ag.contributes')}</span>
          {preset ? (
            <>
              <span className="mono-s">{preset.model}</span>
              <span className={`tierchip ${tier}`}>{tier}</span>
              <span className="dim">{familyOf(preset)}</span>
              {preset.reasoning && <span className="badge">{`${t('col.reasoning')} ${preset.reasoning}`}</span>}
            </>
          ) : (
            <Blank why="ag.presetUnreported" t={t} />
          )}
        </div>
        <div className="af-row">
          <span className="af-line">{t('ag.ceiling')}</span>
          {preset ? (
            <>
              <span className="amount">{fmtTokens(preset.ceiling?.tokens)}</span>
              <span className="dim">
                {t('ag.committedLeft', {
                  used: fmtTokens(committed(agent.name)),
                  left: fmtTokens(remaining(agent.name)),
                })}
              </span>
              {!preset.ceiling?.enforced && <span className="badge warn-b">{t('rs.notEnforced')}</span>}
            </>
          ) : <Blank why="ag.ceilingUnreported" t={t} />}
        </div>
        <div className="af-row">
          <span className="af-line">{t('ag.serving')}</span>
          {serving.length ? serving.map((e) => (
            <span className="chip-role" key={e.id}>
              {`${e.project} · ${roleCapacity.roles[e.role]?.displayName ?? e.role}`}
            </span>
          )) : <Blank why="ag.why.notServing" t={t} />}
        </div>
      </div>
    </>
  );
}
