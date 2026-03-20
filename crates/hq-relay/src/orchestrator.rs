//! Session orchestrator — manages harness execution sessions with state tracking.

use anyhow::{bail, Result};
use chrono::{DateTime, Utc};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::Mutex;
use tokio::time::{timeout, Duration};
use tracing::{info, warn};

use crate::harness::LocalHarness;

/// State of a session.
#[derive(Debug, Clone, PartialEq)]
pub enum SessionState {
    Spawning,
    Working,
    Done,
    Failed(String),
    Stuck,
    TimedOut,
}

/// Information about an active or completed session.
#[derive(Debug, Clone)]
pub struct SessionInfo {
    pub session_id: String,
    pub state: SessionState,
    pub harness_type: String,
    pub started_at: DateTime<Utc>,
    pub finished_at: Option<DateTime<Utc>>,
    pub result: Option<String>,
}

/// Manages harness execution sessions with state tracking, timeout detection,
/// and retry logic.
pub struct SessionOrchestrator {
    sessions: Arc<Mutex<HashMap<String, SessionInfo>>>,
    harness: Arc<LocalHarness>,
}

impl SessionOrchestrator {
    pub fn new(harness: Arc<LocalHarness>) -> Self {
        Self {
            sessions: Arc::new(Mutex::new(HashMap::new())),
            harness,
        }
    }

    /// Run a harness session. Handles state transitions and retry.
    ///
    /// - Sets state to Working
    /// - Starts a 20-minute stuck detection timer
    /// - Calls harness.run() with max 1 retry on failure
    /// - On success: state = Done
    /// - On failure: state = Failed/TimedOut
    pub async fn run(
        &self,
        session_id: &str,
        harness_type: &str,
        prompt: &str,
    ) -> Result<String> {
        let now = Utc::now();
        let info = SessionInfo {
            session_id: session_id.to_string(),
            state: SessionState::Spawning,
            harness_type: harness_type.to_string(),
            started_at: now,
            finished_at: None,
            result: None,
        };

        {
            let mut sessions = self.sessions.lock().await;
            sessions.insert(session_id.to_string(), info);
        }

        // Transition to Working
        self.set_state(session_id, SessionState::Working).await;

        // 20-minute overall timeout for stuck detection
        let twenty_minutes = Duration::from_secs(1200);

        let result = match timeout(twenty_minutes, self.run_with_retry(harness_type, prompt)).await
        {
            Ok(inner) => inner,
            Err(_) => {
                warn!(session_id, "Session stuck — 20 minute timeout exceeded");
                self.set_state(session_id, SessionState::Stuck).await;
                self.harness.kill(harness_type).await;
                bail!("Session '{session_id}' stuck after 20 minutes")
            }
        };

        match &result {
            Ok(text) => {
                let mut sessions = self.sessions.lock().await;
                if let Some(info) = sessions.get_mut(session_id) {
                    info.state = SessionState::Done;
                    info.finished_at = Some(Utc::now());
                    info.result = Some(text.clone());
                }
                info!(session_id, "Session completed successfully");
            }
            Err(e) => {
                let error_msg = e.to_string();
                let state = if error_msg.contains("timed out") {
                    SessionState::TimedOut
                } else {
                    SessionState::Failed(error_msg)
                };

                let mut sessions = self.sessions.lock().await;
                if let Some(info) = sessions.get_mut(session_id) {
                    info.state = state;
                    info.finished_at = Some(Utc::now());
                }
            }
        }

        result
    }

    /// Get info about a session.
    pub async fn get_session(&self, session_id: &str) -> Option<SessionInfo> {
        let sessions = self.sessions.lock().await;
        sessions.get(session_id).cloned()
    }

    /// List all sessions.
    pub async fn list_sessions(&self) -> Vec<SessionInfo> {
        let sessions = self.sessions.lock().await;
        sessions.values().cloned().collect()
    }

    // --- Internal ---

    /// Run with max 1 retry on failure.
    async fn run_with_retry(&self, harness_type: &str, prompt: &str) -> Result<String> {
        match self.harness.run(harness_type, prompt).await {
            Ok(result) => Ok(result),
            Err(first_err) => {
                warn!(%first_err, harness_type, "First attempt failed, retrying once");

                // Brief pause before retry
                tokio::time::sleep(Duration::from_secs(2)).await;

                self.harness.run(harness_type, prompt).await.map_err(|e| {
                    anyhow::anyhow!("Harness failed after retry: {e} (first error: {first_err})")
                })
            }
        }
    }

    async fn set_state(&self, session_id: &str, state: SessionState) {
        let mut sessions = self.sessions.lock().await;
        if let Some(info) = sessions.get_mut(session_id) {
            info.state = state;
        }
    }
}
