use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    fs,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};

type HmacSha256 = Hmac<Sha256>;

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
pub struct Trigger {
    pub id: String,
    #[serde(default)]
    pub program_id: Option<String>,
    #[serde(default)]
    pub event_kind: Option<String>,
    #[serde(default)]
    pub min_ltv_bps: Option<u32>,
    #[serde(default = "enabled")]
    pub enabled: bool,
}

fn enabled() -> bool {
    true
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct Observation {
    pub signature: String,
    pub slot: u64,
    pub program_id: String,
    #[serde(default)]
    pub event_index: u32,
    #[serde(default)]
    pub event_kind: Option<String>,
    #[serde(default)]
    pub ltv_bps: Option<u32>,
    #[serde(default)]
    pub payload: serde_json::Value,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum JobStatus {
    Queued,
    Running,
    Completed,
    Failed,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct WakeJob {
    pub id: String,
    pub trigger_id: String,
    pub observation: Observation,
    pub status: JobStatus,
    pub attempts: u32,
    pub last_error: Option<String>,
    pub created_at: u64,
    pub updated_at: u64,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LaunchReviewStatus {
    PendingReview,
    Approved,
    Rejected,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LaunchReviewDecision {
    Approve,
    Reject,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
pub struct TokenLaunchRequest {
    pub name: String,
    pub symbol: String,
    pub decimals: u8,
    /// Initial supply in integer base units. Never use floating point token amounts.
    pub initial_supply: u64,
    pub network: String,
    pub metadata_uri: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
pub struct TokenLaunchProposal {
    pub id: String,
    #[serde(flatten)]
    pub request: TokenLaunchRequest,
    pub status: LaunchReviewStatus,
    pub fingerprint: String,
    pub created_at: u64,
    pub reviewer: Option<String>,
    pub reviewed_at: Option<u64>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
struct State {
    triggers: Vec<Trigger>,
    jobs: Vec<WakeJob>,
    #[serde(default)]
    token_launch_proposals: Vec<TokenLaunchProposal>,
    claimed: HashSet<String>,
    last_slot: u64,
}

#[derive(Clone)]
pub struct TriggerStore {
    state: Arc<Mutex<State>>,
    state_file: PathBuf,
}

impl TriggerStore {
    pub fn load(state_file: impl Into<PathBuf>) -> Result<Self, String> {
        let state_file = state_file.into();
        let state = load_state(&state_file)?;
        Ok(Self {
            state: Arc::new(Mutex::new(state)),
            state_file,
        })
    }

    pub fn triggers(&self) -> Vec<Trigger> {
        self.state
            .lock()
            .expect("state lock poisoned")
            .triggers
            .clone()
    }

    pub fn jobs(&self) -> Vec<WakeJob> {
        self.state.lock().expect("state lock poisoned").jobs.clone()
    }

    pub fn token_launch_proposals(&self) -> Vec<TokenLaunchProposal> {
        self.state
            .lock()
            .expect("state lock poisoned")
            .token_launch_proposals
            .clone()
    }

    /// Stores an agent-authored token launch request; this never creates or signs a chain transaction.
    pub fn propose_token_launch(
        &self,
        request: TokenLaunchRequest,
    ) -> Result<TokenLaunchProposal, String> {
        validate_token_launch(&request)?;
        let canonical = serde_json::to_vec(&request).map_err(|error| error.to_string())?;
        let fingerprint = format!("{:x}", Sha256::digest(canonical));
        let mut state = self.state.lock().map_err(|_| "state lock poisoned")?;
        if let Some(existing) = state
            .token_launch_proposals
            .iter()
            .find(|proposal| proposal.fingerprint == fingerprint)
        {
            return Ok(existing.clone());
        }
        if state.token_launch_proposals.len() >= 10_000 {
            return Err("token launch proposal queue is full".into());
        }
        let proposal = TokenLaunchProposal {
            id: fingerprint.clone(),
            request,
            status: LaunchReviewStatus::PendingReview,
            fingerprint,
            created_at: now(),
            reviewer: None,
            reviewed_at: None,
        };
        state.token_launch_proposals.push(proposal.clone());
        persist(&self.state_file, &state)?;
        Ok(proposal)
    }

    pub fn review_token_launch(
        &self,
        id: &str,
        decision: LaunchReviewDecision,
        reviewer: &str,
    ) -> Result<TokenLaunchProposal, String> {
        if reviewer.trim().is_empty() || reviewer.trim().len() > 128 {
            return Err("reviewer must contain 1-128 characters".into());
        }
        let mut state = self.state.lock().map_err(|_| "state lock poisoned")?;
        let proposal = state
            .token_launch_proposals
            .iter_mut()
            .find(|proposal| proposal.id == id)
            .ok_or("token launch proposal not found")?;
        if proposal.status != LaunchReviewStatus::PendingReview {
            return Err("token launch proposal is not pending review".into());
        }
        let canonical = serde_json::to_vec(&proposal.request).map_err(|error| error.to_string())?;
        let current_fingerprint = format!("{:x}", Sha256::digest(canonical));
        if proposal.fingerprint != current_fingerprint || proposal.id != current_fingerprint {
            return Err("token launch proposal changed after submission".into());
        }
        proposal.status = match decision {
            LaunchReviewDecision::Approve => LaunchReviewStatus::Approved,
            LaunchReviewDecision::Reject => LaunchReviewStatus::Rejected,
        };
        proposal.reviewer = Some(reviewer.trim().to_owned());
        proposal.reviewed_at = Some(now());
        let reviewed = proposal.clone();
        persist(&self.state_file, &state)?;
        Ok(reviewed)
    }

    pub fn register(&self, trigger: Trigger) -> Result<(), String> {
        validate_trigger(&trigger)?;
        let mut state = self.state.lock().map_err(|_| "state lock poisoned")?;
        if state.triggers.iter().any(|item| item.id == trigger.id) {
            return Err("trigger already exists".into());
        }
        state.triggers.push(trigger);
        persist(&self.state_file, &state)
    }

    pub fn ingest(&self, observation: Observation) -> Result<Vec<WakeJob>, String> {
        validate_observation(&observation)?;
        let mut state = self.state.lock().map_err(|_| "state lock poisoned")?;
        state.last_slot = state.last_slot.max(observation.slot);
        let mut jobs = Vec::new();
        for trigger in state.triggers.clone() {
            if !trigger.enabled || !matches(&trigger, &observation) {
                continue;
            }
            let id = format!(
                "{}:{}:{}",
                trigger.id, observation.signature, observation.event_index
            );
            if !state.claimed.insert(id.clone()) {
                continue;
            }
            let timestamp = now();
            let job = WakeJob {
                id,
                trigger_id: trigger.id,
                observation: observation.clone(),
                status: JobStatus::Queued,
                attempts: 0,
                last_error: None,
                created_at: timestamp,
                updated_at: timestamp,
            };
            state.jobs.push(job.clone());
            jobs.push(job);
        }
        persist(&self.state_file, &state)?;
        Ok(jobs)
    }

    pub fn claim_next(&self) -> Result<Option<WakeJob>, String> {
        let mut state = self.state.lock().map_err(|_| "state lock poisoned")?;
        let Some(index) = state
            .jobs
            .iter()
            .position(|job| job.status == JobStatus::Queued)
        else {
            return Ok(None);
        };
        state.jobs[index].status = JobStatus::Running;
        state.jobs[index].attempts = state.jobs[index].attempts.saturating_add(1);
        state.jobs[index].updated_at = now();
        let job = state.jobs[index].clone();
        persist(&self.state_file, &state)?;
        Ok(Some(job))
    }

    pub fn complete(&self, id: &str) -> Result<WakeJob, String> {
        self.transition(id, JobStatus::Completed, None)
    }

    pub fn fail(&self, id: &str, error: String) -> Result<WakeJob, String> {
        if error.trim().is_empty() || error.len() > 2_000 {
            return Err("job error must contain 1-2000 characters".into());
        }
        self.transition(id, JobStatus::Failed, Some(error))
    }

    pub fn retry(&self, id: &str) -> Result<WakeJob, String> {
        self.transition(id, JobStatus::Queued, None)
    }

    fn transition(
        &self,
        id: &str,
        status: JobStatus,
        error: Option<String>,
    ) -> Result<WakeJob, String> {
        let mut state = self.state.lock().map_err(|_| "state lock poisoned")?;
        let job = state
            .jobs
            .iter_mut()
            .find(|job| job.id == id)
            .ok_or("job not found")?;
        job.status = status;
        job.last_error = error;
        job.updated_at = now();
        let result = job.clone();
        persist(&self.state_file, &state)?;
        Ok(result)
    }
}

pub fn verify_signature(
    secret: &str,
    timestamp: &str,
    body: &str,
    provided: &str,
) -> Result<(), String> {
    let timestamp = timestamp
        .parse::<u64>()
        .map_err(|_| "invalid webhook timestamp")?;
    if now().abs_diff(timestamp) > 300 {
        return Err("webhook timestamp is too old".into());
    }
    let signature = provided
        .strip_prefix("sha256=")
        .ok_or("invalid webhook signature format")?;
    let bytes = decode_hex(signature)?;
    let mut mac =
        HmacSha256::new_from_slice(secret.as_bytes()).map_err(|_| "invalid webhook secret")?;
    mac.update(format!("{timestamp}.{body}").as_bytes());
    mac.verify_slice(&bytes)
        .map_err(|_| "invalid webhook signature".into())
}

fn validate_trigger(trigger: &Trigger) -> Result<(), String> {
    if trigger.id.is_empty()
        || trigger.id.len() > 128
        || !trigger
            .id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_'))
    {
        return Err(
            "trigger id must contain 1-128 ASCII letters, numbers, hyphens, or underscores".into(),
        );
    }
    if trigger.min_ltv_bps.is_some_and(|value| value > 10_000) {
        return Err("minimum LTV cannot exceed 10000 basis points".into());
    }
    Ok(())
}

fn validate_observation(observation: &Observation) -> Result<(), String> {
    if observation.signature.trim().is_empty() || observation.signature.len() > 128 {
        return Err("observation signature must contain 1-128 characters".into());
    }
    if observation.program_id.trim().is_empty() || observation.program_id.len() > 64 {
        return Err("program id must contain 1-64 characters".into());
    }
    if observation.ltv_bps.is_some_and(|value| value > 10_000) {
        return Err("observation LTV cannot exceed 10000 basis points".into());
    }
    Ok(())
}

fn validate_token_launch(request: &TokenLaunchRequest) -> Result<(), String> {
    let name = request.name.trim();
    if name.is_empty() || name.len() > 32 {
        return Err("token name must contain 1-32 characters".into());
    }
    if !(2..=10).contains(&request.symbol.len())
        || !request
            .symbol
            .bytes()
            .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit())
    {
        return Err("token symbol must contain 2-10 uppercase ASCII letters or digits".into());
    }
    if request.decimals > 9 {
        return Err("token decimals must be between 0 and 9".into());
    }
    if request.initial_supply == 0 {
        return Err("initial supply must be a positive integer number of base units".into());
    }
    if request.network != "devnet" && request.network != "mainnet-beta" {
        return Err("network must be devnet or mainnet-beta".into());
    }
    let host = request
        .metadata_uri
        .strip_prefix("https://")
        .and_then(|rest| rest.split(['/', '?', '#']).next());
    if host.is_none_or(|host| {
        host.is_empty() || host.contains('@') || host.chars().any(char::is_whitespace)
    }) {
        return Err("metadata URI must be an HTTPS URL with a valid host".into());
    }
    if request.metadata_uri.len() > 2_048 {
        return Err("metadata URI must be at most 2048 characters".into());
    }
    Ok(())
}

fn matches(trigger: &Trigger, observation: &Observation) -> bool {
    trigger
        .program_id
        .as_ref()
        .is_none_or(|id| id == &observation.program_id)
        && trigger
            .event_kind
            .as_ref()
            .is_none_or(|kind| observation.event_kind.as_ref() == Some(kind))
        && trigger
            .min_ltv_bps
            .is_none_or(|min| observation.ltv_bps.unwrap_or(0) >= min)
}

fn load_state(path: &Path) -> Result<State, String> {
    match fs::read_to_string(path) {
        Ok(contents) => serde_json::from_str(&contents).map_err(|error| error.to_string()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(State::default()),
        Err(error) => Err(error.to_string()),
    }
}

fn persist(path: &Path, state: &State) -> Result<(), String> {
    let temp = path.with_extension("tmp");
    let contents = serde_json::to_vec_pretty(state).map_err(|error| error.to_string())?;
    fs::write(&temp, contents).map_err(|error| error.to_string())?;
    fs::rename(temp, path).map_err(|error| error.to_string())
}

fn decode_hex(value: &str) -> Result<Vec<u8>, String> {
    if !value.len().is_multiple_of(2) {
        return Err("invalid webhook signature encoding".into());
    }
    (0..value.len())
        .step_by(2)
        .map(|index| {
            u8::from_str_radix(&value[index..index + 2], 16)
                .map_err(|_| "invalid webhook signature encoding".into())
        })
        .collect()
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    static NEXT_TEST_FILE: AtomicU64 = AtomicU64::new(0);

    fn store() -> (TriggerStore, PathBuf) {
        let path = std::env::temp_dir().join(format!(
            "agent-hooks-trigger-test-{}-{}-{}.json",
            std::process::id(),
            now(),
            NEXT_TEST_FILE.fetch_add(1, Ordering::Relaxed)
        ));
        (TriggerStore::load(path.clone()).unwrap(), path)
    }

    fn observation() -> Observation {
        Observation {
            signature: "tx-1".into(),
            slot: 42,
            program_id: "LendingProgram".into(),
            event_index: 1,
            event_kind: Some("beforeLiquidate".into()),
            ltv_bps: Some(8_500),
            payload: serde_json::json!({}),
        }
    }

    fn token_launch() -> TokenLaunchRequest {
        TokenLaunchRequest {
            name: "Example Finance Token".into(),
            symbol: "EFT".into(),
            decimals: 6,
            initial_supply: 1_000_000_000,
            network: "devnet".into(),
            metadata_uri: "https://example.com/token.json".into(),
        }
    }

    #[test]
    fn matches_deduplicates_and_runs_job_lifecycle() {
        let (store, path) = store();
        store
            .register(Trigger {
                id: "liquidation-risk".into(),
                program_id: Some("LendingProgram".into()),
                event_kind: Some("beforeLiquidate".into()),
                min_ltv_bps: Some(8_000),
                enabled: true,
            })
            .unwrap();
        assert_eq!(store.ingest(observation()).unwrap().len(), 1);
        assert!(store.ingest(observation()).unwrap().is_empty());
        let running = store.claim_next().unwrap().unwrap();
        assert_eq!(running.status, JobStatus::Running);
        assert_eq!(running.attempts, 1);
        assert_eq!(
            store.complete(&running.id).unwrap().status,
            JobStatus::Completed
        );
        let _ = fs::remove_file(path);
    }

    #[test]
    fn signature_verification_rejects_tampering() {
        let timestamp = now().to_string();
        let body = "{}";
        let mut mac = HmacSha256::new_from_slice(b"secret").unwrap();
        mac.update(format!("{timestamp}.{body}").as_bytes());
        let signature = format!(
            "sha256={}",
            mac.finalize()
                .into_bytes()
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect::<String>()
        );
        assert!(verify_signature("secret", &timestamp, body, &signature).is_ok());
        assert!(verify_signature("secret", &timestamp, "{\"changed\":true}", &signature).is_err());
    }

    #[test]
    fn token_launch_requests_are_validated_and_deduplicated_as_proposals() {
        let (store, path) = store();
        let first = store.propose_token_launch(token_launch()).unwrap();
        let replay = store.propose_token_launch(token_launch()).unwrap();
        assert_eq!(first.id, replay.id);
        assert_eq!(first.status, LaunchReviewStatus::PendingReview);
        assert_eq!(store.token_launch_proposals().len(), 1);
        let _ = fs::remove_file(path);
    }

    #[test]
    fn token_launch_rejects_unsafe_metadata_and_supply() {
        let (store, path) = store();
        let mut request = token_launch();
        request.metadata_uri = "http://example.com/token.json".into();
        assert!(store.propose_token_launch(request).is_err());
        let mut request = token_launch();
        request.initial_supply = 0;
        assert!(store.propose_token_launch(request).is_err());
        let _ = fs::remove_file(path);
    }

    #[test]
    fn launch_proposal_requires_a_named_one_time_review() {
        let (store, path) = store();
        let proposal = store.propose_token_launch(token_launch()).unwrap();
        assert!(store
            .review_token_launch(&proposal.id, LaunchReviewDecision::Approve, " ")
            .is_err());
        let approved = store
            .review_token_launch(
                &proposal.id,
                LaunchReviewDecision::Approve,
                "operator@example.com",
            )
            .unwrap();
        assert_eq!(approved.status, LaunchReviewStatus::Approved);
        assert_eq!(approved.reviewer.as_deref(), Some("operator@example.com"));
        assert!(store
            .review_token_launch(
                &proposal.id,
                LaunchReviewDecision::Reject,
                "operator@example.com"
            )
            .is_err());
        let _ = fs::remove_file(path);
    }
}
