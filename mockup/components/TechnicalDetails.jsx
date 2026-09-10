'use client';

import { useT } from '@/components/Prefs';

export default function TechnicalDetails({ label, children }) {
  const t = useT();
  return <details className="technical-details">
    <summary>{label || t('ui.technicalDetails')}</summary>
    <div className="technical-details-body">{children}</div>
  </details>;
}

export function UnavailableUsage({ reason }) {
  const t = useT();
  return <div className="unavailable-usage">
    <span className="dim">{t('ui.usageUnavailable')}</span>
    {reason && <TechnicalDetails><p>{reason}</p></TechnicalDetails>}
  </div>;
}
