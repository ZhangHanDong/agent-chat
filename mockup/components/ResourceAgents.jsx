'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useT } from './Prefs';
import { send } from '@/lib/api';

export default function ResourceAgents({ preset, live, refresh }) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  return <div data-testid={`resource-agents-${preset.id}`}>
    <p className="dim">{t('rs.definitionHelp')}</p>
    <p><button className="btn" disabled={!live || busy} onClick={async () => {
      setBusy(true); setError(null);
      const result = await send(`framework-presets/${encodeURIComponent(preset.id)}/catalog`, { method: 'PUT', body: { published: !preset.catalogPublished } });
      setBusy(false); if (!result.ok) setError(result.error); else await refresh();
    }}>{t(preset.catalogPublished ? 'rs.unpublishCatalog' : 'rs.publishCatalog')}</button></p>
    <p className="dim">{t('rs.catalogHelp')} <Link href="/capability">{t('rs.publishRoles')}</Link></p>
    {error && <p role="alert" className="warn-text">{error}</p>}
  </div>;
}
