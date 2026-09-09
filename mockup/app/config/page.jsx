'use client';

import Link from 'next/link';
import PageHead from '@/components/PageHead';
import { Toast, useToast } from '@/components/Toast';
import { Blank } from '@/components/Blank';
import { useT } from '@/components/Prefs';
import { useData, Provenance } from '@/components/Data';
import { send } from '@/lib/api';
import { runtimeLabel, transportLabel } from '@/lib/agent-detail';

/*
 * Config — three sections separated by blast radius, not by data type.
 *
 * The live page mixes agent start/delete with framework presets and credentials in
 * one flat surface, so a preset edit and an irreversible delete look alike. Here
 * each section states its scope, and the destructive one is marked and last.
 */
export default function ConfigPage() {
  const t = useT();
  const { presets, agents, detected, provenance, refresh } = useData();
  const live = provenance.presets === 'live';
  const [toast, say] = useToast();

  return (
    <>
      <PageHead title={t('cf.title')}>
        <span className="badge attention">{t('cf.fleetWide')}</span>
      </PageHead>

      <Provenance slices={['presets', 'agents', 'detected']} />

      <h2 className="sec" style={{ marginTop: 6 }}>
        {t('cf.presets')}
        <span className="note">{t('cf.presetsNote')}</span>
      </h2>
      <div className="tbl-wrap">
        <table className="tbl">
          <thead><tr><th>{t('col.preset')}</th><th>{t('col.framework')}</th><th>{t('col.model')}</th><th /></tr></thead>
          <tbody>
            {presets.map((p) => (
              <tr key={p.id}>
                <td>{p.name}</td>
                <td className="dim">{p.framework}</td>
                <td className="dim">{p.model}</td>
                <td>
                  <button
                    className="btn"
                    disabled={!live}
                    onClick={async () => {
                      if (!live) return;
                      const res = await send(`framework-presets/${p.id}`, { method: 'DELETE' });
                      if (!res.ok) return say('fail', res.error);
                      await refresh();
                      return say('ok', t('cf.presetDeleted', { name: p.name }));
                    }}
                  >
                    {t('act.delete')}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="btn-row" style={{ marginTop: 10 }}>
        <Link className="btn primary" href="/resources/new">
          {t('cf.addPreset')}
        </Link>
      </div>

      <h2 className="sec">
        {t('cf.readiness')}
        <span className="badge" style={{ marginLeft: 8 }}>{t('cf.readOnly')}</span>
        <span className="note">{t('cf.readinessNote')}</span>
      </h2>
      <div className="notice">{t('cf.credNotice')}</div>
      <div className="tbl-wrap" style={{ marginTop: 12 }}>
        <table className="tbl">
          <thead>
            <tr><th>{t('col.agent')}</th><th>{t('col.livesIn')}</th><th>{t('col.provider')}</th><th>{t('col.state')}</th><th>{t('col.ifUnresolved')}</th></tr>
          </thead>
          <tbody>
            {/*
              * DRIVEN BY THE HOST PROBE, not by the agent's framework name.
              *
              * This table used to mark every agent `resolved` unconditionally, read
              * the credential home from a fixture, and infer the provider from a
              * string comparison (`hermes` -> 'deepseek', everything else -> "account
              * default"). So an agent with no credential directory at all appeared
              * provider-resolved, under a banner claiming live data.
              *
              * GET /api/frameworks/detect knows the real answer for the framework, and
              * the agent's own runtimeProfile knows its real provider. Where the probe
              * has nothing to say, the cell says so rather than guessing.
              */}
            {agents.map((a) => {
              const det = detected.find((d) => d.id === a.framework) ?? null;
              const provider = a.runtimeProfile?.provider ?? null;
              return (
                <tr key={a.name}>
                  <td><Link href={`/agents/${a.name}`}>{a.name}</Link></td>
                  <td>
                    {det?.credentialHome
                      ? <code style={{ fontSize: 11.5 }}>{det.credentialHome}</code>
                      : <Blank why="cf.why.noProbe" t={t} />}
                  </td>
                  <td>
                    {provider
                      ? <span className="dim">{provider}</span>
                      : <Blank why="cf.why.noProvider" t={t} />}
                  </td>
                  <td>
                    {!det && <Blank why="cf.why.noProbe" t={t} />}
                    {det && det.state === 'ready' && <span className="badge ok">{t('cf.resolved')}</span>}
                    {det && det.state === 'needs_auth' && <span className="badge warn-b">{t('cf.noCredential')}</span>}
                    {det && det.state === 'absent' && <span className="badge warn-b">{t('cf.notInstalled')}</span>}
                    {det && det.state === 'unusable' && <span className="badge warn-b">{t('cf.unusable')}</span>}
                  </td>
                  <td>
                    {det?.fix
                      ? <code style={{ fontSize: 11.5 }}>{det.fix}</code>
                      : <span className="dim">{t('cf.nothingToFix')}</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="dim" style={{ fontSize: 12, marginTop: 10 }}>
        {t('cf.ownSecrets')}
      </p>
      {/*
        * A SECOND CLASS OF SECRET, with the OPPOSITE rule — ADR-016 decision 8 recorded it as
        * unclassified, and an unclassified secret class is one whose handling nobody can check. The
        * paragraph above is about HAFleet's own secrets: set once in .env, never editable from a browser.
        * A project side's as_token is somebody else's server, arrives after install, and IS entered from
        * a browser — so saying nothing here would leave a reader to assume the first rule covers both.
        */}
      <p className="dim" style={{ fontSize: 12, marginTop: 10 }}>
        {t('cf.sideSecrets')}
      </p>

      <h2 className="sec">
        {t('cf.lifecycle')}
        <span className="badge attention" style={{ marginLeft: 8 }}>{t('cf.destructive')}</span>
        <span className="note">{t('cf.lifecycleNote')}</span>
      </h2>
      <div className="tbl-wrap">
        <table className="tbl">
          <thead><tr><th>{t('col.agent')}</th><th>{t('col.framework')}</th><th>{t('col.transport')}</th><th>{t('col.state')}</th><th /></tr></thead>
          <tbody>
            {agents.map((a) => (
              <tr key={a.name}>
                <td><Link href={`/agents/${a.name}`}>{a.name}</Link></td>
                <td className="dim">{a.framework}</td>
                <td className="dim">{transportLabel(a, t)}</td>
                <td>
                  <span className={`badge${a.activeNow ? ' ok' : ''}`}>
                    {runtimeLabel(a, t)}
                  </span>
                </td>
                <td>
                  <Link className="btn" href={`/agents/${encodeURIComponent(a.name)}`}>{t('cf.manageAgent')}</Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="btn-row" style={{ marginTop: 10 }}>
        <Link className="btn" href="/engagements">{t('rs.reviewRequests')}</Link>
      </div>

      <Toast toast={toast} />
    </>
  );
}
