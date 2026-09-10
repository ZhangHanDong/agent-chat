'use client';

import { useEffect, useState } from 'react';
import { send } from '@/lib/api';
import { fmtTokens } from '@/lib/mock-data';
import { useT } from './Prefs';

export default function AgentAllocationChoice({ engagement, value, onChange, onReady }) {
  const t = useT();
  const [result, setResult] = useState(null);
  useEffect(() => {
    let cancelled = false;
    onReady(false);
    send(`engagements/${encodeURIComponent(engagement.id)}/candidates`, { method: 'GET' }).then(res => {
      if (cancelled) return;
      setResult(res); onReady(res.ok && (!engagement.requestContext?.agentDefinition || res.body.candidates?.length > 0));
      if (res.ok && res.body.allocation) onChange(res.body.allocation);
    });
    return () => { cancelled = true; };
  }, [engagement.id, onChange, onReady]);
  if (!result) return <p role="status">{t('en.loadingCandidates')}</p>;
  if (!result.ok) return <p role="alert" className="warn-text">{result.error}</p>;
  const candidates = result.body.candidates || [];
  const definition = engagement.requestContext?.agentDefinition;
  const budget = candidates[0]?.budget;
  if (definition) return <div data-testid="project-agent-definition">
    <p><strong>{t('en.projectDefinedAgent')}: {definition.name}</strong> · {engagement.role}</p>
    {candidates.length ? <p>{candidates[0].resource} · {candidates[0].model} / {candidates[0].reasoning || '—'} · {t('en.createOnApprove')}</p>
      : <p role="alert" className="warn-text">{t('en.requestedResourceUnavailable')}</p>}
    {budget && <div data-testid="selected-pool-budget">
      <p>{t('en.poolBudget', { total: fmtTokens(budget.pool.ceiling), committed: fmtTokens(budget.pool.committed), left: fmtTokens(budget.pool.remaining) })}</p>
      <p className="dim">{budget.seat.status === 'declared'
        ? t('en.sharedAccountBudget', { total: fmtTokens(budget.seat.quota), left: fmtTokens(budget.seat.remaining) })
        : t(budget.seat.status === 'period_mismatch' ? 'en.sharedAccountPeriodMismatch' : 'en.sharedAccountUnknown')}</p>
      {budget.reserved > 0 && <p className="dim">{t('en.poolReservation', { n: fmtTokens(budget.reserved) })}</p>}
      <p>{t('en.poolFunding')}</p>
    </div>}
    <p className="dim">{t('en.projectDefinedAgentHelp')}</p>
  </div>;
  const selected = value ? JSON.stringify(value) : '';
  return <div><label htmlFor={`agent-choice-${engagement.id}`}>{t('en.selectAgent')}</label>
    <select id={`agent-choice-${engagement.id}`}  className="inp" value={selected} disabled={result.body.locked} onChange={e => onChange(e.target.value ? JSON.parse(e.target.value) : null)}>
      <option value="">{t('en.automaticAgent')}</option>
      {selected && !candidates.some(c => JSON.stringify(c.choice) === selected) && <option value={selected}>{engagement.agent} · {t('en.reservedAgent')}</option>}
      {candidates.map(c => <option key={JSON.stringify(c.choice)} value={JSON.stringify(c.choice)}>
        {c.name} · {c.resource} · {c.model} / {c.reasoning || '—'} · {t(c.provision ? 'en.createOnApprove' : 'en.existingAgent')}
      </option>)}
    </select>
    <span className="dim">{t('en.selectAgentHelp')}</span>
  </div>;
}
