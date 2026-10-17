mod auth;
mod data;
mod db;
mod dedicated;
mod metrics;
mod peer;
mod projects;
mod relay;
mod relay_mcp;
mod review;
mod search;
mod session_names;
mod worker;
mod workspace;

use anyhow::{Context, Result, bail, ensure};
use db::Db;
use fs2::FileExt;
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    env, fs,
    path::PathBuf,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio::{
    sync::{Semaphore, mpsc, oneshot},
    task::JoinSet,
    time::{interval, timeout},
};
use tokio_util::codec::{Framed, LinesCodec};
use uuid::Uuid;
use worker::{Broker, SharedDb, Worker};

#[derive(Clone)]
struct Lane {
    actor: Arc<tokio::sync::Mutex<Actor>>,
    admission: Arc<Semaphore>,
    tail: Arc<Mutex<Option<oneshot::Receiver<()>>>>,
}
impl Lane {
    fn new(actor: Actor) -> Self {
        Self {
            actor: Arc::new(tokio::sync::Mutex::new(actor)),
            admission: Arc::new(Semaphore::new(4)),
            tail: Arc::new(Mutex::new(None)),
        }
    }
}

struct Actor {
    db: SharedDb,
    workers: HashMap<String, Worker>,
    node: String,
    script: PathBuf,
    broker: Arc<tokio::sync::Mutex<Option<Arc<Broker>>>>,
    target: Option<String>,
}
impl Actor {
    fn row(&self, id: &str) -> Result<Value> {
        self.db
            .lock()
            .unwrap()
            .get("sessions", id)?
            .context("Unknown session")
    }
    fn save(&self, row: &Value) -> Result<()> {
        self.db
            .lock()
            .unwrap()
            .put("sessions", row["id"].as_str().unwrap(), row)
    }
    async fn launch(&mut self, row: &mut Value) -> Result<()> {
        projects::check_session(row).await?;
        let id = row["id"].as_str().unwrap().to_string();
        // Persist the intended budget, then retain interruption facts written during old-worker drain.
        self.save(row)?;
        if let Some(mut old) = self.workers.remove(&id) {
            old.stop().await;
            *row = self.row(&id)?;
        }
        let generation = row["generation"].as_u64().unwrap_or(0) + 1;
        row["generation"] = json!(generation);
        row["lifecycle"] = json!("recovering");
        row["state"]["current"] = json!(false);
        self.save(row)?;
        let worker = Worker::spawn(
            &self.node,
            &self.script,
            self.db.clone(),
            id.clone(),
            generation,
            &self.broker,
        )
        .await?;
        {
            let db = self.db.lock().unwrap();
            *row = db
                .get("sessions", &id)?
                .context("Starting session disappeared")?;
            row["handshake"] = worker.ready["handshake"].clone();
            row["durability"] = worker.ready["durability"].clone();
            db.put("sessions", &id, row)?;
        }
        self.workers.insert(id, worker);
        Ok(())
    }
    async fn dispatch(
        &mut self,
        id: &str,
        operation: &str,
        params: Value,
        session: &str,
        wire: Option<Value>,
    ) -> Result<Value> {
        let reservation = self.db.lock().unwrap().get("commands", id)?;
        let wire_id = reservation
            .as_ref()
            .filter(|c| c["relayReservation"] == true)
            .and_then(|c| c["commandId"].as_str())
            .map(str::to_owned)
            .unwrap_or_else(|| Uuid::now_v7().to_string());
        let mut command = json!({"id":id,"operation":operation,"params":params,"sessionId":session,"commandId":wire_id,"status":"sending","createdAtMillis":db::now_ms()});
        if let Some(reservation) = reservation.filter(|c| c["relayReservation"] == true) {
            command["relayMessageId"] = reservation["relayMessageId"].clone();
        }
        {
            let db = self.db.lock().unwrap();
            db.journal_admits()?;
            db.put("commands", id, &command)?; // synchronous=FULL: durable before dispatch
        }
        let worker = self
            .workers
            .get_mut(session)
            .context("SDK worker unavailable")?;
        let response = worker
            .call(json!({"id":wire_id,"commandId":wire_id,"operation":operation,"params":wire.unwrap_or(params)}))
            .await;
        // Preserve a terminal fact that arrived before the admission response.
        let db = self.db.lock().unwrap();
        let prior = db.get("commands", id)?.unwrap();
        match response {
            Ok(response) if response.get("error").is_none() => {
                command["result"] = response["result"].clone();
                command["status"] = if prior["status"] == "applied" {
                    json!("applied")
                } else if response["result"]["status"] == "accepted" {
                    json!("accepted")
                } else {
                    json!("applied")
                };
            }
            Ok(response) => {
                command["status"] = json!(if response["error"]["rejected"] == true {
                    "rejected"
                } else {
                    "outcomeUnknown"
                });
                command["error"] = response["error"].clone();
                if let Some(receipt) = response["error"].get("receipt") {
                    command["result"] = receipt.clone();
                    command["status"] = json!("applied");
                }
            }
            Err(error) => {
                command["status"] = json!("outcomeUnknown");
                command["error"] = json!({"message":error.to_string()});
            }
        }
        if prior["status"] == "applied" {
            command["status"] = json!("applied");
        }
        db.put("commands", id, &command)?;
        Ok(command)
    }
    async fn recover(&mut self, id: &str, request_id: Option<&str>) -> Result<Value> {
        let mut row = self.row(id)?;
        ensure!(
            row["durability"] == "durable",
            "Recovery unsupported for ephemeral or unfamiliar durability"
        );
        ensure!(
            row["attempts"].as_u64().unwrap_or(0) < 2,
            "Recovery retry limit reached; explicit resume required"
        );
        row["attempts"] = json!(row["attempts"].as_u64().unwrap_or(0) + 1);
        self.launch(&mut row).await?;
        if row["durability"] != "durable" {
            if let Some(mut worker) = self.workers.remove(id) {
                worker.stop().await;
            }
            bail!("Replacement host is not durable");
        }
        let recovery_id = request_id
            .map(str::to_owned)
            .unwrap_or_else(|| format!("recovery_{}", Uuid::new_v4()));
        let command = self
            .dispatch(&recovery_id, "resume", json!({"sessionId":id}), id, None)
            .await?;
        if command["status"] == "rejected" || command["status"] == "outcomeUnknown" {
            if let Some(mut worker) = self.workers.remove(id) {
                worker.stop().await;
            }
            bail!("Resume failed: {}", command["error"]);
        }
        let current = {
            let db = self.db.lock().unwrap();
            let mut row = db
                .get("sessions", id)?
                .context("Recovery session disappeared")?;
            let current = row["state"]["current"] == true;
            if current {
                row["lifecycle"] = json!("connected");
                row["recoveryError"] = Value::Null;
                db.put("sessions", id, &row)?;
            }
            current
        };
        if !current {
            if let Some(mut worker) = self.workers.remove(id) {
                worker.stop().await;
            }
            bail!("Recovery did not converge to current state");
        }
        Ok(command)
    }
    async fn recovery_tick(&mut self) -> Result<()> {
        let Some(target) = self.target.as_deref() else {
            return Ok(());
        };
        let row = self.row(target)?;
        if row["lifecycle"] == "interrupted"
            && row["durability"] == "durable"
            && row["attempts"].as_u64().unwrap_or(0) < 2
        {
            let id = row["id"].as_str().unwrap();
            if let Err(error) = self.recover(id, None).await {
                let mut row = self.row(id)?;
                row["lifecycle"] = json!("interrupted");
                row["recoveryError"] = json!(error.to_string());
                row["state"]["current"] = json!(false);
                self.save(&row)?;
            }
        }
        Ok(())
    }
    async fn handle(&mut self, request: Value) -> Result<Value> {
        let operation = request["operation"]
            .as_str()
            .context("Operation required")?;
        if operation == "status" {
            let db = self.db.lock().unwrap();
            let commands = db.all("commands")?;
            let relay = relay::snapshot(&db)?;
            return Ok(
                json!({"pid":std::process::id(),"version":db.version(),"features":["skills","usage","modelSelection","sessionSettings","diagnostics","taskWorkspaces","accounts","drafts","localRelay","relayDrafts","relayViews","relayUnread","relayMap","sessionNames","projects","dataLifecycle","search","continuation","projectContextUpdates"],"relayUnread":relay["unread"],"relayConnections":relay["connections"],"sessions":session_names::list(&db)?,"commands":commands.into_iter().rev().take(100).collect::<Vec<_>>()}),
            );
        }
        let params = request.get("params").cloned().unwrap_or_else(|| json!({}));
        ensure!(params.is_object(), "Params must be an object");
        if operation.starts_with("relay/") {
            let id = request["id"].as_str().context("Request ID required")?;
            ensure!(
                !id.is_empty()
                    && id.len() <= 90
                    && id
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-'),
                "Invalid relay request ID"
            );
            if operation == "relay/deliver" {
                let recipient = params["sessionId"].as_str().context("Recipient required")?;
                let row = self.row(recipient)?;
                // Existing delivery identities are reconciled even while a turn runs.
                let existing = params["messageId"].as_str().map(|id| format!("relay_{id}"));
                let admitted = match existing {
                    Some(id) => self.db.lock().unwrap().get("commands", &id)?.is_some(),
                    None => false,
                };
                if !admitted {
                    workspace::idle(&self.db, &row)?;
                }
                let (command_id, wire, reserved) = relay::delivery(self.db.clone(), &params)?;
                if !reserved {
                    return self
                        .db
                        .lock()
                        .unwrap()
                        .get("commands", &command_id)?
                        .context("Missing relay command");
                }
                let session = wire["sessionId"].as_str().unwrap();
                return self
                    .dispatch(&command_id, "turn", wire.clone(), session, None)
                    .await;
            }
            return relay::handle(self.db.clone(), operation, &params, id);
        }
        if [
            "presentation/get",
            "presentation/save",
            "drafts/get",
            "drafts/save",
            "artifact/capture",
            "artifact/check",
            "artifact/read",
            "review/list",
            "evidence/record",
        ]
        .contains(&operation)
        {
            let id = request["id"].as_str().context("Request ID required")?;
            ensure!(
                !id.is_empty()
                    && id.len() <= 100
                    && id
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-'),
                "Invalid request ID"
            );
            return timeout(
                Duration::from_secs(12),
                review::handle(self.db.clone(), operation, &params, id),
            )
            .await
            .context("Review inspection timed out")?;
        }
        if operation.starts_with("workspace/") || operation == "session/archive" {
            let session = params["sessionId"].as_str().context("Session required")?;
            let row = self.row(session)?;
            if operation == "workspace/files" || operation == "workspace/file" {
                return workspace::files(&row, &params).await;
            }
            if operation == "workspace/inspect" {
                return workspace::inspect(&row).await;
            }
            ensure!(
                [
                    "workspace/run",
                    "workspace/commit",
                    "workspace/discard",
                    "session/archive"
                ]
                .contains(&operation),
                "Unsupported workspace operation"
            );
            let id = request["id"]
                .as_str()
                .context("Stable request ID required")?;
            ensure!(
                !id.is_empty()
                    && id.len() <= 100
                    && id
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b)),
                "Invalid request ID"
            );
            if let Some(previous) = self.db.lock().unwrap().get("commands", id)? {
                db::same_request(&previous, operation, &params)?;
                return Ok(previous);
            }
            if operation == "session/archive" {
                ensure!(row["lifecycle"] != "archived", "Session already archived");
                ensure!(
                    row["state"]["current"] != true || row["state"]["activeTurnId"].is_null(),
                    "Cancel the active Muse turn before archiving"
                );
                ensure!(
                    !self
                        .db
                        .lock()
                        .unwrap()
                        .all("commands")?
                        .iter()
                        .any(|c| c["sessionId"] == session
                            && c["operation"] == "workspace/run"
                            && c["status"] == "running"),
                    "Wait for the test command to finish"
                );
            } else if !(operation == "workspace/discard" && row["lifecycle"] == "archived") {
                workspace::idle(&self.db, &row)?;
            }
            if let Some(previous) = workspace::begin(&self.db, id, operation, &params, session)? {
                return Ok(previous);
            }
            if operation == "workspace/run" {
                return match workspace::run(self.db.clone(), row, id.to_owned(), params).await {
                    Ok(result) => Ok(result),
                    Err(error) => workspace::finish(&self.db, id, Err(error)),
                };
            }
            if operation == "workspace/commit" {
                return workspace::finish(&self.db, id, workspace::commit(&row, &params).await);
            }
            if operation == "workspace/discard" {
                // Validate the exact content before stopping the worker, then check again before removal.
                let current = workspace::inspect(&row).await?;
                ensure!(
                    row["managedWorkspace"].is_object()
                        && params["confirmation"] == row["id"]
                        && current["fingerprint"] == params["fingerprint"],
                    "Confirm the current isolated workspace before discarding"
                );
            }
            if let Some(mut worker) = self.workers.remove(session) {
                worker.stop().await;
            }
            let mut archived = self.row(session)?;
            archived["lifecycle"] = json!("archived");
            archived["state"]["current"] = json!(false);
            archived["archivedAtMillis"] = json!(db::now_ms());
            self.save(&archived)?;
            let result = if operation == "workspace/discard" {
                workspace::discard(&archived, &params).await
            } else {
                Ok(json!({"archived":session,"workspaceRetained":true}))
            };
            if operation == "workspace/discard" && result.is_ok() {
                archived["workspaceDiscarded"] = json!(true);
                self.save(&archived)?;
            }
            return workspace::finish(&self.db, id, result);
        } else if ["transcript", "output", "models", "usage", "skills"].contains(&operation) {
            let session = params["sessionId"].as_str().context("Session required")?;
            ensure!(
                self.row(session)?["state"]["current"] == true,
                "Session state unavailable"
            );
            let response = self
                .workers
                .get_mut(session)
                .context("Worker unavailable")?
                .call(
                    json!({"id":Uuid::new_v4().to_string(),"operation":if operation == "output" {"readOutput"} else if ["models", "usage", "skills"].contains(&operation) {operation} else {"inspect"},"params":params}),
                )
                .await?;
            ensure!(
                response.get("error").is_none(),
                "Session read failed: {}",
                response["error"]
            );
            return Ok(response["result"].clone());
        }
        if operation == "stop" {
            let sessions = self.db.lock().unwrap().all("sessions")?;
            let expected: Vec<&str> = sessions
                .iter()
                .map(|row| row["id"].as_str().unwrap())
                .collect();
            ensure!(
                params["sessions"]
                    .as_array()
                    .is_some_and(|ids| ids.iter().all(Value::is_string)),
                "Stop session IDs must be strings"
            );
            let actual: Vec<&str> = params["sessions"]
                .as_array()
                .context("Stop must name all affected sessions")?
                .iter()
                .filter_map(Value::as_str)
                .collect();
            ensure!(
                actual == expected,
                "Affected sessions changed; refresh status before stop"
            );
            return Ok(json!({"stopping":true,"sessions":expected}));
        }
        ensure!(
            [
                "start",
                "turn",
                "steer",
                "cancel",
                "decide",
                "answer",
                "resume",
                "setModel",
                "setEffort"
            ]
            .contains(&operation),
            "Unsupported operation"
        );
        let id = request["id"]
            .as_str()
            .context("Stable request ID required")?;
        ensure!(
            !id.is_empty()
                && id.len() <= 100
                && id
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-'),
            "Invalid request ID"
        );
        // Bind first: a guard in an `if let` scrutinee would stay locked for the whole block.
        let previous = self.db.lock().unwrap().get("commands", id)?;
        if let Some(previous) = previous {
            db::same_request(&previous, operation, &params)?;
            if let Some(session) = previous["sessionId"].as_str() {
                // A reply lost after the receipt: reconcile the folder change it carried.
                projects::settle_pending(&self.db.lock().unwrap(), session)?;
            }
            return Ok(previous); // No automatic replay of uncertain side effects.
        }
        self.db.lock().unwrap().journal_admits()?;
        if operation == "start" {
            let project = projects::selected(&self.db.lock().unwrap(), &params)?;
            ensure!(
                project.is_none() || params["isolated"] != true,
                "Project sessions use their existing folders; isolated project worktrees are not supported"
            );
            if let Some(project) = &project {
                projects::check_session(&json!({"projectContext":project})).await?;
            }
            let initial_name = session_names::validate(params.get("name"))?;
            // Continuing archived work starts a separate session; the archive stays read-only.
            let continued_from = match params.get("continuedFrom") {
                None => None,
                Some(value) => {
                    let from = value.as_str().context("Invalid continued session")?;
                    let prior = self
                        .db
                        .lock()
                        .unwrap()
                        .get("sessions", from)?
                        .context("Unknown archived session")?;
                    ensure!(
                        prior["lifecycle"] == "archived",
                        "Only archived sessions can be continued"
                    );
                    Some(from.to_owned())
                }
            };
            ensure!(
                self.db
                    .lock()
                    .unwrap()
                    .all("sessions")?
                    .iter()
                    .filter(|r| r["lifecycle"] != "archived")
                    .count()
                    < 10,
                "Session limit reached"
            );
            if let Some(model) = params.get("modelId") {
                ensure!(
                    model.as_str().is_some_and(|id| !id.is_empty()
                        && id.len() <= 200
                        && id
                            .bytes()
                            .all(|b| b.is_ascii_alphanumeric() || b"-_.:/".contains(&b))),
                    "Invalid model ID"
                );
            }
            let workspace = if let Some(project) = &project {
                PathBuf::from(
                    project["folders"][0]["path"]
                        .as_str()
                        .context("Project default folder required")?,
                )
            } else {
                let path = dunce::canonicalize(
                    params["workspace"].as_str().context("Workspace required")?,
                )?;
                ensure!(path.is_dir(), "Workspace must be a directory");
                path
            };
            ensure!(
                self.db.lock().unwrap().count("sessions")? < 100,
                "Retained session limit reached (100)"
            );
            let session = Uuid::now_v7().to_string();
            let mut managed = Value::Null;
            let workspace = if params["isolated"] == true {
                // Persist intent before filesystem effects. An uncertain retry never creates another worktree.
                workspace::begin(&self.db, id, operation, &params, &session)?;
                let parent = lascoria_runtime::state_dir().join("worktrees");
                fs::create_dir_all(&parent)?;
                let target = dunce::canonicalize(&parent)?.join(&session);
                let mut planned = json!({"id":session,"initialName":initial_name,"workspace":target,"generation":0,"lifecycle":"starting","attempts":0,"interruptions":[],"state":{"current":false},"managedWorkspace":{"source":workspace,"path":target,"branch":format!("lascoria/{session}")}});
                self.save(&planned)?;
                match workspace::create(&workspace, &target, &session).await {
                    Ok(value) => managed = value,
                    Err(error) => {
                        planned["lifecycle"] = json!("failed");
                        planned["recoveryError"] = json!(error.to_string());
                        self.save(&planned)?;
                        return workspace::finish(&self.db, id, Err(error));
                    }
                }
                target
            } else {
                workspace
            };
            let mut row = json!({"id":session,"initialName":initial_name,"workspace":workspace,"generation":0,"lifecycle":"starting","attempts":0,"interruptions":[],"state":{"current":false}});
            row["managedWorkspace"] = managed;
            if let Some(from) = &continued_from {
                row["continuedFrom"] = json!(from);
            }
            if let Some(project) = &project {
                row["projectContext"] = project.clone();
                row["projectContextReceipt"] = json!({"requestId":id,"status":"requested"});
            }
            self.save(&row)?;
            if let Err(error) = self.launch(&mut row).await {
                row["lifecycle"] = json!("failed");
                row["recoveryError"] = json!(error.to_string());
                self.save(&row)?;
                if params["isolated"] == true {
                    return workspace::finish(&self.db, id, Err(error));
                }
                return Err(error);
            }
            let mut wire = json!({"sessionId":session,"workspace":workspace});
            if let Some(project) = &project {
                wire["workspaceRoots"] = json!(
                    project["folders"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .map(|f| f["path"].clone())
                        .collect::<Vec<_>>()
                );
            }
            if let Some(model) = params.get("modelId") {
                wire["modelId"] = model.clone();
            }
            let result = self
                .dispatch(id, operation, params, &session, Some(wire))
                .await?;
            let db = self.db.lock().unwrap();
            let mut row = db
                .get("sessions", &session)?
                .context("Started session disappeared")?;
            if project.is_some() {
                row["projectContextReceipt"] = json!({"requestId":id,"status":result["status"],"commandId":result["commandId"]});
            }
            row["lifecycle"] = json!(if result["status"] == "applied"
                && row["state"]["current"] == true
            {
                "connected"
            } else {
                "interrupted"
            });
            db.put("sessions", &session, &row)?;
            return Ok(result);
        }
        let session = params["sessionId"]
            .as_str()
            .context("Session target required")?;
        let mut row = self.row(session)?;
        ensure!(
            row["lifecycle"] != "archived",
            "Archived sessions are read-only"
        );
        let mut replacement = None;
        if operation == "turn" {
            projects::settle_pending(&self.db.lock().unwrap(), session)?;
            row = self.row(session)?;
            replacement = projects::replacement(&self.db.lock().unwrap(), &row, &params)?;
            match &replacement {
                Some(project) => {
                    projects::check_session(&json!({"projectContext":project})).await?
                }
                None => projects::check_session(&row).await?,
            }
            workspace::idle(&self.db, &row)?;
        } else {
            ensure!(
                params.get("projectRevision").is_none(),
                "Project folder changes apply only with a new task"
            );
        }
        if operation == "resume" {
            ensure!(
                params == json!({"sessionId": session}),
                "Resume accepts only sessionId"
            );
            row["attempts"] = json!(0);
            self.save(&row)?;
            let result = self.recover(session, Some(id)).await;
            if let Err(error) = &result {
                let db = self.db.lock().unwrap();
                let mut row = db
                    .get("sessions", session)?
                    .context("Resume session disappeared")?;
                row["lifecycle"] = json!("interrupted");
                row["state"]["current"] = json!(false);
                row["recoveryError"] = json!(error.to_string());
                db.put("sessions", session, &row)?;
            }
            return result;
        }
        ensure!(
            row["lifecycle"] == "connected" && row["state"]["current"] == true,
            "Session state is not current; recover before issuing commands"
        );
        let Some(project) = replacement else {
            return self
                .dispatch(id, operation, params.clone(), session, None)
                .await;
        };
        // Durable intent before dispatch: the confirmed context stays authoritative until the
        // native turn receipt confirms the replacement.
        row["projectContextPending"] = json!({"revision":project["revision"],"requestId":id,"status":"requested","project":project});
        self.save(&row)?;
        let mut wire = params.clone();
        wire.as_object_mut().unwrap().remove("projectRevision");
        wire["workspaceRoots"] = projects::root_paths(&project);
        wire["projectNote"] = json!(projects::change_note(&project));
        let result = self
            .dispatch(id, operation, params.clone(), session, Some(wire))
            .await;
        projects::settle_pending(&self.db.lock().unwrap(), session)?;
        result
    }
    async fn stop(&mut self) {
        for (_, mut worker) in self.workers.drain() {
            worker.stop().await;
        }
    }
}

struct Call {
    request: Value,
    response: oneshot::Sender<Result<Value>>,
    delivered: oneshot::Receiver<()>,
    enqueued: Instant,
}
async fn connection(
    stream: lascoria_runtime::platform::Stream,
    token: String,
    sender: mpsc::Sender<Call>,
    db: SharedDb,
    metrics: Arc<Mutex<metrics::Metrics>>,
    auth: Arc<tokio::sync::Mutex<auth::Auth>>,
    policy: Arc<peer::Policy>,
) -> Result<()> {
    lascoria_runtime::platform::check_peer(&stream)?;
    // Identify the connecting program before reading any request (finding F1).
    // Classification may hash an executable the first time it connects; keep that file I/O
    // off the async workers that serve every other connection.
    let executable = lascoria_runtime::platform::peer_executable(&stream)
        .ok()
        .flatten();
    let peer_class = tokio::task::spawn_blocking(move || policy.classify(executable)).await?;
    let mut framed = Framed::new(stream, LinesCodec::new_with_max_length(65536));
    let (delivered_tx, delivered_rx) = oneshot::channel();
    let mut started = None;
    let response: Result<Value> = async {
        let line = timeout(Duration::from_secs(5), framed.next())
            .await?
            .context("Request missing")??;
        let request: Value = serde_json::from_str(&line)?;
        ensure!(
            request["version"] == 1 && request["token"] == token,
            "Invalid version or authentication"
        );
        let peer_class = peer_class?;
        peer::authorise(
            peer_class,
            request["operation"].as_str().context("Operation required")?,
        )?;
        started = Some(Instant::now());
        if request["operation"] == "account/status" { return auth.lock().await.status().await; }
        if request["operation"] == "diagnostics" { return Ok(metrics.lock().unwrap().snapshot()); }
        // Snapshot reads bypass session command lanes, including during recovery.
        if request["operation"] == "status" {
            let db = db.lock().unwrap();
            if request["params"]["since"].as_str().is_some_and(|version| version == db.version()) {
                return Ok(json!({"unchanged":true,"version":db.version(),"pid":std::process::id()}));
            }
            let relay = relay::snapshot(&db)?;
            return Ok(json!({"pid":std::process::id(),"version":db.version(),"features":["skills","usage","modelSelection","sessionSettings","diagnostics","taskWorkspaces","accounts","drafts","localRelay","relayDrafts","relayViews","relayUnread","relayMap","sessionNames","projects","dataLifecycle","search","continuation","projectContextUpdates"],"relayUnread":relay["unread"],"relayConnections":relay["connections"],"sessions":session_names::list(&db)?,"commands":db.all("commands")?.into_iter().rev().take(100).collect::<Vec<_>>()}));
        }
        // Data lifecycle work is file I/O under the journal lock; keep it off async workers.
        if request["operation"].as_str().is_some_and(|op| op.starts_with("data/")) {
            let operation = request["operation"].as_str().unwrap().to_owned();
            let params = request.get("params").cloned().unwrap_or_else(|| json!({}));
            let id = request["id"].as_str().context("Request ID required")?.to_owned();
            let db = db.clone();
            return timeout(
                Duration::from_secs(280),
                tokio::task::spawn_blocking(move || {
                    let root = lascoria_runtime::state_dir();
                    data::handle(&db.lock().unwrap(), &root, &operation, &params, &id)
                }),
            )
            .await
            .context("Data operation is still running; refresh before retrying")??;
        }
        if request["operation"] == "search" {
            return search::run(&db.lock().unwrap(), &request["params"]);
        }
        if request["operation"] == "project/list" {
            return Ok(json!({"projects":projects::list(&db.lock().unwrap())?}));
        }
        if request["operation"] == "project/save" {
            return projects::save_request(db.clone(), request["params"].clone(), request["id"].as_str().context("Request ID required")?.to_string()).await;
        }
        if request["operation"] == "session/rename" {
            return session_names::rename(&db.lock().unwrap(), &request["params"], request["id"].as_str().context("Request ID required")?);
        }
        // Review metadata is a bounded journal snapshot, not a session command.
        // A session row can be visible before its command lane is admitted.
        if request["operation"] == "review/list" {
            let params = request.get("params").cloned().unwrap_or_else(|| json!({}));
            ensure!(params.is_object(), "Params must be an object");
            let id = request["id"].as_str().context("Request ID required")?;
            ensure!(
                !id.is_empty() && id.len() <= 100 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-'),
                "Invalid request ID"
            );
            return review::handle(db.clone(), "review/list", &params, id).await;
        }
        let (tx, rx) = oneshot::channel();
        sender
            .try_send(Call {
                request,
                response: tx,
                delivered: delivered_rx,
                enqueued: Instant::now(),
            })
            .context("Supervisor request queue full")?;
        timeout(Duration::from_secs(60), rx).await??
    }
    .await;
    let failed = response.is_err();
    let payload = match response {
        Ok(result) => json!({"version":1,"result":result}),
        Err(error) => json!({"version":1,"error":error.to_string()}),
    };
    let payload = payload.to_string();
    if let Some(started) = started {
        metrics.lock().unwrap().record(
            started.elapsed().as_secs_f64() * 1000.0,
            failed,
            payload.len(),
        );
    }
    timeout(Duration::from_secs(5), framed.send(payload)).await??;
    let _ = delivered_tx.send(());
    Ok(())
}

fn main() -> Result<()> {
    let args: Vec<_> = std::env::args().collect();
    if args.get(1).is_some_and(|arg| arg == "--relay-mcp") {
        ensure!(
            args.len() == 3,
            "Local relay helper requires exactly one session identity"
        );
        return tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()?
            .block_on(relay_mcp::run(&args[2]));
    }
    supervisor_main()
}

#[tokio::main]
async fn supervisor_main() -> Result<()> {
    #[cfg(windows)]
    lascoria_runtime::process::workspace_helper()?;
    let directory = lascoria_runtime::state_dir();
    lascoria_runtime::platform::private_dir(&directory)?;
    let lock = lascoria_runtime::platform::private_file(&directory.join("owner.lock"), false)?;
    lock.try_lock_exclusive()
        .context("Another supervisor owns this state directory")?;
    let database_path = directory.join("state.sqlite");
    let database_file = lascoria_runtime::platform::private_file(&database_path, false)?;
    drop(database_file);
    // A staged restore is applied only here: under the owner lock, before any reader, worker or client.
    if let Some(outcome) = data::apply_pending_restore(&directory, &database_path)? {
        eprintln!("Data restore: {}", outcome["status"]);
    }
    let db = Arc::new(Mutex::new(Db::open(&database_path)?));
    {
        let db = db.lock().unwrap();
        for mut command in db.all("commands")? {
            if command["operation"] == "workspace/run" && command["status"] == "running" {
                command["status"] = json!("outcomeUnknown");
                command["result"]["outcome"] = json!("interrupted");
                db.put("commands", command["id"].as_str().unwrap(), &command)?;
            }
        }
        for mut row in db.all("sessions")? {
            if row["lifecycle"] == "archived" {
                continue;
            }
            let id = row["id"].as_str().unwrap().to_string();
            row["attempts"] = json!(0);
            db.put("sessions", &id, &row)?;
            db.interrupt(
                &id,
                row["generation"].as_u64().unwrap(),
                json!({"kind":"supervisorRestart"}),
            )?;
        }
    }
    let socket_path = directory.join(if cfg!(windows) {
        "ipc.json"
    } else {
        "supervisor.sock"
    });
    let mut listener = lascoria_runtime::platform::Listener::bind(&directory)?;
    let token = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
    let mut token_file = lascoria_runtime::platform::private_file(&directory.join("token"), true)?;
    use std::io::Write;
    token_file.write_all(token.as_bytes())?;
    token_file.sync_all()?;
    let script = env::var_os("SCH_WORKER")
        .map(PathBuf::from)
        .unwrap_or_else(|| lascoria_runtime::worker("worker.js"));
    let node = lascoria_runtime::node().to_string_lossy().into_owned();
    let (sender, mut requests) = mpsc::channel::<Call>(16);
    let permits = Arc::new(Semaphore::new(16));
    let broker = Arc::new(tokio::sync::Mutex::new(None));
    let make_actor = |target| Actor {
        db: db.clone(),
        workers: HashMap::new(),
        node: node.clone(),
        script: script.clone(),
        broker: broker.clone(),
        target,
    };
    // Account probing runs in the monitor; IPC readiness must not wait on a locked vault.
    // The ready gate remains closed until authentication has actually been observed.
    let account = auth::Auth::new(db.clone())?;
    let account_ready = account.ready.clone();
    let account = Arc::new(tokio::sync::Mutex::new(account));
    let monitor_account = account.clone();
    let account_monitor = tokio::spawn(async move {
        let mut timer = interval(Duration::from_secs(30));
        timer.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            timer.tick().await;
            let _ = monitor_account.lock().await.status().await;
        }
    });
    let global = Lane::new(make_actor(None));
    let lanes = Arc::new(Mutex::new(HashMap::new()));
    for row in db.lock().unwrap().all("sessions")? {
        let id = row["id"].as_str().unwrap().to_owned();
        lanes
            .lock()
            .unwrap()
            .insert(id.clone(), Lane::new(make_actor(Some(id))));
    }
    // Includes work whose IPC client has disconnected. No unbounded detached tasks.
    let work_permits = Arc::new(Semaphore::new(16));
    let mut tasks = JoinSet::new();
    let mut in_flight = std::collections::HashSet::new();
    let term = lascoria_runtime::platform::terminate_signal();
    tokio::pin!(term);
    let mut tick = interval(Duration::from_secs(1));
    println!("{}", json!({"pid":std::process::id(),"socket":socket_path}));
    let metrics = Arc::new(Mutex::new(metrics::Metrics::new()));
    let accept_metrics = metrics.clone();
    let accept_db = db.clone();
    let accept_account = account.clone();
    let policy = Arc::new(peer::Policy::from_env()?);
    if policy.enforced() {
        eprintln!("IPC: control bound to the desktop app");
    }
    let accept_task = tokio::spawn(async move {
        while let Ok(stream) = listener.accept().await {
            if let Ok(permit) = permits.clone().try_acquire_owned() {
                let sender = sender.clone();
                let token = token.clone();
                let db = accept_db.clone();
                let metrics = accept_metrics.clone();
                let account = accept_account.clone();
                let policy = policy.clone();
                tokio::spawn(async move {
                    let _permit = permit;
                    if let Err(error) =
                        connection(stream, token, sender, db, metrics, account, policy).await
                    {
                        eprintln!("IPC: {error}");
                    }
                });
            }
        }
    });
    loop {
        tokio::select! {
            _ = tokio::signal::ctrl_c() => break,
            _ = &mut term => break,
            Some(done) = tasks.join_next(), if !tasks.is_empty() => {
                match done {
                    Ok(Some(id)) => { in_flight.remove(&id); }
                    Ok(None) => {}
                    Err(error) => { eprintln!("Session task failed: {error}"); break; }
                }
            }
            _ = tick.tick() => {
                if !account_ready.load(std::sync::atomic::Ordering::SeqCst) { continue; }
                let candidates: Vec<_> = {
                    let rows = db.lock().unwrap().all("sessions")?;
                    let lanes = lanes.lock().unwrap();
                    rows.iter().filter(|row| row["lifecycle"] == "interrupted" && row["durability"] == "durable" && row["attempts"].as_u64().unwrap_or(0) < 2)
                        .filter_map(|row| lanes.get(row["id"].as_str()?).cloned()).collect()
                };
                for lane in candidates {
                    if tasks.len() >= 16 || lane.admission.available_permits() < 4 { continue; }
                    let Ok(mut actor) = lane.actor.try_lock_owned() else { continue };
                    let Ok(permit) = work_permits.clone().try_acquire_owned() else { break };
                    tasks.spawn(async move {
                        let _permit = permit;
                        if let Err(error) = actor.recovery_tick().await { eprintln!("Recovery: {error}"); }
                        None::<String>
                    });
                }
            }
            Some(call) = requests.recv() => {
                if call.request["operation"].as_str().is_some_and(|op| op.starts_with("account/")) {
                    let operation = call.request["operation"].as_str().unwrap();
                    if let Err(error) = auth::validate(operation, &call.request["params"]) {
                        let _ = call.response.send(Err(error)); continue;
                    }
                    if let Err(error) = account.lock().await.validate_transition(operation) {
                        let _ = call.response.send(Err(error)); continue;
                    }
                    if operation == "account/logout"
                        && let Err(error) = account.lock().await.prepare_logout() {
                        let _ = call.response.send(Err(error)); continue;
                    }
                    let changes_route = account.lock().await.changes_route(operation);
                    if changes_route {
                        // Account changes are barriers. Never journal secret-bearing requests.
                        while let Some(done) = tasks.join_next().await {
                            if let Ok(Some(id)) = done { in_flight.remove(&id); }
                        }
                        account_ready.store(false, std::sync::atomic::Ordering::SeqCst);
                        let actors: Vec<_> = lanes.lock().unwrap().values().cloned().collect();
                        let mut stopping = JoinSet::new();
                        for lane in actors { stopping.spawn(async move { lane.actor.lock().await.stop().await; }); }
                        while let Some(result) = stopping.join_next().await { if let Err(error) = result { eprintln!("Account host drain failed: {error}"); } }
                        if let Some(broker) = broker.lock().await.take() { broker.stop().await; }
                        let database = db.lock().unwrap();
                        for mut row in database.all("sessions")? {
                            if row["lifecycle"] != "archived" { row["attempts"] = json!(0); database.put("sessions", row["id"].as_str().unwrap(), &row)?; }
                        }
                    }
                    let operation = call.request["operation"].as_str().unwrap();
                    let result = account.lock().await.handle(operation, call.request["params"].clone()).await;
                    let _ = call.response.send(result);
                    continue;
                }
                if call.request["operation"] == "stop" {
                    // A shutdown is a barrier: finish admitted work before validating affected sessions.
                    while let Some(done) = tasks.join_next().await {
                        if let Ok(Some(id)) = done { in_flight.remove(&id); }
                    }
                    let result = global.actor.lock().await.handle(call.request).await;
                    let stop = result.as_ref().is_ok_and(|value| value["stopping"] == true);
                    let _ = call.response.send(result);
                    if stop { let _ = timeout(Duration::from_secs(5), call.delivered).await; break; }
                    continue;
                }
                if ["start", "turn", "steer", "resume", "setModel", "setEffort", "answer", "decide", "relay/deliver"].iter().any(|op| call.request["operation"] == *op)
                    && !account_ready.load(std::sync::atomic::Ordering::SeqCst) {
                    let _ = call.response.send(Err(anyhow::anyhow!("Sign in or reconnect your Muse account before continuing")));
                    continue;
                }
                let id = call.request["id"].as_str().map(str::to_owned);
                if id.as_ref().is_some_and(|id| in_flight.contains(id)) {
                    let _ = call.response.send(Err(anyhow::anyhow!("Request ID already in flight; retry after completion")));
                    continue;
                }
                let Ok(permit) = work_permits.clone().try_acquire_owned() else {
                    let _ = call.response.send(Err(anyhow::anyhow!("Supervisor work limit reached")));
                    continue;
                };
                if tasks.len() >= 16 {
                    let _ = call.response.send(Err(anyhow::anyhow!("Supervisor work limit reached")));
                    continue;
                }
                if let Some(id) = &id { in_flight.insert(id.clone()); }
                let target = (call.request["operation"] != "start")
                    .then(|| call.request["params"]["sessionId"].as_str()).flatten();
                let lane = if let Some(target) = target {
                    let lane = lanes.lock().unwrap().get(target).cloned();
                    let Some(lane) = lane else {
                        if let Some(id) = &id { in_flight.remove(id); }
                        let _ = call.response.send(Err(anyhow::anyhow!("Unknown session or session admission still in progress; refresh status")));
                        continue;
                    };
                    lane
                } else { global.clone() };
                let Ok(lane_permit) = lane.admission.clone().try_acquire_owned() else {
                    if let Some(id) = &id { in_flight.remove(id); }
                    let _ = call.response.send(Err(anyhow::anyhow!("Session request queue full")));
                    continue;
                };
                // Link in receive order before spawning: executor polling order is not FIFO.
                let (finished, next) = oneshot::channel();
                let predecessor = lane.tail.lock().unwrap().replace(next);
                let lanes = lanes.clone();
                let metrics = metrics.clone();
                tasks.spawn(async move {
                    let _permit = permit;
                    let _lane_permit = lane_permit;
                    let _finished = finished; // Dropping also releases the next waiter after a panic.
                    if let Some(predecessor) = predecessor { let _ = predecessor.await; }
                    let mut actor = lane.actor.lock().await;
                    if call.response.is_closed() { return id; }
                    metrics.lock().unwrap().record_queue(call.enqueued.elapsed().as_secs_f64() * 1000.0);
                    let starting = call.request["operation"] == "start";
                    let result = actor.handle(call.request).await;
                    // Start admission is serialized; hand ownership to a dedicated lane before replying.
                    if starting {
                        let workers = std::mem::take(&mut actor.workers);
                        for (session, worker) in workers {
                            let next = Actor {
                                db: actor.db.clone(), workers: HashMap::from([(session.clone(), worker)]),
                                node: actor.node.clone(), script: actor.script.clone(), broker: actor.broker.clone(),
                                target: Some(session.clone()),
                            };
                            lanes.lock().unwrap().insert(session, Lane::new(next));
                        }
                        // Failed starts also need a lane for explicit recovery.
                        if let Ok(rows) = actor.db.lock().unwrap().all("sessions") {
                            let mut lanes = lanes.lock().unwrap();
                            for row in rows {
                                let session = row["id"].as_str().unwrap().to_owned();
                                lanes.entry(session.clone()).or_insert_with(|| Lane::new(Actor {
                                    db: actor.db.clone(), workers: HashMap::new(), node: actor.node.clone(),
                                    script: actor.script.clone(), broker: actor.broker.clone(), target: Some(session),
                                }));
                            }
                        }
                    }
                    let _ = call.response.send(result);
                    id
                });
            }

        }
    }
    accept_task.abort();
    while let Some(done) = tasks.join_next().await {
        if let Err(error) = done {
            eprintln!("Drain session task: {error}");
        }
    }
    let actors: Vec<_> = lanes.lock().unwrap().values().cloned().collect();
    for lane in actors {
        lane.actor.lock().await.stop().await;
    }
    global.actor.lock().await.stop().await;
    if let Some(broker) = broker.lock().await.take() {
        broker.stop().await;
    }
    account_monitor.abort();
    let _ = account_monitor.await;
    account.lock().await.stop().await;
    fs::remove_file(socket_path)?;
    drop(lock);
    Ok(())
}
