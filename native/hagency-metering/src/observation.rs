//! Bounded untrusted evidence for a host-owned ledger. No source/Agent authority.
use crate::{
    Diagnostics, Framework, MAX_SNAPSHOT_BYTES, MeteringError, TokenCounts, parse_session,
};
use serde::Serialize;
use sha2::{Digest, Sha256};

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ParseFailure {
    Capacity,
    DuplicateKey,
    InvalidCounter,
    InvalidRecord,
    ConflictingIdentity,
    Overflow,
}
impl From<MeteringError> for ParseFailure {
    fn from(error: MeteringError) -> Self {
        match error {
            MeteringError::Capacity => Self::Capacity,
            MeteringError::DuplicateKey => Self::DuplicateKey,
            MeteringError::InvalidCounter => Self::InvalidCounter,
            MeteringError::InvalidRecord => Self::InvalidRecord,
            MeteringError::ConflictingIdentity => Self::ConflictingIdentity,
            MeteringError::Overflow => Self::Overflow,
        }
    }
}

/// Constructed only from a bounded snapshot through the retained parser. Its
/// digest is content identity, NOT provider authenticity or execution attribution.
/// No Deserialize, raw source text, workspace/model hints or source setters.
#[derive(Clone, Serialize)]
pub struct UsageObservation {
    framework: Framework,
    snapshot_digest: String,
    totals: Option<TokenCounts>,
    diagnostics: Option<Diagnostics>,
    failure: Option<ParseFailure>,
}
impl UsageObservation {
    pub fn parse(framework: Framework, snapshot: &str) -> Result<Self, MeteringError> {
        if snapshot.len() > MAX_SNAPSHOT_BYTES {
            return Err(MeteringError::Capacity);
        }
        let snapshot_digest = format!("{:x}", Sha256::digest(snapshot.as_bytes()));
        let (totals, diagnostics, failure) = match parse_session(framework, snapshot) {
            Ok(report) => (report.totals, Some(report.diagnostics), None),
            Err(error) => (None, None, Some(error.into())),
        };
        Ok(Self {
            framework,
            snapshot_digest,
            totals,
            diagnostics,
            failure,
        })
    }
    pub fn framework(&self) -> Framework {
        self.framework
    }
    pub fn counts(&self) -> Option<TokenCounts> {
        self.totals
    }
    pub fn diagnostics(&self) -> Option<&Diagnostics> {
        self.diagnostics.as_ref()
    }
    pub fn failure(&self) -> Option<ParseFailure> {
        self.failure
    }
    pub fn incomplete(&self) -> bool {
        let complete_counts = self.totals.is_some_and(|counts| {
            [
                counts.input,
                counts.output,
                counts.cache_write,
                counts.cache_read,
            ]
            .iter()
            .all(Option::is_some)
        });
        let clean = self.diagnostics.as_ref().is_some_and(|d| {
            d.malformed_lines == 0
                && d.missing_usage_records == 0
                && d.missing_fields == 0
                && !d.ambiguous_workspace
                && d.undeduplicable_messages == 0
                && d.non_monotonic == 0
                && d.inconsistent_records == 0
        });
        self.failure.is_some() || !complete_counts || !clean
    }
}

impl std::fmt::Debug for UsageObservation {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("UsageObservation")
            .field("framework", &self.framework)
            .field("incomplete", &self.incomplete())
            .field("failure", &self.failure)
            .finish_non_exhaustive()
    }
}
