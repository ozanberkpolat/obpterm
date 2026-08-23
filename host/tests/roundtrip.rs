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
    Spawn { exe, args, cwd: None, env: Default::default(), cols: 80, rows: 24 }
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
    let host = Arc::new(Host::new(format!("obpterm-test-{}", obpterm_host::random_hex(6)), "secret".into(), "test"));
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
    let host = Arc::new(Host::new(format!("obpterm-test-{}", obpterm_host::random_hex(6)), "t".into(), "test"));
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
