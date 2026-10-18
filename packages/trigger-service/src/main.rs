use agent_hooks_trigger_service::{
    verify_signature, LaunchReviewDecision, Observation, TokenLaunchRequest, Trigger, TriggerStore,
};
use serde::Deserialize;
use std::{
    env,
    io::{Read, Write},
    net::{TcpListener, TcpStream},
};

#[derive(Clone)]
struct App {
    store: TriggerStore,
    secret: Option<String>,
    agent_secret: Option<String>,
    review_secret: Option<String>,
}

#[derive(Deserialize)]
struct FailureBody {
    error: String,
}

#[derive(Deserialize)]
struct LaunchReviewBody {
    reviewer: String,
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let bind = env::var("TRIGGER_BIND").unwrap_or_else(|_| "127.0.0.1:8787".into());
    let state_file =
        env::var("TRIGGER_STATE_FILE").unwrap_or_else(|_| "./trigger-state.json".into());
    let app = App {
        store: TriggerStore::load(state_file)?,
        secret: env::var("TRIGGER_WEBHOOK_SECRET").ok(),
        agent_secret: env::var("TRIGGER_AGENT_SECRET").ok(),
        review_secret: env::var("TRIGGER_REVIEW_SECRET").ok(),
    };
    let listener = TcpListener::bind(&bind)?;
    println!("agent-hooks trigger service listening on http://{bind}");
    for stream in listener.incoming() {
        match stream {
            Ok(stream) => {
                let app = app.clone();
                std::thread::spawn(move || {
                    if let Err(error) = handle(stream, &app) {
                        eprintln!("request failed: {error}");
                    }
                });
            }
            Err(error) => eprintln!("connection failed: {error}"),
        }
    }
    Ok(())
}

fn handle(mut stream: TcpStream, app: &App) -> Result<(), Box<dyn std::error::Error>> {
    let (method, path, headers, body) = read_request(&mut stream)?;
    let (status, response) = route(app, &method, &path, &headers, &body);
    write_response(&mut stream, status, &response.to_string())?;
    Ok(())
}

fn route(
    app: &App,
    method: &str,
    path: &str,
    headers: &[(String, String)],
    body: &str,
) -> (u16, serde_json::Value) {
    match (method, path) {
        ("GET", "/health") => (
            200,
            serde_json::json!({"ok": true, "service": "trigger-hooks"}),
        ),
        ("GET", "/v1/triggers") => match auth_error(headers, &app.review_secret) {
            Some(error) => error,
            None => (200, serde_json::json!(app.store.triggers())),
        },
        ("GET", "/v1/jobs") => match auth_error(headers, &app.review_secret) {
            Some(error) => error,
            None => (200, serde_json::json!(app.store.jobs())),
        },
        ("GET", "/v1/token-launch-proposals") => match auth_error(headers, &app.review_secret) {
            Some(error) => error,
            None => (200, serde_json::json!(app.store.token_launch_proposals())),
        },
        ("POST", "/v1/triggers") => match auth_error(headers, &app.review_secret) {
            Some(error) => error,
            None => match serde_json::from_str::<Trigger>(body) {
                Ok(trigger) => match app.store.register(trigger.clone()) {
                    Ok(()) => (201, serde_json::json!(trigger)),
                    Err(error) if error == "trigger already exists" => error_response(409, error),
                    Err(error) => error_response(400, error),
                },
                Err(error) => error_response(400, format!("invalid trigger JSON: {error}")),
            },
        },
        ("POST", "/v1/observations") => ingest(app, headers, body),
        ("POST", "/v1/jobs/claim") => match auth_error(headers, &app.agent_secret) {
            Some(error) => error,
            None => match app.store.claim_next() {
                Ok(job) => (200, serde_json::json!({"job": job})),
                Err(error) => error_response(500, error),
            },
        },
        ("POST", "/v1/token-launch-proposals") => match auth_error(headers, &app.agent_secret) {
            Some(error) => error,
            None => match serde_json::from_str::<TokenLaunchRequest>(body) {
                Ok(request) => match app.store.propose_token_launch(request) {
                    Ok(proposal) => (202, serde_json::json!(proposal)),
                    Err(error) => error_response(400, error),
                },
                Err(error) => error_response(400, format!("invalid launch proposal JSON: {error}")),
            },
        },
        _ if method == "POST" && path.starts_with("/v1/token-launch-proposals/") => {
            match auth_error(headers, &app.review_secret) {
                Some(error) => error,
                None => review_launch(app, path, body),
            }
        }
        _ if method == "POST" => match auth_error(headers, &app.agent_secret) {
            Some(error) => error,
            None => transition(app, path, body),
        },
        _ => error_response(404, "not found"),
    }
}

fn auth_error(
    headers: &[(String, String)],
    secret: &Option<String>,
) -> Option<(u16, serde_json::Value)> {
    let Some(secret) = secret.as_deref() else {
        return Some(error_response(503, "this API role is not configured"));
    };
    let provided = header(headers, "authorization")
        .and_then(|value| value.strip_prefix("Bearer ").map(str::to_owned));
    if provided
        .as_deref()
        .is_some_and(|provided| secret_matches(secret, provided))
    {
        None
    } else {
        Some(error_response(401, "invalid bearer credential"))
    }
}

fn secret_matches(expected: &str, provided: &str) -> bool {
    use hmac::{Hmac, Mac};
    use sha2::Sha256;
    type HmacSha256 = Hmac<Sha256>;

    let Ok(mut expected_mac) = HmacSha256::new_from_slice(expected.as_bytes()) else {
        return false;
    };
    expected_mac.update(b"agent-hooks-api-token-v1");
    let expected_tag = expected_mac.finalize().into_bytes();
    let Ok(mut provided_mac) = HmacSha256::new_from_slice(provided.as_bytes()) else {
        return false;
    };
    provided_mac.update(b"agent-hooks-api-token-v1");
    provided_mac.verify_slice(&expected_tag).is_ok()
}

fn review_launch(app: &App, path: &str, body: &str) -> (u16, serde_json::Value) {
    let Some(rest) = path.strip_prefix("/v1/token-launch-proposals/") else {
        return error_response(404, "not found");
    };
    let Some((id, action)) = rest.rsplit_once('/') else {
        return error_response(404, "not found");
    };
    let Some(id) = decode_path_segment(id) else {
        return error_response(400, "invalid proposal id encoding");
    };
    let decision = match action {
        "approve" => LaunchReviewDecision::Approve,
        "reject" => LaunchReviewDecision::Reject,
        _ => return error_response(404, "not found"),
    };
    match serde_json::from_str::<LaunchReviewBody>(body) {
        Ok(review) => match app
            .store
            .review_token_launch(&id, decision, &review.reviewer)
        {
            Ok(proposal) => (200, serde_json::json!(proposal)),
            Err(error) if error == "token launch proposal not found" => error_response(404, error),
            Err(error) => error_response(409, error),
        },
        Err(error) => error_response(400, format!("invalid review JSON: {error}")),
    }
}

fn ingest(app: &App, headers: &[(String, String)], body: &str) -> (u16, serde_json::Value) {
    let Some(secret) = &app.secret else {
        return error_response(503, "observation webhook authentication is not configured");
    };
    let Some(timestamp) = header(headers, "x-agent-hooks-timestamp") else {
        return error_response(401, "missing webhook timestamp");
    };
    let Some(signature) = header(headers, "x-agent-hooks-signature") else {
        return error_response(401, "missing webhook signature");
    };
    if let Err(error) = verify_signature(secret, &timestamp, body, &signature) {
        return error_response(401, error);
    }
    match serde_json::from_str::<Observation>(body) {
        Ok(observation) => match app.store.ingest(observation) {
            Ok(jobs) => (202, serde_json::json!({"accepted": true, "jobs": jobs})),
            Err(error) => error_response(400, error),
        },
        Err(error) => error_response(400, format!("invalid observation JSON: {error}")),
    }
}

fn transition(app: &App, path: &str, body: &str) -> (u16, serde_json::Value) {
    let Some(rest) = path.strip_prefix("/v1/jobs/") else {
        return error_response(404, "not found");
    };
    let Some((id, action)) = rest.rsplit_once('/') else {
        return error_response(404, "not found");
    };
    let Some(id) = decode_path_segment(id) else {
        return error_response(400, "invalid job id encoding");
    };
    let result = match action {
        "complete" => app.store.complete(&id),
        "retry" => app.store.retry(&id),
        "fail" => match serde_json::from_str::<FailureBody>(body) {
            Ok(failure) => app.store.fail(&id, failure.error),
            Err(error) => return error_response(400, format!("invalid failure JSON: {error}")),
        },
        _ => return error_response(404, "not found"),
    };
    match result {
        Ok(job) => (200, serde_json::json!(job)),
        Err(error) if error == "job not found" => error_response(404, error),
        Err(error) => error_response(400, error),
    }
}

fn decode_path_segment(value: &str) -> Option<String> {
    let bytes = value.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            let high = (*bytes.get(index + 1)? as char).to_digit(16)? as u8;
            let low = (*bytes.get(index + 2)? as char).to_digit(16)? as u8;
            decoded.push((high << 4) | low);
            index += 3;
        } else {
            decoded.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(decoded).ok()
}

fn error_response(status: u16, error: impl Into<String>) -> (u16, serde_json::Value) {
    (status, serde_json::json!({"error": error.into()}))
}

fn header(headers: &[(String, String)], name: &str) -> Option<String> {
    headers
        .iter()
        .find(|(key, _)| key.eq_ignore_ascii_case(name))
        .map(|(_, value)| value.clone())
}

fn read_request(
    stream: &mut TcpStream,
) -> Result<(String, String, Vec<(String, String)>, String), Box<dyn std::error::Error>> {
    let mut bytes = Vec::new();
    let mut buffer = [0u8; 1024];
    let header_end = loop {
        let count = stream.read(&mut buffer)?;
        if count == 0 {
            return Err("connection closed before request headers".into());
        }
        bytes.extend_from_slice(&buffer[..count]);
        if let Some(index) = bytes.windows(4).position(|window| window == b"\r\n\r\n") {
            break index + 4;
        }
        if bytes.len() > 64 * 1024 {
            return Err("request headers too large".into());
        }
    };
    let head = String::from_utf8(bytes[..header_end - 4].to_vec())?;
    let mut lines = head.lines();
    let mut start = lines
        .next()
        .ok_or("missing request line")?
        .split_whitespace();
    let method = start.next().ok_or("missing method")?.to_owned();
    let path = start.next().ok_or("missing path")?.to_owned();
    let headers: Vec<(String, String)> = lines
        .filter_map(|line| {
            line.split_once(':')
                .map(|(key, value)| (key.trim().to_owned(), value.trim().to_owned()))
        })
        .collect();
    let content_length = header(&headers, "content-length")
        .unwrap_or_default()
        .parse::<usize>()
        .unwrap_or(0);
    if content_length > 256 * 1024 {
        return Err("request body too large".into());
    }
    while bytes.len() < header_end + content_length {
        let count = stream.read(&mut buffer)?;
        if count == 0 {
            return Err("connection closed before request body".into());
        }
        bytes.extend_from_slice(&buffer[..count]);
    }
    let body = String::from_utf8(bytes[header_end..header_end + content_length].to_vec())?;
    Ok((method, path, headers, body))
}

fn write_response(
    stream: &mut TcpStream,
    status: u16,
    body: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    let reason = match status {
        200 => "OK",
        201 => "Created",
        202 => "Accepted",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        409 => "Conflict",
        503 => "Service Unavailable",
        _ => "Internal Server Error",
    };
    write!(stream, "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn health_route_is_available() {
        let state_path = std::env::temp_dir().join(format!(
            "agent-hooks-route-test-{}.json",
            std::process::id()
        ));
        let app = App {
            store: TriggerStore::load(state_path.clone()).unwrap(),
            secret: None,
            agent_secret: None,
            review_secret: None,
        };
        let (status, body) = route(&app, "GET", "/health", &[], "");
        assert_eq!(status, 200);
        assert_eq!(body["ok"], true);
        let _ = std::fs::remove_file(state_path);
    }

    #[test]
    fn agent_can_propose_but_only_reviewer_can_approve_launch() {
        let state_path = std::env::temp_dir().join(format!(
            "agent-hooks-launch-route-{}-{}.json",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let app = App {
            store: TriggerStore::load(state_path.clone()).unwrap(),
            secret: None,
            agent_secret: Some("agent-secret".into()),
            review_secret: Some("review-secret".into()),
        };
        let request = serde_json::json!({
            "name": "Example Finance Token",
            "symbol": "EFT",
            "decimals": 6,
            "initial_supply": "1000000",
            "network": "devnet",
            "metadata_uri": "https://example.com/token.json"
        })
        .to_string();
        let agent_headers = vec![("authorization".into(), "Bearer agent-secret".into())];
        let (status, proposal) = route(
            &app,
            "POST",
            "/v1/token-launch-proposals",
            &agent_headers,
            &request,
        );
        assert_eq!(status, 202);
        assert_eq!(proposal["status"], "pending_review");
        let id = proposal["id"].as_str().unwrap();

        let reviewer_headers = vec![("authorization".into(), "Bearer review-secret".into())];
        let route_path = format!("/v1/token-launch-proposals/{id}/approve");
        let (status, _) = route(
            &app,
            "POST",
            &route_path,
            &agent_headers,
            r#"{"reviewer":"agent"}"#,
        );
        assert_eq!(status, 401);
        let (status, reviewed) = route(
            &app,
            "POST",
            &route_path,
            &reviewer_headers,
            r#"{"reviewer":"operator"}"#,
        );
        assert_eq!(status, 200);
        assert_eq!(reviewed["status"], "approved");
        let _ = std::fs::remove_file(state_path);
    }

    #[test]
    fn observations_are_rejected_when_hmac_auth_is_not_configured() {
        let path = std::env::temp_dir().join(format!(
            "agent-hooks-ingest-auth-{}-{}.json",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let app = App {
            store: TriggerStore::load(path.clone()).unwrap(),
            secret: None,
            agent_secret: None,
            review_secret: None,
        };
        let (status, _) = route(&app, "POST", "/v1/observations", &[], "{}");
        assert_eq!(status, 503);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn bridge_can_complete_job_ids_with_percent_encoded_separators() {
        let state_path = std::env::temp_dir().join(format!(
            "agent-hooks-bridge-route-{}-{}.json",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let app = App {
            store: TriggerStore::load(state_path.clone()).unwrap(),
            secret: None,
            agent_secret: Some("agent-secret".into()),
            review_secret: Some("review-secret".into()),
        };
        app.store
            .register(Trigger {
                id: "bridge-job".into(),
                program_id: None,
                event_kind: None,
                min_ltv_bps: None,
                enabled: true,
            })
            .unwrap();
        let job = app
            .store
            .ingest(Observation {
                signature: "tx-signature".into(),
                slot: 10,
                program_id: "program".into(),
                event_index: 2,
                event_kind: None,
                ltv_bps: None,
                payload: serde_json::json!({}),
            })
            .unwrap()
            .remove(0);
        let encoded_id = job.id.replace(':', "%3A");
        let route_path = format!("/v1/jobs/{encoded_id}/complete");
        let headers = vec![("authorization".into(), "Bearer agent-secret".into())];
        let (status, result) = route(&app, "POST", &route_path, &headers, "");
        assert_eq!(status, 200);
        assert_eq!(result["status"], "completed");
        let _ = std::fs::remove_file(state_path);
    }
}
