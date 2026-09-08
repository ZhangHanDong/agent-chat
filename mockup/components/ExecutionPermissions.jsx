'use client';

import { useEffect, useState } from 'react';
import { useT } from '@/components/Prefs';
import { useData } from '@/components/Data';
import { send } from '@/lib/api';

export function ExecutionPolicyChoice({ yolo, onChange, disabled = false, resource = false }) {
  const t = useT();
  return <div>
    <label className="field-row">
      <input type="checkbox" aria-label="YOLO" checked={yolo === true} disabled={disabled}
        onChange={event => onChange(event.target.checked)} />
      <b>{t('exec.yolo')}</b>
    </label>
    <p className="small">{t(yolo ? 'exec.yoloHelp' : 'exec.sandboxHelp')}</p>
    {resource && <p className="dim small">{t('exec.futureAgents')}</p>}
  </div>;
}

export function ResourceExecutionPermissions({ preset, live, refresh }) {
  const t = useT();
  const [yolo, setYolo] = useState(preset.executionPolicy?.yolo === true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  useEffect(() => { setYolo(preset.executionPolicy?.yolo === true); }, [preset.id, preset.executionPolicy?.yolo]);
  if (preset.framework !== 'codex') return null;
  return <div className="panel">
    <h3 className="sub">{t('exec.resourceTitle')}</h3>
    <ExecutionPolicyChoice resource yolo={yolo} onChange={setYolo} disabled={!live || busy} />
    <button className="btn" disabled={!live || busy || yolo === (preset.executionPolicy?.yolo === true)}
      onClick={async () => {
        setBusy(true); setNotice('');
        const result = await send(`framework-presets/${encodeURIComponent(preset.id)}`, { method: 'PUT', body: {
          name: preset.name, framework: preset.framework, provider: preset.provider,
          model: preset.model, reasoning: preset.reasoning, extraArgs: preset.extraArgs,
          apiBaseUrl: preset.apiBaseUrl, executionPolicy: { yolo },
        } });
        if (result.ok) { await refresh(); setNotice(t('exec.saved')); } else setNotice(result.error);
        setBusy(false);
      }}>{t('exec.save')}</button>
    {notice && <p role="status" className="small">{notice}</p>}
  </div>;
}

export default function AgentExecutionPermissions({ agent }) {
  const t = useT();
  const { provenance, refresh } = useData();
  const live = provenance.agents === 'live';
  const [snapshot, setSnapshot] = useState(null);
  const [yolo, setYolo] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [reload, setReload] = useState(0);
  const endpoint = `agents/${encodeURIComponent(agent.name)}/execution-policy`;
  useEffect(() => {
    let current = true;
    setSnapshot(null);
    if (live) send(endpoint, { method: 'GET' }).then(result => {
      if (!current) return;
      if (result.ok) { setSnapshot(result.body); setYolo(result.body.executionPolicy?.yolo === true); }
      else setNotice(result.error);
    });
    return () => { current = false; };
  }, [endpoint, live, reload]);
  if (agent.framework !== 'codex') return null;
  const grants = snapshot?.grants?.filter(grant => grant.active) || [];
  return <section className="panel" aria-label={t('exec.title')}>
    <h3 className="sub">{t('exec.title')}</h3>
    <ExecutionPolicyChoice yolo={yolo} onChange={setYolo} disabled={!snapshot || busy} />
    <p className="small dim">{t('exec.nextRun')}</p>
    <button className="btn" disabled={!snapshot || busy || yolo === snapshot.executionPolicy?.yolo}
      onClick={async () => {
        setBusy(true); setNotice('');
        const result = await send(endpoint, { method: 'PUT', body: { executionPolicy: { yolo } } });
        if (result.ok) { setReload(x => x + 1); await refresh(); setNotice(t('exec.saved')); } else setNotice(result.error);
        setBusy(false);
      }}>{t('exec.save')}</button>
    <h4>{t('exec.rules')}</h4>
    <p className="small dim">{t('exec.revokeHelp')}</p>
    {!snapshot ? <p>{notice || t('exec.loading')}</p> : !grants.length ? <p className="dim">{t('exec.noRules')}</p> :
      grants.map(grant => <article className="panel" key={grant.id}>
        <b>{t(grant.scope === 'task' ? 'exec.task' : 'exec.always')}</b>
        <p className="small">{t('exec.project')}: {grant.project} · {grant.ownerMxid}</p>
        {grant.taskId && <p className="small">{t('exec.task')}: {grant.taskId}</p>}
        <pre className="cmd" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{grant.description}</pre>
        <button className="btn" disabled={busy} onClick={async () => {
          setBusy(true); setNotice('');
          const result = await send(`agents/${encodeURIComponent(agent.name)}/execution-grants/${grant.id}`, { method: 'DELETE' });
          if (result.ok) { setReload(x => x + 1); setNotice(t('exec.revoked')); } else setNotice(result.error);
          setBusy(false);
        }}>{t('exec.revoke')}</button>
      </article>)}
    {notice && snapshot && <p role="status" className="small">{notice}</p>}
    <button className="btn" disabled={busy || !live} onClick={() => setReload(x => x + 1)}>{t('exec.refresh')}</button>
  </section>;
}
