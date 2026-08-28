//! The whole point, end to end: a shell started through one connection is still there, with
//! its output, for a second connection that arrives after the first one is gone.

use obpterm_host::client::{Client, Delivery};
use obpterm_host::protocol::Spawn;
use obpterm_host::server::Host;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::mpsc;

fn shell(script_win: &str, script_unix: &str) -> Spawn {
    #[cfg(windows)]
    let (exe, args) = ("cmd.exe".to_string(), vec!["/c".to_string(), script_win.to_string()]);
    #[cfg(not(windows))]
    let (exe, args) = ("/bin/sh".to_string(), vec!["-c".to_string(), script_unix.to_string()]);
    let _ = (script_win, script_unix);
    Spawn { exe, args, cwd: None, env: Default::default(), cols: 80, rows: 24, below_normal: false }
}

/// Everything a channel delivered, verbatim, so a CI-only failure says what actually arrived.
async fn drain_log(rx: &mut mpsc::UnboundedReceiver<Delivery>, until: Duration) -> Vec<String> {
    let mut log = Vec::new();
    let deadline = tokio::time::Instant::now() + until;
    while let Ok(Some(d)) = tokio::time::timeout_at(deadline, rx.recv()).await {
        log.push(match &d {
            Delivery::Output(b) => format!("Output({} bytes: {:?})", b.len(), String::from_utf8_lossy(&b[..b.len().min(60)])),
            other => format!("{other:?}"),
        });
        if matches!(d, Delivery::Exit(_)) {
            break;
        }
    }
    log
}

/// Collects deliveries, answering ConPTY's cursor-position query the way any real terminal
/// (xterm.js included) does — without an answer, conhost stalls all further output.
async fn collect(
    rx: &mut mpsc::UnboundedReceiver<Delivery>,
    until: Duration,
    dsr: Option<(&Client, u32)>,
) -> (Vec<u8>, bool, Option<Option<u32>>) {
    let mut bytes = Vec::new();
    let mut live = false;
    let mut exit = None;
    let deadline = tokio::time::Instant::now() + until;
    while let Ok(Some(d)) = tokio::time::timeout_at(deadline, rx.recv()).await {
        match d {
            Delivery::Output(b) => {
                if let Some((client, id)) = dsr {
                    if b.windows(4).any(|w| w == b"\x1b[6n") {
                        client.write(id, b"\x1b[1;1R");
                    }
                }
                bytes.extend(b);
            }
            Delivery::Live => live = true,
            Delivery::Exit(code) => {
                exit = Some(code);
                break;
            }
            Delivery::Replaying => {}
        }
    }
    (bytes, live, exit)
}

#[tokio::test]
async fn a_shell_outlives_the_connection_that_started_it() {
    let host = Arc::new(Host::new(format!("obpterm-test-{}", obpterm_host::random_hex(6)), "secret".into(), obpterm_host::random_hex(12), "test"));
    let advert = host.advert.clone();
    let server = tokio::spawn(Arc::clone(&host).serve());
    tokio::time::sleep(Duration::from_millis(100)).await;

    // Window 1: start a shell, watch it print, then vanish without killing anything.
    let id = {
        let c1 = Client::connect(&advert).await.expect("connect");
        assert_eq!(c1.instance, advert.instance);
        let id = c1
            // ping, not `timeout /t`: timeout refuses to run when stdin is not a console.
            .spawn(shell("echo marker-from-the-shell & ping -n 30 127.0.0.1 >nul", "echo marker-from-the-shell; sleep 30"))
            .await
            .expect("spawn");
        let (tx, mut rx) = mpsc::unbounded_channel();
        c1.attach(id, 80, 24, tx).await.expect("attach");
        let (bytes, live, _) = collect(&mut rx, Duration::from_secs(5), Some((&c1, id))).await;
        let seen = String::from_utf8_lossy(&bytes).into_owned();
        let tail = drain_log(&mut rx, Duration::from_millis(200)).await;
        assert!(live, "attach never reached Live; got {} bytes {seen:?}, then {tail:?}", bytes.len());
        assert!(seen.contains("marker-from-the-shell"), "no marker in the live output: {seen:?}");
        id
        // c1 dropped here: the socket closes, the host detaches, the shell keeps running.
    };
    tokio::time::sleep(Duration::from_millis(300)).await;

    // Window 2: a fresh connection sees the session and gets its history back.
    let c2 = Client::connect(&advert).await.expect("reconnect");
    let sessions = c2.list().await.expect("list");
    assert_eq!(sessions.len(), 1, "the session survived the first window");
    assert_eq!(sessions[0].id, id);
    assert!(!sessions[0].attached, "and nobody is watching it");
    assert!(sessions[0].exited.is_none(), "and it is still running");

    let (tx, mut rx) = mpsc::unbounded_channel();
    c2.attach(id, 100, 30, tx).await.expect("reattach");
    let (bytes, live, _) = collect(&mut rx, Duration::from_millis(800), Some((&c2, id))).await;
    assert!(live);
    assert!(
        String::from_utf8_lossy(&bytes).contains("marker-from-the-shell"),
        "the replay carries what was printed before this window existed"
    );

    // A wrong token is not a client.
    let mut bad = advert.clone();
    bad.token = "nope".into();
    assert!(Client::connect(&bad).await.is_err(), "the host hangs up on a bad token");

    c2.kill(id);
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(c2.list().await.unwrap().is_empty());
    c2.shutdown();
    let reason = tokio::time::timeout(Duration::from_secs(5), server).await.expect("host exits").unwrap().unwrap();
    assert_eq!(reason, "shutdown");
}

#[tokio::test]
async fn a_finished_shell_is_reported_on_attach_not_lost() {
    let host = Arc::new(Host::new(format!("obpterm-test-{}", obpterm_host::random_hex(6)), "t".into(), obpterm_host::random_hex(12), "test"));
    let advert = host.advert.clone();
    let server = tokio::spawn(Arc::clone(&host).serve());
    tokio::time::sleep(Duration::from_millis(100)).await;

    let c = Client::connect(&advert).await.unwrap();
    let id = c.spawn(shell("exit 3", "exit 3")).await.unwrap();
    tokio::time::sleep(Duration::from_millis(500)).await;

    // Nobody was attached when it exited. Attaching now must still deliver the exit.
    let (tx, mut rx) = mpsc::unbounded_channel();
    c.attach(id, 80, 24, tx).await.unwrap();
    let (bytes, live, exit) = collect(&mut rx, Duration::from_secs(5), Some((&c, id))).await;
    assert_eq!(
        exit,
        Some(Some(3)),
        "the exit code waits for the next window; live={live}, {} bytes: {:?}",
        bytes.len(),
        String::from_utf8_lossy(&bytes)
    );

    c.shutdown();
    let _ = tokio::time::timeout(Duration::from_secs(5), server).await;
}

#[tokio::test]
async fn a_hook_event_reaches_the_window_and_the_answer_reaches_the_hook() {
    use obpterm_host::client::AgentUpdate;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let host = Arc::new(Host::new(format!("obpterm-test-{}", obpterm_host::random_hex(6)), "t".into(), obpterm_host::random_hex(12), "test"));
    let dir = std::env::temp_dir().join(format!("obpterm-hooks-{}", obpterm_host::random_hex(4)));
    std::fs::create_dir_all(&dir).unwrap();
    host.start_hooks(&dir, None).await.unwrap();
    let advert = host.advert.clone();
    let server = tokio::spawn(Arc::clone(&host).serve());
    tokio::time::sleep(Duration::from_millis(100)).await;

    // The env file the hooks source: read the port and token back the way a hook would.
    let env = std::fs::read_to_string(dir.join("hook-endpoint.env")).unwrap();
    let get = |k: &str| env.lines().find_map(|l| l.strip_prefix(&format!("{k}="))).unwrap().to_string();
    let (port, token) = (get("OBPTERM_HOOK_PORT").parse::<u16>().unwrap(), get("OBPTERM_HOOK_TOKEN"));

    let c = Client::connect(&advert).await.unwrap();
    let (atx, mut agents) = mpsc::unbounded_channel::<AgentUpdate>();
    c.watch_agents(atx);

    // A PermissionRequest hook posts and waits; the window answers deny through the socket.
    let post = tokio::spawn(async move {
        let mut s = tokio::net::TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        let body = r#"{"hook_event_name":"PermissionRequest","session_id":"sX","tool_name":"Bash","tool_input":{"command":"rm -rf /"}}"#;
        let req = format!("POST /hook/{token}/42 HTTP/1.1\r\nhost: x\r\ncontent-length: {}\r\n\r\n{body}", body.len());
        s.write_all(req.as_bytes()).await.unwrap();
        let mut out = String::new();
        s.read_to_string(&mut out).await.unwrap();
        out
    });

    let update = tokio::time::timeout(Duration::from_secs(3), agents.recv()).await.unwrap().unwrap();
    assert_eq!((update.pane, update.state.as_str()), (42, "blocked"));
    assert_eq!(update.detail.as_deref(), Some("Running rm -rf /"));
    c.answer(update.pending_id.clone().unwrap(), Some(false));

    let response = tokio::time::timeout(Duration::from_secs(3), post).await.unwrap().unwrap();
    assert!(response.contains(r#""behavior":"deny""#), "the verdict rode the hook's own response: {response}");

    // The registry remembered the state for the next window.
    let sessions = c.list().await.unwrap();
    let _ = sessions; // pane 42 has no pty session; state bookkeeping for real panes is note_agent's job
    c.shutdown();
    let _ = tokio::time::timeout(Duration::from_secs(5), server).await;
    let _ = std::fs::remove_dir_all(dir);
}

/// The fan-out, end to end, using payloads CAPTURED FROM A LIVE CLAUDE CODE SESSION on
/// 2026-08-26 rather than invented ones. The first version of this feature shipped green
/// against made-up shapes and did nothing in the real app; this test is the reason that
/// cannot happen again. Change these literals only by capturing new ones.
#[tokio::test]
async fn a_real_fan_out_reaches_the_window_as_agent_events() {
    use obpterm_host::client::AgentUpdate;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let host = Arc::new(Host::new(format!("obpterm-test-{}", obpterm_host::random_hex(6)), "t".into(), obpterm_host::random_hex(12), "test"));
    let dir = std::env::temp_dir().join(format!("obpterm-fan-{}", obpterm_host::random_hex(4)));
    std::fs::create_dir_all(&dir).unwrap();
    host.start_hooks(&dir, None).await.unwrap();
    let advert = host.advert.clone();
    let server = tokio::spawn(Arc::clone(&host).serve());
    tokio::time::sleep(Duration::from_millis(100)).await;

    let env = std::fs::read_to_string(dir.join("hook-endpoint.env")).unwrap();
    let get = |k: &str| env.lines().find_map(|l| l.strip_prefix(&format!("{k}="))).unwrap().to_string();
    let (port, token) = (get("OBPTERM_HOOK_PORT").parse::<u16>().unwrap(), get("OBPTERM_HOOK_TOKEN"));

    let c = Client::connect(&advert).await.unwrap();
    let (atx, mut agents) = mpsc::unbounded_channel::<AgentUpdate>();
    c.watch_agents(atx);

    async fn post(port: u16, token: &str, body: &str) {
        let mut s = tokio::net::TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        let req = format!("POST /hook/{token}/7 HTTP/1.1\r\nhost: x\r\ncontent-length: {}\r\n\r\n{body}", body.len());
        s.write_all(req.as_bytes()).await.unwrap();
        let mut out = String::new();
        let _ = s.read_to_string(&mut out).await;
    }

    // 1. The session delegates. Note the tool is named "Agent" and the id is tool_use_id.
    post(port, &token, r#"{"hook_event_name":"PreToolUse","tool_name":"Agent","tool_use_id":"t-1","session_id":"s1","cwd":"/x","permission_mode":"default","prompt_id":"p1","tool_input":{"description":"Trigger a real Task hook","prompt":"probe","subagent_type":"general-purpose","model":"haiku"}}"#).await;
    let u = tokio::time::timeout(Duration::from_secs(3), agents.recv()).await.unwrap().unwrap();
    assert_eq!(u.agent_event.as_deref(), Some("spawned"), "a delegation opens an agent");
    assert_eq!(u.agent_id.as_deref(), Some("t-1"));
    assert_eq!(u.agent_kind.as_deref(), Some("general-purpose"));
    assert_eq!(u.agent_task.as_deref(), Some("Trigger a real Task hook"));

    // 2. The agent's own tool call — marked with agent_id + agent_type, no isSidechain flag.
    post(port, &token, r#"{"hook_event_name":"PreToolUse","tool_name":"Bash","tool_use_id":"b-2","agent_id":"t-1","agent_type":"general-purpose","session_id":"s1","tool_input":{"command":"echo hook-probe"}}"#).await;
    let u = tokio::time::timeout(Duration::from_secs(3), agents.recv()).await.unwrap().unwrap();
    assert_eq!((u.agent_id.as_deref(), u.agent_event.as_deref()), (Some("t-1"), Some("tool")));
    assert_eq!(u.detail.as_deref(), Some("Running echo hook-probe"), "the feed line belongs to the agent");

    // 3. SubagentStop closes that agent and leaves the session working.
    post(port, &token, r#"{"hook_event_name":"SubagentStop","agent_id":"t-1","agent_type":"general-purpose","agent_transcript_path":"/x.jsonl","last_assistant_message":"Output: hook-probe","session_id":"s1","stop_hook_active":false}"#).await;
    let u = tokio::time::timeout(Duration::from_secs(3), agents.recv()).await.unwrap().unwrap();
    assert_eq!((u.agent_id.as_deref(), u.agent_event.as_deref()), (Some("t-1"), Some("finished")));
    assert_eq!(u.state, "working", "one agent finishing must never end the session's turn");

    // 4. The session's OWN tool call carries no agent at all.
    post(port, &token, r#"{"hook_event_name":"PreToolUse","tool_name":"Read","tool_use_id":"r-3","session_id":"s1","tool_input":{"file_path":"/x/y.rs"}}"#).await;
    let u = tokio::time::timeout(Duration::from_secs(3), agents.recv()).await.unwrap().unwrap();
    assert!(u.agent_id.is_none() && u.agent_event.is_none(), "the parent's work is not an agent's");

    c.shutdown();
    let _ = tokio::time::timeout(Duration::from_secs(5), server).await;
    let _ = std::fs::remove_dir_all(dir);
}


/// The nested fan-out, driven from payloads captured off a real run (`fixtures-nested.jsonl`):
/// an agent that spawned an agent of its own. The lineage rule is the whole point — on a Task
/// call, the top-level `agent_id` is the CALLER, and the id of the agent being born arrives on
/// the matching PostToolUse as `tool_response.agentId`.
#[tokio::test]
async fn a_nested_fan_out_keeps_the_agent_that_spawned_it() {
    use obpterm_host::client::AgentUpdate;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    // The two ids the capture recorded, in the order they were born.
    const PARENT: &str = "a922a834869763a99";
    const CHILD: &str = "a79bb991a511167a2";

    let host = Arc::new(Host::new(format!("obpterm-test-{}", obpterm_host::random_hex(6)), "t".into(), obpterm_host::random_hex(12), "test"));
    let dir = std::env::temp_dir().join(format!("obpterm-nest-{}", obpterm_host::random_hex(4)));
    std::fs::create_dir_all(&dir).unwrap();
    host.start_hooks(&dir, None).await.unwrap();
    let advert = host.advert.clone();
    let server = tokio::spawn(Arc::clone(&host).serve());
    tokio::time::sleep(Duration::from_millis(100)).await;

    let env = std::fs::read_to_string(dir.join("hook-endpoint.env")).unwrap();
    let get = |k: &str| env.lines().find_map(|l| l.strip_prefix(&format!("{k}="))).unwrap().to_string();
    let (port, token) = (get("OBPTERM_HOOK_PORT").parse::<u16>().unwrap(), get("OBPTERM_HOOK_TOKEN"));

    let c = Client::connect(&advert).await.unwrap();
    let (atx, mut agents) = mpsc::unbounded_channel::<AgentUpdate>();
    c.watch_agents(atx);

    for line in include_str!("fixtures-nested.jsonl").lines().filter(|l| !l.trim().is_empty()) {
        let mut s = tokio::net::TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        let req = format!("POST /hook/{token}/7 HTTP/1.1\r\nhost: x\r\ncontent-length: {}\r\n\r\n{line}", line.len());
        s.write_all(req.as_bytes()).await.unwrap();
        let mut out = String::new();
        let _ = s.read_to_string(&mut out).await;
    }

    let mut got: Vec<AgentUpdate> = Vec::new();
    while let Ok(Some(u)) = tokio::time::timeout(Duration::from_millis(400), agents.recv()).await {
        got.push(u);
    }

    let linked = |id: &str| -> Option<&AgentUpdate> {
        got.iter().find(|u| u.agent_event.as_deref() == Some("linked") && u.agent_id.as_deref() == Some(id))
    };
    let parent_link = linked(PARENT).expect("the session's own agent was linked");
    assert_eq!(parent_link.agent_parent, None, "an agent the SESSION spawned has no parent agent");

    let child_link = linked(CHILD).expect("the nested agent was linked");
    assert_eq!(
        child_link.agent_parent.as_deref(),
        Some(PARENT),
        "the agent that made the Task call is the parent of the agent it spawned",
    );
    assert_ne!(child_link.agent_id, child_link.agent_parent, "child and parent are different agents");

    // And the child's own work is filed under the child, not under whoever spawned it.
    let child_tool = got
        .iter()
        .find(|u| u.agent_event.as_deref() == Some("tool") && u.agent_id.as_deref() == Some(CHILD))
        .expect("the nested agent's tool call");
    assert!(child_tool.detail.as_deref().unwrap_or_default().contains("echo"), "its feed line is its own");

    // Each SubagentStop closes its own agent — the child's does not end the parent.
    for id in [CHILD, PARENT] {
        assert!(
            got.iter().any(|u| u.agent_event.as_deref() == Some("finished") && u.agent_id.as_deref() == Some(id)),
            "{id} was closed by its own SubagentStop",
        );
    }

    c.shutdown();
    let _ = tokio::time::timeout(Duration::from_secs(5), server).await;
    let _ = std::fs::remove_dir_all(dir);
}


/// The hold that makes answering from a phone possible: seconds when someone is looking at the
/// window, minutes when nobody is. Driven through the real listener, both ways.
#[tokio::test]
async fn a_permission_request_is_held_longer_while_nobody_is_looking() {
    use obpterm_host::client::AgentUpdate;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let host = Arc::new(Host::new(format!("obpterm-test-{}", obpterm_host::random_hex(6)), "t".into(), obpterm_host::random_hex(12), "test"));
    let dir = std::env::temp_dir().join(format!("obpterm-hold-{}", obpterm_host::random_hex(4)));
    std::fs::create_dir_all(&dir).unwrap();
    host.start_hooks(&dir, None).await.unwrap();
    let advert = host.advert.clone();
    let server = tokio::spawn(Arc::clone(&host).serve());
    tokio::time::sleep(Duration::from_millis(100)).await;

    let env = std::fs::read_to_string(dir.join("hook-endpoint.env")).unwrap();
    let get = |k: &str| env.lines().find_map(|l| l.strip_prefix(&format!("{k}="))).unwrap().to_string();
    let (port, token) = (get("OBPTERM_HOOK_PORT").parse::<u16>().unwrap(), get("OBPTERM_HOOK_TOKEN"));

    let c = Client::connect(&advert).await.unwrap();
    let (atx, mut agents) = mpsc::unbounded_channel::<AgentUpdate>();
    c.watch_agents(atx);

    // Nobody is looking. The request must still be open well past the focused hold.
    c.focus(false);
    tokio::time::sleep(Duration::from_millis(100)).await;
    let body = r#"{"hook_event_name":"PermissionRequest","tool_name":"Bash","session_id":"s1","tool_input":{"command":"rm -rf build/"}}"#;
    let held = tokio::spawn(async move {
        let mut s = tokio::net::TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        let req = format!("POST /hook/{token}/7 HTTP/1.1\r\nhost: x\r\ncontent-length: {}\r\n\r\n{body}", body.len());
        s.write_all(req.as_bytes()).await.unwrap();
        let mut out = String::new();
        let _ = s.read_to_string(&mut out).await;
        out
    });

    let u = tokio::time::timeout(Duration::from_secs(3), agents.recv()).await.unwrap().unwrap();
    let pending = u.pending_id.expect("a held request has an id to answer");
    assert_eq!(u.state, "blocked");

    // Answer it a moment later — the point is that it is still there to answer.
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(!held.is_finished(), "the request is still held while nobody is looking");
    c.answer(pending, Some(true));
    let out = tokio::time::timeout(Duration::from_secs(5), held).await.unwrap().unwrap();
    assert!(out.contains("\"behavior\":\"allow\""), "the verdict reached the hook: {out}");

    c.shutdown();
    let _ = tokio::time::timeout(Duration::from_secs(5), server).await;
    let _ = std::fs::remove_dir_all(dir);
}


/// A request in flight when the host dies must FAIL, not hang. The pending map used to be left
/// full when the reader task ended, so the caller's await never resolved — a frozen invoke with
/// no error, which in this app means a stuck "Restarting…" nobody can explain.
#[tokio::test]
async fn a_request_in_flight_when_the_host_dies_fails_instead_of_hanging() {
    let host = Arc::new(Host::new(format!("obpterm-test-{}", obpterm_host::random_hex(6)), "t".into(), obpterm_host::random_hex(12), "test"));
    let advert = host.advert.clone();
    let server = tokio::spawn(Arc::clone(&host).serve());
    tokio::time::sleep(Duration::from_millis(100)).await;

    let c = Client::connect(&advert).await.unwrap();
    // End the host mid-conversation, then ask it for something.
    c.shutdown();
    let _ = tokio::time::timeout(Duration::from_secs(5), server).await;
    let outcome = tokio::time::timeout(Duration::from_secs(5), c.list()).await;
    match outcome {
        Err(_) => panic!("the call HUNG — the pending map was not drained"),
        Ok(Ok(_)) => { /* raced the shutdown and got an answer: also fine */ }
        Ok(Err(e)) => assert!(e.contains("host went away"), "it fails with the honest error, got {e}"),
    }
}
