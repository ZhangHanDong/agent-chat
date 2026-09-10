'use client';

import { useT } from '@/components/Prefs';
import TechnicalDetails from '@/components/TechnicalDetails';

// Keep failures visible per slice; healthy pages need only a compact summary.
export default function DataStatus({ slices, provenance = {}, errors = {}, loading = false }) {
  const t = useT();
  const labels = {
    live: list => t('prov.live', { list }),
    contract: list => t('prov.contract', { list }),
    fixture: list => t('prov.fixture', { list }),
    derived: list => t('prov.derived', { list }),
    absent: list => t('prov.absent', { list }),
  };
  const rows = slices.map(slice => {
    const source = provenance[slice] ?? 'fixture';
    return { slice, from: Object.hasOwn(labels, source) ? source : 'absent', err: errors[slice] };
  });
  const groups = [
    ['contract', 'contract', 'prov-contract'],
    ['fixture', 'fixture', 'prov-stale'],
    ['derived', 'derived', 'prov-derived'],
    ['absent', 'absent', 'prov-absent'],
  ];
  const names = entries => entries.map(row => t(`prov.slice.${row.slice}`)).join(' · ');
  return <div className={`prov${loading ? ' loading' : ''}`} data-testid="provenance">
    {rows.some(row => row.from === 'live') &&
      <span className="prov-live" data-testid="prov-live">{t('ui.liveData')}</span>}
    {groups.map(([from, key, testId]) => {
      const entries = rows.filter(row => row.from === from);
      return entries.length > 0 && <span key={from} className={testId} data-testid={testId}>
        {labels[key](names(entries))}
      </span>;
    })}
    <TechnicalDetails label={t('ui.dataDetails')}>
      <ul>{rows.map(row => <li key={row.slice}>
        {labels[row.from](names([row]))}
        {row.err && <p className="diagnostic-text">{row.err}</p>}
      </li>)}</ul>
    </TechnicalDetails>
  </div>;
}
