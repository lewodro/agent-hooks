use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use std::{
    collections::HashSet,
    env, fs,
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    path::PathBuf,
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};

type HmacSha256 = Hmac<Sha256>;

#[derive(Clone, Debug, Deserialize, Serialize)]
struct Trigger {
    id: String,
    #[serde(default)]
    program_id: Option<String>,
    #[serde(default)]
    event_kind: Option<String>,
    #[serde(default)]
    min_ltv_bps: Option<u32>,
    #[serde(default = "enabled")]
    enabled: bool,
}

fn enabled() -> bool {
    true
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct Observation {
    signature: String,
    slot: u64,
    program_id: String,
    #[serde(default)]
    event_kind: Option<String>,
    #[serde(default)]
    ltv_bps: Option<u32>,
    #[serde(default)]
    payload: serde_json::Value,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct WakeJob {
    id: String,
    trigger_id: String,
    observation: Observation,
    status: String,
    created_at: u64,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
struct State {
    triggers: Vec<Trigger>,
    jobs: Vec<WakeJob>,
    claimed: HashSet<String>,
    last_slot: u64,
}

#[derive(Clone)]
struct App {
    state: Arc<Mutex<State>>,
    state_file: PathBuf,
    secret: Option<String>,
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let bind = env::var("TRIGGER_BIND").unwrap_or_else(|_| "127.0.0.1:8787".into());
    let state_file = PathBuf::from(
        env::var("TRIGGER_STATE_FILE").unwrap_or_else(|_| "./trigger-state.json".into()),
    );
    let secret = env::var("TRIGGER_WEBHOOK_SECRET").ok();
    let state = load_state(&state_file)?;
    let app = App {
        state: Arc::new(Mutex::new(state)),
        state_file,
        secret,
    };
    let listener = TcpListener::bind(&bind)?;
    println!("agent-hooks trigger service listening on http://{bind}");
    for stream in listener.incoming() {
        match stream {
            Ok(stream) => {
                let app = app.clone();
                std::thread::spawn(move || {
                    if let Err(error) = handle(stream, app) {
                        eprintln!("request failed: {error}");
                    }
                });
            }
            Err(error) => eprintln!("connection failed: {error}"),
        }
    }
    Ok(())
}

fn handle(mut stream: TcpStream, app: App) -> Result<(), Box<dyn std::error::Error>> {
    let request = read_request(&mut stream)?;
    let (method, path, headers, body) = request;
    let (status, response) = match (method.as_str(), path.as_str()) {
        ("GET", "/health") => (
            200,
            serde_json::json!({"ok": true, "service": "trigger-hooks", "mode": "mock"}),
        ),
        ("GET", "/v1/triggers") => {
            let state = app.state.lock().unwrap();
            (200, serde_json::json!(state.triggers))
        }
        ("POST", "/v1/triggers") => {
            let trigger: Trigger = serde_json::from_str(&body)?;
            let mut state = app.state.lock().unwrap();
            if state.triggers.iter().any(|item| item.id == trigger.id) {
                (409, serde_json::json!({"error": "trigger already exists"}))
            } else {
                state.triggers.push(trigger.clone());
                persist(&app, &state)?;
                (201, serde_json::json!(trigger))
            }
        }
        ("GET", "/v1/jobs") => {
            let state = app.state.lock().unwrap();
            (200, serde_json::json!(state.jobs))
        }
        ("POST", "/v1/observations") => ingest(&app, &headers, &body)?,
        _ => (404, serde_json::json!({"error": "not found"})),
    };
    write_response(&mut stream, status, &response.to_string())?;
    Ok(())
}

fn ingest(
    app: &App,
    headers: &[(String, String)],
    body: &str,
) -> Result<(u16, serde_json::Value), Box<dyn std::error::Error>> {
    if let Some(secret) = &app.secret {
        let timestamp =
            header(headers, "x-agent-hooks-timestamp").ok_or("missing webhook timestamp")?;
        let signature =
            header(headers, "x-agent-hooks-signature").ok_or("missing webhook signature")?;
        verify_signature(secret, &timestamp, body, &signature)?;
    }
    let observation: Observation = serde_json::from_str(body)?;
    let mut state = app.state.lock().unwrap();
    state.last_slot = state.last_slot.max(observation.slot);
    let mut jobs = Vec::new();
    for trigger in state.triggers.clone() {
        if !trigger.enabled || !matches(&trigger, &observation) {
            continue;
        }
        let dedupe = format!("{}:{}", trigger.id, observation.signature);
        if !state.claimed.insert(dedupe.clone()) {
            continue;
        }
        let job = WakeJob {
            id: dedupe,
            trigger_id: trigger.id,
            observation: observation.clone(),
            status: "queued".into(),
            created_at: now(),
        };
        state.jobs.push(job.clone());
        jobs.push(job);
    }
    persist(app, &state)?;
    Ok((
        202,
        serde_json::json!({"accepted": true, "jobs": jobs, "last_slot": state.last_slot}),
    ))
}

fn matches(trigger: &Trigger, observation: &Observation) -> bool {
    trigger
        .program_id
        .as_ref()
        .map_or(true, |id| id == &observation.program_id)
        && trigger
            .event_kind
            .as_ref()
            .map_or(true, |kind| observation.event_kind.as_ref() == Some(kind))
        && trigger
            .min_ltv_bps
            .map_or(true, |min| observation.ltv_bps.unwrap_or(0) >= min)
}

fn verify_signature(
    secret: &str,
    timestamp: &str,
    body: &str,
    provided: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    let timestamp: u64 = timestamp.parse()?;
    if now().abs_diff(timestamp) > 300 {
        return Err("webhook timestamp is too old".into());
    }
    let mut mac = HmacSha256::new_from_slice(secret.as_bytes())?;
    mac.update(format!("{timestamp}.{body}").as_bytes());
    let expected = format!("sha256={}", hex(mac.finalize().into_bytes().as_slice()));
    if expected != provided {
        return Err("invalid webhook signature".into());
    }
    Ok(())
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}
fn header(headers: &[(String, String)], name: &str) -> Option<String> {
    headers
        .iter()
        .find(|(key, _)| key.eq_ignore_ascii_case(name))
        .map(|(_, value)| value.clone())
}

fn load_state(path: &PathBuf) -> Result<State, Box<dyn std::error::Error>> {
    match fs::read_to_string(path) {
        Ok(contents) => Ok(serde_json::from_str(&contents)?),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(State::default()),
        Err(error) => Err(error.into()),
    }
}

fn persist(app: &App, state: &State) -> Result<(), Box<dyn std::error::Error>> {
    let temp = app.state_file.with_extension("tmp");
    let contents = serde_json::to_vec_pretty(state)?;
    fs::write(&temp, contents)?;
    fs::rename(temp, &app.state_file)?;
    Ok(())
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
    let reason = if status < 300 {
        "OK"
    } else if status == 404 {
        "Not Found"
    } else if status == 409 {
        "Conflict"
    } else {
        "Accepted"
    };
    write!(stream, "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len())?;
    Ok(())
}
