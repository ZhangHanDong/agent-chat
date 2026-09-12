//! Ceiling overrun alarms (ADR-124, slice a): one row per resource dedupe
//! key, raised and resolved from the same drawn figure admission enforces on.
//!
//! An alert is DIAGNOSTIC, never enforcement: raising one must not revoke or
//! end engagements, block or permit admission, release leases, or authorize
//! retries; auto-resolve flips the row's display state and nothing else.

use super::{DomainRepository, Error, usage::ceiling_report};
use hagency_core::JSON_SAFE_MAX;
use hagency_core::project::Resource;
use rusqlite::{OptionalExtension, TransactionBehavior, params};
use serde::Serialize;

/// Retained bound (`lib/alert-store.js:25`): resolved alerts live 7 days.
const RESOLVED_RETENTION_MS: u64 = 7 * 24 * 60 * 60 * 1000;
/// Retained bound (`lib/alert-store.js:28`, `MAX_PAYLOAD_SIZE`): the detail
/// JSON string is capped at 4096 bytes.
const MAX_DETAIL_BYTES: usize = 4096;

/// Counters one sweep produced. `raised` counts newly-open alerts (fresh
/// insert or reopen after resolution); `updated` counts repeats against an
/// already-open row; `resolved` and `pruned` count display-state and
/// retention transitions.
#[derive(Debug, Default, Serialize, PartialEq, Eq)]
pub struct SweepOutcome {
    pub raised: u64,
    pub updated: u64,
    pub resolved: u64,
    pub pruned: u64,
}

fn dedupe_key(resource_id: &str) -> String {
    format!("agent_ceiling_overrun:{resource_id}")
}

fn bounded(value: u64) -> Result<u64, Error> {
    if value > JSON_SAFE_MAX {
        return Err(Error::Capacity);
    }
    Ok(value)
}

/// The retained ingest payload (`backend-v2.js:9422-9447`) with raw numbers:
/// `detail` is a JSON string, never an object, capped at 4096 bytes.
fn detail_json(
    resource_id: &str,
    preset_name: &str,
    ceiling: u64,
    committed: u64,
    measured: Option<u64>,
    drawn: u64,
    over: u64,
) -> Result<String, Error> {
    let detail = serde_json::json!({
        "agent": resource_id,
        "presetId": preset_name,
        "ceilingTokens": ceiling,
        "committedTokens": committed,
        "measuredTokens": measured,
        "drawnTokens": drawn,
        "overByTokens": over,
    });
    let text = serde_json::to_string(&detail)?;
    if text.len() > MAX_DETAIL_BYTES {
        return Err(Error::Capacity);
    }
    Ok(text)
}

impl DomainRepository {
    /// Sweep every resource with a declared finite ceiling and reconcile its
    /// overrun alert (`backend-v2.js:9393-9452`, slice a of the alarm plan):
    /// strictly `drawn > ceiling` raises, `drawn <= ceiling` auto-resolves,
    /// repeats increment `occurrences`, a re-over after resolution reopens
    /// the same row, and resolved rows older than 7 days are pruned. One
    /// `Immediate` transaction; the draw comes from `ceiling_report` — the
    /// identical read the admission decision uses, never a second arithmetic
    /// path, so the alarm and admission cannot disagree about whether a
    /// resource is over.
    pub fn sweep_ceiling_overruns(&mut self, now: u64) -> Result<SweepOutcome, Error> {
        let tx = self
            .db
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mut outcome = SweepOutcome::default();
        let mut statement = tx.prepare("SELECT config FROM resources")?;
        let rows = statement
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        drop(statement);
        for row in rows {
            let resource: Resource = serde_json::from_str(&row)?;
            // No declared ceiling is unknown, not zero: such a resource cannot
            // be past a limit that does not exist and is skipped entirely
            // (`backend-v2.js:9397-9400`).
            let Some(ceiling) = resource
                .ceiling
                .as_ref()
                .and_then(|c| c.tokens)
                .map(u64::from)
            else {
                continue;
            };
            let ceiling = bounded(ceiling)?;
            let report = ceiling_report(&tx, &resource.id(), now)?;
            let key = dedupe_key(&resource.id());
            if report.drawn > ceiling {
                let over = report.drawn - ceiling;
                let detail = detail_json(
                    &resource.id(),
                    &report.preset_name,
                    ceiling,
                    report.reserved,
                    report.spent,
                    report.drawn,
                    over,
                )?;
                let summary = format!(
                    "{} has drawn {} against a ceiling of {} — {} past it",
                    resource.id(),
                    report.drawn,
                    ceiling,
                    over
                );
                let runbook = format!(
                    "raise the ceiling on preset {} to cover what is already committed, or revoke engagements on {} until the drawn figure is back under it",
                    report.preset_name,
                    resource.id()
                );
                let existing: Option<bool> = tx
                    .query_row(
                        "SELECT resolved_at_ms IS NOT NULL FROM ceiling_alerts WHERE dedupe_key=?1",
                        [&key],
                        |r| r.get(0),
                    )
                    .optional()?;
                // The preserved contract is one OPEN alert per resource,
                // occurrences riding on it. On dedupe-repeat and reopen the
                // retained store refreshes summary/lastPayload and the
                // counter but never rewrites runbook/impact/recoveryCondition
                // (`lib/alert-store.js:231-249,254-271`); only a fresh insert
                // writes the four text fields.
                match existing {
                    None => {
                        const IMPACT: &str = "no new engagement can be approved against this agent; the work already approved keeps running, because admission control cannot retract a commitment it already granted";
                        const RECOVERY: &str = "the drawn figure falls back under the ceiling, by raising the ceiling or ending engagements — this alert auto-resolves when that happens";
                        tx.execute(
                            "INSERT INTO ceiling_alerts(dedupe_key,resource_id,summary,detail,runbook,impact,recovery_condition,occurrences,first_seen_ms,last_seen_ms) VALUES(?1,?2,?3,?4,?5,?6,?7,1,?8,?8)",
                            params![key, resource.id(), summary, detail, runbook, IMPACT, RECOVERY, now],
                        )?;
                        outcome.raised += 1;
                    }
                    Some(was_resolved) => {
                        let changed = tx.execute(
                            if was_resolved {
                                "UPDATE ceiling_alerts SET resource_id=?2,summary=?3,detail=?4,runbook=?5,occurrences=occurrences+1,last_seen_ms=?6,resolved_at_ms=NULL,resolved_by=NULL WHERE dedupe_key=?1"
                            } else {
                                "UPDATE ceiling_alerts SET resource_id=?2,summary=?3,detail=?4,runbook=?5,occurrences=occurrences+1,last_seen_ms=?6 WHERE dedupe_key=?1"
                            },
                            params![key, resource.id(), summary, detail, runbook, now],
                        )?;
                        if was_resolved {
                            outcome.raised += 1;
                        } else {
                            outcome.updated += 1;
                        }
                        debug_assert_eq!(changed, 1);
                    }
                }
            } else {
                // Back under (or exactly on) the ceiling resolves by the same
                // rule the ingest path would use, not a hand-rolled
                // transition; a no-op when no alert is open
                // (`lib/alert-store.js:337-355`). Exactly-on is not over,
                // which is also why the raise side is strictly greater.
                let changed = tx.execute(
                    "UPDATE ceiling_alerts SET resolved_at_ms=?2,resolved_by='system' WHERE dedupe_key=?1 AND resolved_at_ms IS NULL",
                    params![key, now],
                )?;
                outcome.resolved += u64::try_from(changed).unwrap_or_default();
            }
        }
        // Retention (`ALERT_RESOLVED_TTL_MS` parity): resolved rows older
        // than 7 days are pruned whole.
        let cutoff = now.saturating_sub(RESOLVED_RETENTION_MS);
        let pruned = tx.execute(
            "DELETE FROM ceiling_alerts WHERE resolved_at_ms IS NOT NULL AND resolved_at_ms<?1",
            params![cutoff],
        )?;
        outcome.pruned = u64::try_from(pruned).unwrap_or_default();
        tx.commit()?;
        Ok(outcome)
    }
}
