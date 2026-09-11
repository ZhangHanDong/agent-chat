use super::{
    observations::Drive,
    state::{self, ApprovalRun, Sending},
};
use crate::{Failure, operation::Deadline};
use hagency_core::{
    approvals::{ApprovalChoice, HostApprovalContext},
    tasks::RunnerCapability,
};
use hagency_runtime::{codex::session::PreparedUpdate, owned::OwnedSession};
use hagency_store::{ApprovalResponseObservation, DomainStore};
use std::time::Duration;
use tokio::time::Instant;

impl ApprovalRun {
    pub(crate) async fn bind(
        &mut self,
        domain: &DomainStore,
        cap: &RunnerCapability,
        expected: &str,
        context: HostApprovalContext,
        deadline: Deadline,
        runner: &mut OwnedSession,
    ) -> Result<(), Failure> {
        let Deadline { until, expires_at } = deadline;
        self.callbacks.context = Some(context.clone());
        // Retain the sole returned scope before enabling callback control.
        self.scope = Some(
            domain
                .bind_owned_approval_context(
                    cap.clone(),
                    expected.into(),
                    context,
                    until.into_std(),
                    expires_at,
                )
                .await
                .map_err(|_| Failure::LostAuthority)?,
        );
        runner
            .enable_approval_control(self.callbacks.host.policy())
            .map_err(|_| Failure::Admission)
    }

    pub(crate) async fn drive(
        &mut self,
        mut drive: Drive<'_>,
        runner: &mut OwnedSession,
    ) -> Result<(), Failure> {
        let (domain, cap, cancel, until) = (drive.domain, drive.cap, drive.cancel, drive.until);
        loop {
            let scope = self.scope.as_ref().ok_or(Failure::Admission)?;
            let observed = drive
                .pump(
                    &mut self.callbacks,
                    runner,
                    domain.maintain_owned_approval(scope),
                )
                .await;
            let current = observed.output.map_err(|_| Failure::LostAuthority)?;
            *drive.status = Some(current.task.status);
            if observed.terminal? {
                return Ok(());
            }
            // Freeze a typed response only from an actual persisted choice,
            // before the original owner deadline. Encoding grants no authority.
            let keys: Vec<_> = self.callbacks.entries.keys().cloned().collect();
            for key in &keys {
                let entry = self
                    .callbacks
                    .entries
                    .get_mut(key)
                    .ok_or(Failure::Protocol)?;
                if entry.write.is_some() || entry.prepared.is_some() || entry.admitted {
                    continue;
                }
                let Some(summary) = current
                    .approvals
                    .iter()
                    .find(|v| Some(v.id.as_str()) == entry.id.as_deref())
                else {
                    continue;
                };
                let Some(choice) = summary.choice else {
                    continue;
                };
                if Instant::now() >= entry.owner_deadline {
                    return Err(Failure::Deadline);
                }
                let allow = choice != ApprovalChoice::Deny;
                entry.prepared = Some(
                    runner
                        .prepare_approval(entry.request.response(allow))
                        .map_err(|_| Failure::Protocol)?,
                );
                entry.selected = Some(allow);
                let id = entry.id.clone().ok_or(Failure::Protocol)?;
                let authorized = drive
                    .pump(
                        &mut self.callbacks,
                        runner,
                        domain.authorize_approval_response(cap.clone(), id),
                    )
                    .await;
                // Positive consumption is retained even if a cancellation was
                // observed while the original writer receipt was pending.
                let grant = authorized.output.map_err(|_| Failure::LostAuthority)?;
                #[cfg(test)]
                if self.callbacks.fault == Some(super::Fault::ConsumeAck) {
                    drop(grant);
                    return Err(Failure::LostAuthority);
                }
                let entry = self
                    .callbacks
                    .entries
                    .get_mut(key)
                    .ok_or(Failure::Protocol)?;
                entry.grant = Some(grant);
                state::matches(
                    entry.grant.as_ref().ok_or(Failure::Protocol)?,
                    entry,
                    self.callbacks.context.as_ref().ok_or(Failure::Admission)?,
                )?;
                if authorized.terminal? {
                    return Err(Failure::ApprovalCancelled);
                }
            }
            let ready = !self.callbacks.entries.is_empty()
                && self.callbacks.entries.values().all(|e| {
                    e.write.is_some() || e.admitted || (e.prepared.is_some() && e.grant.is_some())
                });
            if ready {
                let deadline = self
                    .callbacks
                    .entries
                    .values()
                    .filter(|e| e.write.is_none())
                    .map(|e| e.response_deadline)
                    .min()
                    .unwrap_or(until)
                    .min(until);
                for (key, entry) in &mut self.callbacks.entries {
                    if entry.write.is_none() && !entry.admitted {
                        self.batch.ids.push(key.clone());
                        self.batch
                            .grants
                            .push(entry.grant.take().ok_or(Failure::Protocol)?);
                    }
                }
                if !self.batch.grants.is_empty() {
                    let begin = domain.begin_approval_responses(
                        cap.clone(),
                        &mut self.batch.grants,
                        deadline.into_std(),
                    );
                    #[cfg(test)]
                    let begin = {
                        let gate = if self.callbacks.fault == Some(super::Fault::BeginGate) {
                            self.callbacks.gate.take()
                        } else {
                            None
                        };
                        async move {
                            let result = begin.await;
                            if result.is_ok()
                                && let Some(gate) = gate
                            {
                                gate.wait().await;
                            }
                            result
                        }
                    };
                    let begun = drive.pump(&mut self.callbacks, runner, begin).await;
                    // Original grants stay in the retained batch on every
                    // failure or unwind; begin is never reconstructed/rearmed.
                    begun.output.map_err(|_| Failure::LostAuthority)?;
                    #[cfg(test)]
                    if self.callbacks.fault == Some(super::Fault::BeginAck) {
                        return Err(Failure::LostAuthority);
                    }
                    for (key, grant) in self.batch.ids.drain(..).zip(self.batch.grants.drain(..)) {
                        let entry = self
                            .callbacks
                            .entries
                            .get_mut(&key)
                            .ok_or(Failure::Protocol)?;
                        entry.admitted = true;
                        entry.grant = Some(grant);
                    }
                    if begun.terminal? {
                        return Err(Failure::ApprovalCancelled);
                    }
                }
            }
            // A new observed callback can repark this same attempt after begin.
            // Handle its decision/batch first, retaining any older unsent frame.
            if self
                .callbacks
                .entries
                .values()
                .any(|e| e.write.is_none() && !e.admitted)
            {
                let wake = drive
                    .pump(
                        &mut self.callbacks,
                        runner,
                        tokio::time::sleep(Duration::from_millis(100)),
                    )
                    .await;
                if wake.terminal? {
                    return Ok(());
                }
                continue;
            }
            if self.sending.is_none()
                && let Some((key, entry)) = self
                    .callbacks
                    .entries
                    .iter_mut()
                    .find(|(_, e)| e.admitted && e.write.is_none())
            {
                self.sending = Some(Sending {
                    id: key.clone(),
                    prepared: entry.prepared.take().ok_or(Failure::Protocol)?,
                    grant: entry.grant.take().ok_or(Failure::Protocol)?,
                });
            }
            if let Some(sending) = &mut self.sending {
                let check = domain.check_approval_response(cap.clone(), &sending.grant);
                #[cfg(test)]
                let check = {
                    let gate = if self.callbacks.fault == Some(super::Fault::RecheckGate) {
                        self.callbacks.gate.take()
                    } else {
                        None
                    };
                    async move {
                        let result = check.await;
                        if result.is_ok()
                            && let Some(gate) = gate
                        {
                            gate.wait().await;
                        }
                        result
                    }
                };
                let checked = drive.pump(&mut self.callbacks, runner, check).await;
                let new_barrier = self
                    .callbacks
                    .entries
                    .values()
                    .any(|e| e.write.is_none() && !e.admitted);
                if new_barrier
                    && matches!(
                        checked.output,
                        Ok(()) | Err(hagency_store::Error::RunnerAuthority)
                    )
                {
                    checked.terminal?;
                    continue;
                }
                checked.output.map_err(|_| Failure::LostAuthority)?;
                if checked.terminal? {
                    return Err(Failure::ApprovalCancelled);
                }
                let step = crate::operation::bounded(
                    runner.send_prepared_approval(&mut sending.prepared),
                    cancel,
                    until,
                )
                .await?
                .map_err(|_| Failure::Protocol)?;
                match step {
                    PreparedUpdate::Update(update, observation) => {
                        if drive
                            .update(&mut self.callbacks, runner, update, *observation)
                            .await?
                        {
                            return Err(Failure::ApprovalCancelled);
                        }
                    }
                    PreparedUpdate::WriteAccepted(write) => {
                        let entry = self
                            .callbacks
                            .entries
                            .get_mut(&sending.id)
                            .ok_or(Failure::Protocol)?;
                        entry.write = Some(write); // actual receipt before any await
                        #[cfg(test)]
                        if self.callbacks.fault == Some(super::Fault::WritePanic) {
                            panic!("actual owned response write unwind");
                        }
                        let written = drive
                            .pump(
                                &mut self.callbacks,
                                runner,
                                domain.observe_approval_response(
                                    &mut sending.grant,
                                    ApprovalResponseObservation::WriteAccepted,
                                ),
                            )
                            .await;
                        written.output.map_err(|_| Failure::SettlementUnknown)?;
                        #[cfg(test)]
                        if self.callbacks.fault == Some(super::Fault::WriteAck) {
                            return Err(Failure::SettlementUnknown);
                        }
                        let sent = self.sending.take().ok_or(Failure::Protocol)?;
                        let entry = self
                            .callbacks
                            .entries
                            .get_mut(&sent.id)
                            .ok_or(Failure::Protocol)?;
                        entry.prepared = Some(sent.prepared);
                        entry.grant = Some(sent.grant);
                        entry.recorded = true;
                        self.callbacks.release_written();
                        if written.terminal? {
                            return Ok(());
                        }
                    }
                }
            } else {
                let wake = drive
                    .pump(
                        &mut self.callbacks,
                        runner,
                        tokio::time::sleep(Duration::from_millis(100)),
                    )
                    .await;
                if wake.terminal? {
                    return Ok(());
                }
            }
        }
    }
}
