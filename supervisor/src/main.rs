mod db;
mod dedicated;
mod metrics;
mod review;
mod worker;
mod workspace;

use anyhow::{Context, Result, bail, ensure};
use db::Db;
use fs2::FileExt;
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    env,
    fs::{self, OpenOptions},
    os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt},
    path::PathBuf,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio::{
    net::{UnixListener, UnixStream},
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
        let wire_id = Uuid::now_v7().to_string();
        let mut command = json!({"id":id,"operation":operation,"params":params,"sessionId":session,"commandId":wire_id,"status":"sending","createdAtMillis":db::now_ms()});
        {
            let db = self.db.lock().unwrap();
            ensure!(
                db.all("commands")?.len() < 2000,
                "Diagnostic command journal limit reached"
            );
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
            return Ok(
                json!({"pid":std::process::id(),"version":db.version(),"features":["modelSelection","sessionSettings","diagnostics","taskWorkspaces"],"sessions":db.all("sessions")?,"commands":commands.into_iter().rev().take(100).collect::<Vec<_>>()}),
            );
        }
        let params = request.get("params").cloned().unwrap_or_else(|| json!({}));
        ensure!(params.is_object(), "Params must be an object");
        if [
            "presentation/get",
            "presentation/save",
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
                ensure!(
                    previous["operation"] == operation && previous["params"] == params,
                    "Request ID reused with different payload"
                );
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
        } else if operation == "transcript" || operation == "output" || operation == "models" {
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
                    json!({"id":Uuid::new_v4().to_string(),"operation":if operation == "output" {"readOutput"} else if operation == "models" {"models"} else {"inspect"},"params":params}),
                )
                .await?;
            ensure!(
                response.get("error").is_none(),
                "Transcript read failed: {}",
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
        if let Some(previous) = self.db.lock().unwrap().get("commands", id)? {
            ensure!(
                previous["operation"] == operation && previous["params"] == params,
                "Request ID reused with different payload"
            );
            return Ok(previous); // No automatic replay of uncertain side effects.
        }
        ensure!(
            self.db.lock().unwrap().all("commands")?.len() < 2000,
            "Diagnostic command journal limit reached"
        );
        if operation == "start" {
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
            let workspace =
                fs::canonicalize(params["workspace"].as_str().context("Workspace required")?)?;
            ensure!(workspace.is_dir(), "Workspace must be a directory");
            ensure!(
                self.db.lock().unwrap().count("sessions")? < 100,
                "Retained session limit reached (100)"
            );
            let session = Uuid::now_v7().to_string();
            let mut managed = Value::Null;
            let workspace = if params["isolated"] == true {
                // Persist intent before filesystem effects. An uncertain retry never creates another worktree.
                workspace::begin(&self.db, id, operation, &params, &session)?;
                let parent = env::var_os("SCH_STATE_DIR")
                    .map(PathBuf::from)
                    .unwrap_or_else(|| {
                        PathBuf::from(env::var_os("HOME").unwrap()).join(".spatial-constellation")
                    })
                    .join("worktrees");
                fs::create_dir_all(&parent)?;
                let target = fs::canonicalize(&parent)?.join(&session);
                let mut planned = json!({"id":session,"workspace":target,"generation":0,"lifecycle":"starting","attempts":0,"interruptions":[],"state":{"current":false},"managedWorkspace":{"source":workspace,"path":target,"branch":format!("lascoria/{session}")}});
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
            let mut row = json!({"id":session,"workspace":workspace,"generation":0,"lifecycle":"starting","attempts":0,"interruptions":[],"state":{"current":false}});
            row["managedWorkspace"] = managed;
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
        if operation == "turn" {
            workspace::idle(&self.db, &row)?;
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
        self.dispatch(id, operation, params.clone(), session, None)
            .await
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
    stream: UnixStream,
    token: String,
    sender: mpsc::Sender<Call>,
    db: SharedDb,
    metrics: Arc<Mutex<metrics::Metrics>>,
) -> Result<()> {
    ensure!(
        stream.peer_cred()?.uid() == unsafe { libc::geteuid() },
        "IPC peer belongs to another user"
    );
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
        started = Some(Instant::now());
        if request["operation"] == "diagnostics" { return Ok(metrics.lock().unwrap().snapshot()); }
        // Snapshot reads bypass session command lanes, including during recovery.
        if request["operation"] == "status" {
            let db = db.lock().unwrap();
            if request["params"]["since"].as_str().is_some_and(|version| version == db.version()) {
                return Ok(json!({"unchanged":true,"version":db.version(),"pid":std::process::id()}));
            }
            return Ok(json!({"pid":std::process::id(),"version":db.version(),"features":["modelSelection","sessionSettings","diagnostics","taskWorkspaces"],"sessions":db.all("sessions")?,"commands":db.all("commands")?.into_iter().rev().take(100).collect::<Vec<_>>()}));
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

#[tokio::main]
async fn main() -> Result<()> {
    let directory = env::var_os("SCH_STATE_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(env::var_os("HOME").unwrap()).join(".spatial-constellation")
        });
    fs::create_dir_all(&directory)?;
    let metadata = fs::symlink_metadata(&directory)?;
    ensure!(
        metadata.is_dir() && metadata.uid() == unsafe { libc::geteuid() },
        "State directory must be owned by this user and cannot be a symlink"
    );
    fs::set_permissions(&directory, fs::Permissions::from_mode(0o700))?;
    let lock = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(directory.join("owner.lock"))?;
    lock.try_lock_exclusive()
        .context("Another supervisor owns this state directory")?;
    let database_path = directory.join("state.sqlite");
    // O_NOFOLLOW also refuses dangling symlinks, unlike Path::exists().
    let database_file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(&database_path)?;
    ensure!(
        database_file.metadata()?.uid() == unsafe { libc::geteuid() },
        "Database must belong to this user"
    );
    drop(database_file);
    let db = Arc::new(Mutex::new(Db::open(&database_path)?));
    fs::set_permissions(&database_path, fs::Permissions::from_mode(0o600))?;
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
    let socket_path = directory.join("supervisor.sock");
    if socket_path.exists() {
        fs::remove_file(&socket_path)?;
    }
    let listener = UnixListener::bind(&socket_path)?;
    fs::set_permissions(&socket_path, fs::Permissions::from_mode(0o600))?;
    let token = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
    let mut token_file = OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(directory.join("token"))?;
    use std::io::Write;
    token_file.write_all(token.as_bytes())?;
    token_file.sync_all()?;
    fs::set_permissions(directory.join("token"), fs::Permissions::from_mode(0o600))?;
    let script = env::var_os("SCH_WORKER")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../src/worker.js"));
    let node = env::var("SCH_NODE").unwrap_or_else(|_| "node".into());
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
    let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
    let mut tick = interval(Duration::from_secs(1));
    println!("{}", json!({"pid":std::process::id(),"socket":socket_path}));
    let metrics = Arc::new(Mutex::new(metrics::Metrics::new()));
    let accept_metrics = metrics.clone();
    let accept_db = db.clone();
    let accept_task = tokio::spawn(async move {
        while let Ok((stream, _)) = listener.accept().await {
            if let Ok(permit) = permits.clone().try_acquire_owned() {
                let sender = sender.clone();
                let token = token.clone();
                let db = accept_db.clone();
                let metrics = accept_metrics.clone();
                tokio::spawn(async move {
                    let _permit = permit;
                    if let Err(error) = connection(stream, token, sender, db, metrics).await {
                        eprintln!("IPC: {error}");
                    }
                });
            }
        }
    });
    loop {
        tokio::select! {
            _ = tokio::signal::ctrl_c() => break,
            _ = term.recv() => break,
            Some(done) = tasks.join_next(), if !tasks.is_empty() => {
                match done {
                    Ok(Some(id)) => { in_flight.remove(&id); }
                    Ok(None) => {}
                    Err(error) => { eprintln!("Session task failed: {error}"); break; }
                }
            }
            _ = tick.tick() => {
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
    fs::remove_file(socket_path)?;
    drop(lock);
    Ok(())
}
