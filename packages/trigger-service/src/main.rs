use agent_hooks_trigger_service::{verify_signature, Observation, Trigger, TriggerStore};
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
}

#[derive(Deserialize)]
struct FailureBody {
    error: String,
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let bind = env::var("TRIGGER_BIND").unwrap_or_else(|_| "127.0.0.1:8787".into());
    let state_file =
        env::var("TRIGGER_STATE_FILE").unwrap_or_else(|_| "./trigger-state.json".into());
    let app = App {
        store: TriggerStore::load(state_file)?,
        secret: env::var("TRIGGER_WEBHOOK_SECRET").ok(),
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
        ("GET", "/v1/triggers") => (200, serde_json::json!(app.store.triggers())),
        ("GET", "/v1/jobs") => (200, serde_json::json!(app.store.jobs())),
        ("POST", "/v1/triggers") => match serde_json::from_str::<Trigger>(body) {
            Ok(trigger) => match app.store.register(trigger.clone()) {
                Ok(()) => (201, serde_json::json!(trigger)),
                Err(error) if error == "trigger already exists" => error_response(409, error),
                Err(error) => error_response(400, error),
            },
            Err(error) => error_response(400, format!("invalid trigger JSON: {error}")),
        },
        ("POST", "/v1/observations") => ingest(app, headers, body),
        ("POST", "/v1/jobs/claim") => match app.store.claim_next() {
            Ok(job) => (200, serde_json::json!({"job": job})),
            Err(error) => error_response(500, error),
        },
        _ if method == "POST" => transition(app, path, body),
        _ => error_response(404, "not found"),
    }
}

fn ingest(app: &App, headers: &[(String, String)], body: &str) -> (u16, serde_json::Value) {
    if let Some(secret) = &app.secret {
        let Some(timestamp) = header(headers, "x-agent-hooks-timestamp") else {
            return error_response(401, "missing webhook timestamp");
        };
        let Some(signature) = header(headers, "x-agent-hooks-signature") else {
            return error_response(401, "missing webhook signature");
        };
        if let Err(error) = verify_signature(secret, &timestamp, body, &signature) {
            return error_response(401, error);
        }
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
    let result = match action {
        "complete" => app.store.complete(id),
        "retry" => app.store.retry(id),
        "fail" => match serde_json::from_str::<FailureBody>(body) {
            Ok(failure) => app.store.fail(id, failure.error),
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
        404 => "Not Found",
        409 => "Conflict",
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
        let path = std::env::temp_dir().join(format!(
            "agent-hooks-route-test-{}.json",
            std::process::id()
        ));
        let app = App {
            store: TriggerStore::load(path.clone()).unwrap(),
            secret: None,
        };
        let (status, body) = route(&app, "GET", "/health", &[], "");
        assert_eq!(status, 200);
        assert_eq!(body["ok"], true);
        let _ = std::fs::remove_file(path);
    }
}
