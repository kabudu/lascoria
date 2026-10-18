use super::*;
use std::{
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

struct Fixture {
    root: PathBuf,
    db: SharedDb,
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}
async fn fixture() -> Fixture {
    let root = std::env::temp_dir().join(format!("lascoria-decisions-{}", uuid::Uuid::new_v4()));
    let repo = root.join("repo");
    std::fs::create_dir_all(&repo).unwrap();
    for args in [
        vec!["init", "-q"],
        vec!["add", "."],
        vec![
            "-c",
            "user.name=Fixture",
            "-c",
            "user.email=fixture@example.test",
            "commit",
            "-qm",
            "Fixture",
        ],
    ] {
        if args[0] == "add" {
            std::fs::write(repo.join("code.txt"), "before\n").unwrap();
        }
        assert!(
            std::process::Command::new("git")
                .args(args)
                .current_dir(&repo)
                .status()
                .unwrap()
                .success()
        );
    }
    std::fs::write(repo.join("code.txt"), "after\n").unwrap();
    let db = Arc::new(Mutex::new(Db::open(&root.join("journal.sqlite")).unwrap()));
    db.lock()
        .unwrap()
        .put(
            "sessions",
            "session-a",
            &json!({"id":"session-a","workspace":repo,"lifecycle":"connected"}),
        )
        .unwrap();
    let mut capture = review::capture(&repo).await.unwrap();
    capture["id"] = json!("capture-a");
    capture["sessionId"] = json!("session-a");
    capture["revision"] = json!(1);
    db.lock()
        .unwrap()
        .put("artifacts", "capture-a", &capture)
        .unwrap();
    Fixture { root, db }
}
fn params(provider: &str) -> Value {
    json!({"provider":provider,"sessionId":"session-a","artifactId":"capture-a","question":{"type":"predicate","prompt":"Does the diff replace before with after?"}})
}
async fn enable(service: &Service, db: SharedDb, provider: &str) {
    let revision = config(&db.lock().unwrap()).unwrap()["revision"].clone();
    service.handle(db.clone(),"decision/setKey",&json!({"provider":provider,"expectedRevision":revision,"apiKey":"fixture-decision-credential"}),"key").await.unwrap();
    let revision = config(&db.lock().unwrap()).unwrap()["revision"].clone();
    service.handle(db,"decision/configure",&json!({"provider":provider,"expectedRevision":revision,"model":super::provider(provider).unwrap().2,"enabled":true,"sessionId":"session-a","workspaceEnabled":true}),"configure").await.unwrap();
}
struct Server {
    url: String,
    calls: Arc<AtomicUsize>,
    task: tokio::task::JoinHandle<()>,
}
impl Drop for Server {
    fn drop(&mut self) {
        self.task.abort();
    }
}
async fn server(response: Value, delay_ms: u64, expected: Option<Value>, code: u16) -> Server {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let calls = Arc::new(AtomicUsize::new(0));
    let count = calls.clone();
    let task = tokio::spawn(async move {
        loop {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut bytes = Vec::new();
            let header_end = loop {
                let mut chunk = [0u8; 2048];
                let n = socket.read(&mut chunk).await.unwrap();
                assert!(n > 0 && bytes.len() + n < 64_000);
                bytes.extend_from_slice(&chunk[..n]);
                if let Some(index) = bytes.windows(4).position(|b| b == b"\r\n\r\n") {
                    break index + 4;
                }
            };
            let header = String::from_utf8_lossy(&bytes[..header_end]);
            let length: usize = header
                .lines()
                .find_map(|line| {
                    line.to_lowercase()
                        .strip_prefix("content-length: ")
                        .map(str::to_owned)
                })
                .unwrap()
                .parse()
                .unwrap();
            assert!(
                header
                    .to_lowercase()
                    .contains("authorization: bearer fixture-decision-credential")
            );
            while bytes.len() - header_end < length {
                let mut chunk = [0u8; 2048];
                let n = socket.read(&mut chunk).await.unwrap();
                assert!(n > 0);
                bytes.extend_from_slice(&chunk[..n]);
            }
            let body: Value =
                serde_json::from_slice(&bytes[header_end..header_end + length]).unwrap();
            if let Some(expected) = &expected {
                assert_eq!(&body, expected);
            }
            count.fetch_add(1, Ordering::SeqCst);
            tokio::time::sleep(Duration::from_millis(delay_ms)).await;
            let body = response.to_string();
            let header = format!(
                "HTTP/1.1 {code} OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nX-Request-Id: provider-fixture-1\r\nConnection: close\r\n\r\n",
                body.len()
            );
            let _ = socket.write_all(header.as_bytes()).await;
            let _ = socket.write_all(body.as_bytes()).await;
        }
    });
    Server { url, calls, task }
}
fn response(provider: &str) -> Value {
    if provider == "openai" {
        json!({"model":"gpt-6-luna","answers":[{"name":"review","type":"predicate","probability":0.9}],"usage":{"input_tokens":12,"output_tokens":0,"total_tokens":12}})
    } else {
        json!({"model":super::provider(provider).unwrap().2,"answers":{"review":{"type":"noul","noul":0.9}},"usage":{"input_tokens":12,"output_tokens":2}})
    }
}

#[test]
fn independent_wire_contracts_preserve_all_native_question_and_answer_types() {
    let predicate = json!({"type":"predicate","prompt":"Question"});
    let choice = json!({"type":"choice","prompt":"Question","options":["A","B"]});
    let score = json!({"type":"score","prompt":"Question","options":["Low","High"]});
    assert_eq!(
        body("openai", "gpt-6-luna", "Evidence", &predicate),
        json!({"model":"gpt-6-luna","input":"Evidence","questions":[{"name":"review","type":"predicate","instructions":"Question"}]})
    );
    assert_eq!(
        body("openai", "gpt-6-luna", "Evidence", &choice)["questions"][0]["choices"],
        json!([{"value":"option_0","description":"A"},{"value":"option_1","description":"B"}])
    );
    assert_eq!(
        body("openai", "gpt-6-luna", "Evidence", &score)["questions"][0]["levels"],
        json!([{"label":"level_0","description":"Low"},{"label":"level_1","description":"High"}])
    );
    for provider in ["jev", "subq"] {
        assert_eq!(
            body(provider, "model", "Evidence", &predicate),
            json!({"model":"model","state":"Evidence","questions":{"review":{"type":"noul","instructions":"Question","criteria":{"true":"The supplied evidence supports yes","false":"The supplied evidence supports no"}}}})
        );
        assert_eq!(
            body(provider, "model", "Evidence", &choice)["questions"]["review"]["criteria"],
            json!({"option_0":"A","option_1":"B"})
        );
        assert_eq!(
            body(provider, "model", "Evidence", &score)["questions"]["review"]["criteria"],
            json!(["Low", "High"])
        );
    }
    for provider in IDS {
        assert!(validated(provider, &response(provider), &predicate).is_ok());
        let choice_answer = if provider == "openai" {
            json!({"type":"choice","name":"review","choice":"option_0","confidence":0.8,"probabilities":[{"value":"option_0","probability":0.9},{"value":"option_1","probability":0.1}]})
        } else {
            json!({"type":"choice","choice":"option_0","confidence":0.8,"probabilities":{"option_0":0.9,"option_1":0.1}})
        };
        let score_answer = if provider == "openai" {
            json!({"type":"score","name":"review","score":0.1,"confidence":0.8,"probabilities":[{"value":0,"label":"level_0","probability":0.9},{"value":1,"label":"level_1","probability":0.1}]})
        } else {
            json!({"type":"score","score":0.1,"confidence":0.8,"probabilities":{"0":0.9,"1":0.1},"legend":{"0":"Low","1":"High"}})
        };
        for (q, answer) in [(&choice, choice_answer), (&score, score_answer)] {
            let wire = json!({"model":"resolved-model","answers":if provider == "openai" {json!([answer.clone()])} else {json!({"review":answer.clone()})}});
            let valid = validated(provider, &wire, q).unwrap();
            assert_eq!(valid["answer"]["probabilities"], answer["probabilities"]);
            let mut malformed = wire.clone();
            if provider == "openai" {
                malformed["answers"][0]["probabilities"][0]["probability"] = json!(1.5);
            } else {
                malformed["answers"]["review"]["confidence"] = json!(-1);
            }
            assert!(validated(provider, &malformed, q).is_err());
        }
    }
    assert!(
        question(&json!({"question":{"type":"choice","prompt":"Q","options":["same","same"]}}))
            .is_err()
    );
    assert!(provider("other").is_err());
}

#[tokio::test]
async fn manual_review_uses_real_http_and_durable_no_replay_for_all_providers() {
    for provider in IDS {
        let f = fixture().await;
        let mut service = Service::new().unwrap();
        enable(&service, f.db.clone(), provider).await;
        let mut p = params(provider);
        let preview = service
            .handle(f.db.clone(), "decision/preview", &p, "preview")
            .await
            .unwrap();
        assert!(preview["input"].as_str().unwrap().contains("+after"));
        let expected = if provider == "openai" {
            json!({"model":"gpt-6-luna","input":preview["input"],"questions":[{"name":"review","type":"predicate","instructions":"Does the diff replace before with after?"}]})
        } else {
            json!({"model":super::provider(provider).unwrap().2,"state":preview["input"],"questions":{"review":{"type":"noul","instructions":"Does the diff replace before with after?","criteria":{"true":"The supplied evidence supports yes","false":"The supplied evidence supports no"}}}})
        };
        let server = server(response(provider), 0, Some(expected), 200).await;
        service.endpoint = Some(server.url.clone());
        p["fingerprint"] = preview["fingerprint"].clone();
        let row = service
            .handle(f.db.clone(), "decision/evaluate", &p, "paid-once")
            .await
            .unwrap();
        assert_eq!(row["status"], "completed");
        assert_eq!(row["result"]["providerRequestId"], "provider-fixture-1");
        let repeated = service
            .handle(f.db.clone(), "decision/evaluate", &p, "paid-once")
            .await
            .unwrap();
        assert_eq!(repeated["reused"], true);
        assert_eq!(server.calls.load(Ordering::SeqCst), 1);
        // Reopening the durable DB and replacing the service cannot resend a paid identity.
        let reopened = Arc::new(Mutex::new(
            Db::open(&f.root.join("journal.sqlite")).unwrap(),
        ));
        let restarted = Service::new().unwrap();
        let recovered = restarted
            .handle(
                reopened,
                "decision/result",
                &json!({"requestId":"paid-once"}),
                "read",
            )
            .await
            .unwrap();
        assert_eq!(recovered["result"], row["result"]);
        assert_eq!(f.db.lock().unwrap().count("commands").unwrap(), 0);
        {
            let database = f.db.lock().unwrap();
            let stored = json!({"settings":database.all("presentation").unwrap(),"decisions":database.all("decisions").unwrap()});
            assert!(!stored.to_string().contains("fixture-decision-credential"));
        }
        assert_eq!(server.calls.load(Ordering::SeqCst), 1);
    }
}

#[tokio::test]
async fn stale_files_and_configuration_never_become_current_advice_and_muse_reads_continue() {
    let f = fixture().await;
    let mut service = Service::new().unwrap();
    enable(&service, f.db.clone(), "openai").await;
    let server = server(response("openai"), 200, None, 200).await;
    service.endpoint = Some(server.url.clone());
    let service = Arc::new(service);
    let mut p = params("openai");
    p["fingerprint"] = service
        .handle(f.db.clone(), "decision/preview", &p, "preview")
        .await
        .unwrap()["fingerprint"]
        .clone();
    let worker = service.clone();
    let db = f.db.clone();
    let job = tokio::spawn(async move {
        worker
            .handle(db, "decision/evaluate", &p, "stale-test")
            .await
            .unwrap()
    });
    tokio::time::timeout(Duration::from_secs(2), async {
        while server.calls.load(Ordering::SeqCst) == 0 {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    assert_eq!(
        f.db.lock()
            .unwrap()
            .get("sessions", "session-a")
            .unwrap()
            .unwrap()["lifecycle"],
        "connected"
    );
    std::fs::write(f.root.join("repo/code.txt"), "changed during evaluation\n").unwrap();
    let revision = config(&f.db.lock().unwrap()).unwrap()["revision"].clone();
    service.handle(f.db.clone(),"decision/configure",&json!({"provider":"openai","expectedRevision":revision,"model":"gpt-6-luna","enabled":false,"sessionId":"session-a","workspaceEnabled":false}),"disable").await.unwrap();
    let row = job.await.unwrap();
    assert_eq!(row["status"], "stale");
    assert_eq!(f.db.lock().unwrap().count("commands").unwrap(), 0);
}

#[tokio::test]
async fn cancellation_and_bad_responses_are_recorded_without_retry_or_credential_reflection() {
    for (payload, delay, code, cancel) in [
        (response("openai"), 500, 200, true),
        (
            json!({"model":"fixture-decision-credential","answers":[{"name":"review","type":"predicate","probability":0.9}],"usage":{"input_tokens":1}}),
            0,
            200,
            false,
        ),
        (json!({"error":"limited"}), 0, 429, false),
        (json!({"large":"x".repeat(RESPONSE_LIMIT)}), 0, 200, false),
    ] {
        let f = fixture().await;
        let mut service = Service::new().unwrap();
        enable(&service, f.db.clone(), "openai").await;
        let server = server(payload, delay, None, code).await;
        service.endpoint = Some(server.url.clone());
        let service = Arc::new(service);
        let mut p = params("openai");
        p["fingerprint"] = service
            .handle(f.db.clone(), "decision/preview", &p, "preview")
            .await
            .unwrap()["fingerprint"]
            .clone();
        let worker = service.clone();
        let db = f.db.clone();
        let job = tokio::spawn(async move {
            worker
                .handle(db, "decision/evaluate", &p, "failure-test")
                .await
                .unwrap()
        });
        tokio::time::timeout(Duration::from_secs(2), async {
            while server.calls.load(Ordering::SeqCst) == 0 {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .unwrap();
        if cancel {
            assert_eq!(
                service
                    .handle(
                        f.db.clone(),
                        "decision/cancel",
                        &json!({"requestId":"failure-test"}),
                        "cancel"
                    )
                    .await
                    .unwrap()["requested"],
                true
            );
        }
        let row = job.await.unwrap();
        assert_eq!(row["status"], if cancel { "cancelled" } else { "failed" });
        assert!(row["result"].is_null());
        assert!(!row.to_string().contains("fixture-decision-credential"));
        assert_eq!(
            service
                .handle(
                    f.db.clone(),
                    "decision/result",
                    &json!({"requestId":"failure-test"}),
                    "read"
                )
                .await
                .unwrap()["reused"],
            true
        );
        assert_eq!(server.calls.load(Ordering::SeqCst), 1);
    }
}
#[tokio::test]
async fn admission_is_bounded_and_unfinished_identities_remain_unknown_after_restart() {
    let f = fixture().await;
    let mut service = Service::new().unwrap();
    enable(&service, f.db.clone(), "openai").await;
    let server = server(response("openai"), 100, None, 200).await;
    service.endpoint = Some(server.url.clone());
    let service = Arc::new(service);
    let mut jobs = Vec::new();
    for name in ["one", "two"] {
        let service = service.clone();
        let db = f.db.clone();
        jobs.push(tokio::spawn(async move {
            service
                .handle(
                    db,
                    "decision/test",
                    &json!({"provider":"openai","admissionEpoch":service.epoch}),
                    name,
                )
                .await
                .unwrap()
        }));
    }
    tokio::time::timeout(Duration::from_secs(2), async {
        while service.active.lock().unwrap().len() < 2 {
            tokio::time::sleep(Duration::from_millis(2)).await;
        }
    })
    .await
    .unwrap();
    let rejected = service
        .handle(
            f.db.clone(),
            "decision/test",
            &json!({"provider":"openai","admissionEpoch":service.epoch}),
            "three",
        )
        .await
        .unwrap_err();
    assert!(rejected.to_string().contains("Two decision requests"));
    let status = service
        .handle(f.db.clone(), "decision/status", &json!({}), "status")
        .await
        .unwrap();
    assert_eq!(status["recent"].as_array().unwrap().len(), 2);
    for job in jobs {
        assert_eq!(job.await.unwrap()["status"], "completed");
    }
    assert_eq!(server.calls.load(Ordering::SeqCst), 2);
    let sending = json!({"id":"interrupted","fingerprint":"original","status":"sending","createdAtMillis":now_ms()});
    save_run(&f.db.lock().unwrap(), sending).unwrap();
    let restarted = Service::new().unwrap();
    let unknown = restarted
        .handle(
            f.db.clone(),
            "decision/result",
            &json!({"requestId":"interrupted"}),
            "read",
        )
        .await
        .unwrap();
    assert_eq!(unknown["status"], "unknown");
    let status = restarted
        .handle(f.db.clone(), "decision/status", &json!({}), "status")
        .await
        .unwrap();
    assert_eq!(status["recent"][0]["status"], "unknown");
    assert_eq!(server.calls.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn workspace_consent_preview_and_preflight_are_required_before_egress() {
    let f = fixture().await;
    let mut service = Service::new().unwrap();
    let server = server(response("openai"), 0, None, 200).await;
    service.endpoint = Some(server.url.clone());
    let mut p = params("openai");
    assert!(
        service
            .handle(f.db.clone(), "decision/preview", &p, "preview")
            .await
            .is_err()
    );
    enable(&service, f.db.clone(), "openai").await;
    let preview = service
        .handle(f.db.clone(), "decision/preview", &p, "preview")
        .await
        .unwrap();
    p["fingerprint"] = json!("not-the-reviewed-preview");
    assert!(
        service
            .handle(f.db.clone(), "decision/evaluate", &p, "bad-preview")
            .await
            .is_err()
    );
    p["fingerprint"] = preview["fingerprint"].clone();
    std::fs::write(
        f.root.join("repo/code.txt"),
        "new content
",
    )
    .unwrap();
    assert!(
        service
            .handle(f.db.clone(), "decision/evaluate", &p, "old-files")
            .await
            .is_err()
    );
    assert_eq!(server.calls.load(Ordering::SeqCst), 0);
    assert!(runs(&f.db.lock().unwrap()).unwrap().is_empty());
    assert_eq!(
        service
            .handle(
                f.db.clone(),
                "decision/cancel",
                &json!({"requestId":"not-started"}),
                "cancel"
            )
            .await
            .unwrap()["requested"],
        false
    );
    assert!(service.active.lock().unwrap().is_empty());
}

#[tokio::test]
async fn credential_rotation_revokes_workspace_consent_and_old_disclosure() {
    let f = fixture().await;
    let service = Service::new().unwrap();
    enable(&service, f.db.clone(), "openai").await;
    let mut p = params("openai");
    let preview = service
        .handle(f.db.clone(), "decision/preview", &p, "preview")
        .await
        .unwrap();
    let revision = config(&f.db.lock().unwrap()).unwrap()["revision"].clone();
    service.handle(f.db.clone(),"decision/setKey",&json!({"provider":"openai","expectedRevision":revision,"apiKey":"different-fixture-credential"}),"rotate").await.unwrap();
    let cfg = config(&f.db.lock().unwrap()).unwrap();
    assert_eq!(cfg["providers"]["openai"]["enabled"], false);
    assert_eq!(cfg["providers"]["openai"]["workspaces"], json!([]));
    p["fingerprint"] = preview["fingerprint"].clone();
    assert!(
        service
            .handle(f.db.clone(), "decision/evaluate", &p, "old-disclosure")
            .await
            .is_err()
    );
    assert!(runs(&f.db.lock().unwrap()).unwrap().is_empty());
}

#[tokio::test]
async fn restored_history_cannot_make_an_old_preview_or_connection_test_spend_again() {
    let f = fixture().await;
    let first = Service::new().unwrap();
    enable(&first, f.db.clone(), "openai").await;
    let mut p = params("openai");
    let preview = first
        .handle(f.db.clone(), "decision/preview", &p, "preview")
        .await
        .unwrap();
    p["fingerprint"] = preview["fingerprint"].clone();
    let mut restarted = Service::new().unwrap();
    let server = server(response("openai"), 0, None, 200).await;
    restarted.endpoint = Some(server.url.clone());
    restarted
        .test_keys
        .lock()
        .unwrap()
        .insert("openai".into(), b"fixture-decision-credential".to_vec());
    assert!(
        restarted
            .handle(
                f.db.clone(),
                "decision/evaluate",
                &p,
                "unrecorded-before-restore"
            )
            .await
            .unwrap_err()
            .to_string()
            .contains("preview changed")
    );
    assert!(
        restarted
            .handle(
                f.db.clone(),
                "decision/test",
                &json!({"provider":"openai","admissionEpoch":first.epoch}),
                "old-test"
            )
            .await
            .unwrap_err()
            .to_string()
            .contains("restarted")
    );
    assert_eq!(server.calls.load(Ordering::SeqCst), 0);
    assert!(runs(&f.db.lock().unwrap()).unwrap().is_empty());
}

#[tokio::test]
async fn indexed_history_compacts_details_and_session_cleanup_keeps_paid_tombstones() {
    let f = fixture().await;
    {
        let db = f.db.lock().unwrap();
        for index in 0..=FULL_RESULTS {
            save_run(&db,json!({"id":format!("request-{index}"),"fingerprint":format!("fingerprint-{index}"),"provider":"openai","status":"completed","createdAtMillis":index,"source":{"sessionId":"session-a"},"question":{"prompt":"private fixture question"},"result":{"answer":"private fixture answer"}})).unwrap();
        }
        let old = read_run(&db, "request-0").unwrap().unwrap();
        assert!(old["result"].is_null() && old["question"].is_null());
        assert_eq!(old["detailsPruned"], true);
        assert_eq!(recent_runs(&db).unwrap().len(), 100);
        let mut row = db.get("sessions", "session-a").unwrap().unwrap();
        row["lifecycle"] = json!("archived");
        db.put("sessions", "session-a", &row).unwrap();
        crate::data::remove_archived(&db, &f.root, "cleanup-decision", &["session-a".to_owned()])
            .unwrap();
        let retained = read_run(&db, "request-100").unwrap().unwrap();
        assert_eq!(retained["status"], "retained");
        assert_eq!(retained["fingerprint"], "fingerprint-100");
        assert!(!retained.to_string().contains("private fixture"));
        assert!(retained["source"].is_null());
        // A paid response already in flight must not resurrect data after removal.
        save_run(&db,json!({"id":"request-100","fingerprint":"fingerprint-100","status":"completed","source":{"sessionId":"session-a"},"question":{"prompt":"private fixture question"},"result":{"answer":"private fixture answer"}})).unwrap();
        assert_eq!(read_run(&db, "request-100").unwrap().unwrap(), retained);
    }
}

#[tokio::test]
async fn retained_identity_capacity_refuses_new_spend_without_forgetting_old_ids() {
    let f = fixture().await;
    let mut service = Service::new().unwrap();
    enable(&service, f.db.clone(), "openai").await;
    let server = server(response("openai"), 0, None, 200).await;
    service.endpoint = Some(server.url.clone());
    f.db.lock().unwrap().0.execute("WITH RECURSIVE n(x) AS (VALUES(0) UNION ALL SELECT x+1 FROM n WHERE x+1<?1) INSERT INTO decisions SELECT printf('old-%d',x),json_object('id',printf('old-%d',x),'fingerprint','fixture','status','retained') FROM n",[RUN_LIMIT as i64]).unwrap();
    let error = service
        .handle(
            f.db.clone(),
            "decision/test",
            &json!({"provider":"openai","admissionEpoch":service.epoch}),
            "over-limit",
        )
        .await
        .unwrap_err();
    assert!(error.to_string().contains("history is full"));
    assert_eq!(server.calls.load(Ordering::SeqCst), 0);
    assert!(read_run(&f.db.lock().unwrap(), "old-0").unwrap().is_some());
    assert!(
        read_run(&f.db.lock().unwrap(), "over-limit")
            .unwrap()
            .is_none()
    );
    assert!(service.active.lock().unwrap().is_empty());
}

async fn mode(service: &Service, db: SharedDb, params: Value) -> Value {
    let revision = config(&db.lock().unwrap()).unwrap()["revision"].clone();
    let mut params = params;
    params["expectedRevision"] = revision;
    service
        .handle(db, "decision/configureMode", &params, "mode")
        .await
        .unwrap()
}
fn finished_task(db: &SharedDb, waiting: bool) {
    let database = db.lock().unwrap();
    let mut row = database.get("sessions", "session-a").unwrap().unwrap();
    row["state"] = json!({
        "items":[
            {"kind":"userMessage","turnId":"t1","text":"Lascoria note: hidden folder list. Fix the parser","displayText":"Fix the parser"},
            {"kind":"agentMessage","turnId":"t1","text":"Parser fixed; SECRET-REPLY tests pass"}],
        "turns":[{"turnId":"t1","terminal":if waiting {Value::Null} else {json!("completed")}}],
        "userInputs": if waiting {json!([{"requested":{"prompt":"Which branch?"}}])} else {json!([])},
        "approvals":[]
    });
    database.put("sessions", "session-a", &row).unwrap();
}

#[tokio::test]
async fn triage_sends_only_chosen_parts_once_per_update_and_only_with_consent() {
    let f = fixture().await;
    let mut service = Service::new().unwrap();
    enable(&service, f.db.clone(), "jev").await;
    let server = server(response("jev"), 0, None, 200).await;
    service.endpoint = Some(server.url.clone());
    finished_task(&f.db, false);
    // Off by default: nothing is sent.
    assert_eq!(service.triage_pass(f.db.clone()).await.unwrap(), 0);
    // A provider without workspace consent for triage still sends nothing.
    mode(
        &service,
        f.db.clone(),
        json!({"mode":"triage","provider":"jev","share":["request","question"]}),
    )
    .await;
    assert_eq!(service.triage_pass(f.db.clone()).await.unwrap(), 0);
    assert_eq!(server.calls.load(Ordering::SeqCst), 0);
    mode(
        &service,
        f.db.clone(),
        json!({"mode":"triage","sessionId":"session-a","workspaceEnabled":true}),
    )
    .await;
    assert_eq!(service.triage_pass(f.db.clone()).await.unwrap(), 1);
    assert_eq!(
        service.triage_pass(f.db.clone()).await.unwrap(),
        0,
        "one request per update"
    );
    assert_eq!(server.calls.load(Ordering::SeqCst), 1);
    let recent = service
        .handle(f.db.clone(), "decision/status", &json!({}), "status")
        .await
        .unwrap()["recent"]
        .clone();
    let triaged = recent
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["purpose"] == "triage")
        .unwrap()
        .clone();
    assert_eq!(triaged["status"], "completed");
    assert_eq!(triaged["source"]["turnId"], "t1");
    // A new wait for the user is a new update.
    finished_task(&f.db, true);
    assert_eq!(service.triage_pass(f.db.clone()).await.unwrap(), 1);
    assert_eq!(server.calls.load(Ordering::SeqCst), 2);
    // Text shares the user's words, not hidden notes, and not the reply when it is not chosen.
    let row =
        f.db.lock()
            .unwrap()
            .get("sessions", "session-a")
            .unwrap()
            .unwrap();
    let text = modes::triage_input(&row, "t1", &["request".into(), "question".into()]).unwrap();
    assert!(
        text.contains("Fix the parser")
            && !text.contains("Lascoria note")
            && !text.contains("SECRET-REPLY")
    );
    assert!(text.contains("Which branch?"));
}

#[tokio::test]
async fn muse_tool_is_refused_until_enabled_never_pays_twice_and_has_a_daily_limit() {
    let f = fixture().await;
    let mut service = Service::new().unwrap();
    enable(&service, f.db.clone(), "subq").await;
    let server = server(response("subq"), 0, None, 200).await;
    service.endpoint = Some(server.url.clone());
    let ask = json!({"sessionId":"session-a","question":"Is this ready to merge?","kind":"yes_no","context":"All 12 tests pass.","requestId":"q-1"});
    let refused = service
        .handle(f.db.clone(), "decision/tool", &ask, "q-1")
        .await
        .unwrap_err();
    assert!(refused.to_string().contains("not enabled for this session"));
    mode(
        &service,
        f.db.clone(),
        json!({"mode":"tool","provider":"subq","dailyLimit":1}),
    )
    .await;
    mode(
        &service,
        f.db.clone(),
        json!({"mode":"tool","sessionId":"session-a","workspaceEnabled":true}),
    )
    .await;
    let answer = service
        .handle(f.db.clone(), "decision/tool", &ask, "q-1")
        .await
        .unwrap();
    assert!(
        answer["advisory"]
            .as_str()
            .unwrap()
            .contains("does not approve anything")
    );
    assert_eq!(answer["answer"]["noul"], 0.9);
    // The same request again returns the recorded answer without a second paid call.
    assert_eq!(
        service
            .handle(f.db.clone(), "decision/tool", &ask, "q-1")
            .await
            .unwrap(),
        answer
    );
    assert_eq!(server.calls.load(Ordering::SeqCst), 1);
    let mut second = ask.clone();
    second["requestId"] = json!("q-2");
    let limited = service
        .handle(f.db.clone(), "decision/tool", &second, "q-2")
        .await
        .unwrap_err();
    assert!(limited.to_string().contains("limit"));
    for bad in [
        json!({"sessionId":"session-a","question":"","context":"x"}),
        json!({"sessionId":"session-a","question":"Which?","kind":"choice","options":"only one","context":"x"}),
        json!({"sessionId":"session-a","question":"Q","kind":"essay","context":"x"}),
        json!({"sessionId":"session-a","question":"Q","context":"x".repeat(16_001)}),
    ] {
        assert!(
            service
                .handle(f.db.clone(), "decision/tool", &bad, "bad")
                .await
                .is_err(),
            "{bad}"
        );
    }
    assert_eq!(server.calls.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn replacing_or_disabling_a_key_revokes_every_mode_that_used_it() {
    let f = fixture().await;
    let service = Service::new().unwrap();
    enable(&service, f.db.clone(), "openai").await;
    mode(
        &service,
        f.db.clone(),
        json!({"mode":"triage","provider":"openai"}),
    )
    .await;
    mode(
        &service,
        f.db.clone(),
        json!({"mode":"triage","sessionId":"session-a","workspaceEnabled":true}),
    )
    .await;
    mode(
        &service,
        f.db.clone(),
        json!({"mode":"tool","provider":"openai"}),
    )
    .await;
    let revision = config(&f.db.lock().unwrap()).unwrap()["revision"].clone();
    service.handle(f.db.clone(),"decision/setKey",&json!({"provider":"openai","expectedRevision":revision,"apiKey":"replacement-credential"}),"key2").await.unwrap();
    let cfg = config(&f.db.lock().unwrap()).unwrap();
    for name in modes::MODES {
        assert_eq!(modes::mode(&cfg, name)["provider"], Value::Null, "{name}");
        assert_eq!(modes::mode(&cfg, name)["workspaces"], json!([]), "{name}");
    }
    // A mode cannot use a provider that is off.
    let revision = cfg["revision"].clone();
    let error = service
        .handle(
            f.db.clone(),
            "decision/configureMode",
            &json!({"mode":"tool","provider":"openai","expectedRevision":revision}),
            "m",
        )
        .await
        .unwrap_err();
    assert!(error.to_string().contains("Turn this provider on"));
}

#[tokio::test]
async fn overrides_and_metrics_aggregate_the_retained_history() {
    let f = fixture().await;
    let mut service = Service::new().unwrap();
    enable(&service, f.db.clone(), "jev").await;
    let server = server(response("jev"), 0, None, 200).await;
    service.endpoint = Some(server.url.clone());
    let mut p = params("jev");
    let preview = service
        .handle(f.db.clone(), "decision/preview", &p, "preview")
        .await
        .unwrap();
    p["fingerprint"] = preview["fingerprint"].clone();
    service
        .handle(f.db.clone(), "decision/evaluate", &p, "eval-1")
        .await
        .unwrap();
    let marked = service
        .handle(
            f.db.clone(),
            "decision/feedback",
            &json!({"requestId":"eval-1","verdict":"disagree"}),
            "fb",
        )
        .await
        .unwrap();
    assert_eq!(marked["userVerdict"], "disagree");
    assert!(
        service
            .handle(
                f.db.clone(),
                "decision/feedback",
                &json!({"requestId":"eval-1","verdict":"maybe"}),
                "fb"
            )
            .await
            .is_err()
    );
    let metrics = service
        .handle(f.db.clone(), "decision/metrics", &json!({}), "m")
        .await
        .unwrap();
    let jev = &metrics["providers"]["jev"];
    assert_eq!(jev["requests"], 1);
    assert_eq!(jev["byPurpose"]["manual"], 1);
    assert_eq!(jev["byStatus"]["completed"], 1);
    assert_eq!(jev["inputTokens"], 12);
    assert_eq!(jev["disagreed"], 1);
    assert!(jev["latencyP50Ms"].is_number());
}
