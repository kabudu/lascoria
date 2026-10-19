use crate::{db::Db, dedicated::Dedicated};
use anyhow::{Context, Result, bail, ensure};
use futures_util::StreamExt;
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    path::Path,
    process::Stdio,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    process::{Child, ChildStdin},
    sync::oneshot,
    time::timeout,
};
use tokio_util::codec::{FramedRead, LinesCodec};
pub type SharedDb = Arc<Mutex<Db>>;
type Pending = Arc<Mutex<HashMap<String, (String, oneshot::Sender<Value>)>>>;
type Slots = Arc<Mutex<HashMap<String, (String, u64)>>>;

pub struct Broker {
    db: SharedDb,
    child: tokio::sync::Mutex<Child>,
    stdin: tokio::sync::Mutex<Option<ChildStdin>>,
    alive: Arc<AtomicBool>,
    pending: Pending,
    slots: Slots,
}
impl Broker {
    pub async fn spawn(node: &str, script: &Path, db: SharedDb) -> Result<Arc<Self>> {
        let mut command = lascoria_runtime::command(node);
        crate::auth::configure(&mut command, &db).await?;
        let mut child = command
            .env(
                "SCH_RELAY_HELPER",
                dunce::simplified(&std::env::current_exe()?),
            )
            .env(
                "SCH_RELAY_STATE_DIR",
                dunce::canonicalize(lascoria_runtime::state_dir())?,
            )
            .arg(script)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .context("Start shared SDK broker")?;
        let stdin = child.stdin.take().unwrap();
        let stdout = child.stdout.take().unwrap();
        let mut stderr = child.stderr.take().unwrap();
        let tail = Arc::new(Mutex::new(Vec::<u8>::new()));
        let error_tail = tail.clone();
        tokio::spawn(async move {
            let mut buffer = [0; 1024];
            while let Ok(n) = stderr.read(&mut buffer).await {
                if n == 0 {
                    break;
                }
                let mut tail = error_tail.lock().unwrap();
                tail.extend_from_slice(&buffer[..n]);
                let surplus = tail.len().saturating_sub(8192);
                tail.drain(..surplus);
            }
        });
        let alive = Arc::new(AtomicBool::new(true));
        let pending: Pending = Arc::new(Mutex::new(HashMap::new()));
        let slots: Slots = Arc::new(Mutex::new(HashMap::new()));
        let broker = Arc::new(Self {
            db: db.clone(),
            child: tokio::sync::Mutex::new(child),
            stdin: tokio::sync::Mutex::new(Some(stdin)),
            alive: alive.clone(),
            pending: pending.clone(),
            slots: slots.clone(),
        });
        let dead_broker = Arc::downgrade(&broker);
        tokio::spawn(async move {
            let mut frames =
                FramedRead::new(stdout, LinesCodec::new_with_max_length(4 * 1024 * 1024));
            let mut reason = json!({"kind":"brokerEof"});
            while let Some(frame) = frames.next().await {
                let frame: Value =
                    match frame.ok().and_then(|line| serde_json::from_str(&line).ok()) {
                        Some(value) => value,
                        None => {
                            reason = json!({"kind":"invalidBrokerFrame"});
                            break;
                        }
                    };
                let key = frame["slot"].as_str().unwrap_or("");
                let target = slots.lock().unwrap().get(key).cloned();
                match frame["kind"].as_str() {
                    Some("response") => {
                        let id = frame["id"].as_str().unwrap_or("");
                        let mut waiting = pending.lock().unwrap();
                        if waiting.get(id).is_some_and(|(slot, _)| slot == key)
                            && let Some((_, tx)) = waiting.remove(id)
                        {
                            let _ = tx.send(frame);
                        }
                    }
                    Some("state") => {
                        let database = db.lock().unwrap();
                        // Check liveness under the same lock as interruption persistence.
                        // A frame already read before shutdown must not restore current state.
                        if !alive.load(Ordering::SeqCst) {
                            continue;
                        }
                        if let Some((session, generation)) = target
                            && let Err(error) = database.state(
                                &session,
                                generation,
                                frame["state"].clone(),
                                &Value::Null,
                                &frame["facts"],
                            )
                        {
                            reason = json!({"kind":"persistenceFailure","error":error.to_string()});
                            break;
                        }
                    }
                    Some("usage") => {
                        // A host's usage/changed notification: account data, not session state.
                        if alive.load(Ordering::SeqCst) && target.is_some() {
                            crate::usage::record(&frame["usage"], crate::db::now_ms() as u64);
                        }
                    }
                    Some("death") => {
                        if let Some((session, generation)) = target {
                            if let Err(error) = db.lock().unwrap().interrupt(
                                &session,
                                generation,
                                frame["exit"].clone(),
                            ) {
                                reason =
                                    json!({"kind":"persistenceFailure","error":error.to_string()});
                                break;
                            }
                            pending.lock().unwrap().retain(|_, (slot, _)| slot != key);
                        }
                    }
                    _ => {
                        reason = json!({"kind":"unknownBrokerFrame"});
                        break;
                    }
                }
            }
            alive.store(false, Ordering::SeqCst);
            pending.lock().unwrap().clear();
            reason["stderrTail"] =
                json!(String::from_utf8_lossy(&tail.lock().unwrap()).to_string());
            for (session, generation) in slots.lock().unwrap().values() {
                if let Err(error) =
                    db.lock()
                        .unwrap()
                        .interrupt(session, *generation, reason.clone())
                {
                    eprintln!("Persist broker interruption: {error}");
                }
            }
            if let Some(broker) = dead_broker.upgrade() {
                broker.stop().await;
            }
        });
        Ok(broker)
    }
    pub fn alive(&self) -> bool {
        self.alive.load(Ordering::SeqCst)
    }
    async fn call(
        &self,
        key: &str,
        session: &str,
        generation: u64,
        operation: &str,
        request: Value,
    ) -> Result<Value> {
        ensure!(self.alive(), "SDK broker unavailable");
        let id = request["id"]
            .as_str()
            .context("Missing broker request ID")?
            .to_string();
        let (tx, rx) = oneshot::channel();
        let line = format!(
            "{}\n",
            json!({"id":id,"slot":key,"sessionId":session,"generation":generation,"operation":operation,"request":request})
        );
        if line.len() > 65536 {
            return Ok(
                json!({"kind":"response","id":id,"error":{"rejected":true,"message":"SDK request exceeds broker frame budget"}}),
            );
        }
        self.pending
            .lock()
            .unwrap()
            .insert(id.clone(), (key.to_string(), tx));
        let result = timeout(Duration::from_secs(15), async {
            {
                let mut guard = self.stdin.lock().await;
                let input = guard.as_mut().context("Broker stdin closed")?;
                input.write_all(line.as_bytes()).await?;
                input.flush().await?;
            }
            Ok::<Value, anyhow::Error>(rx.await?)
        })
        .await;
        self.pending.lock().unwrap().remove(&id);
        match result {
            Ok(result) => result,
            Err(_) => bail!("SDK context timed out; outcome unknown"),
        }
    }
    pub async fn stop(&self) {
        if self.alive.swap(false, Ordering::SeqCst) {
            self.pending.lock().unwrap().clear();
            for (session, generation) in self.slots.lock().unwrap().values() {
                if let Err(error) = self.db.lock().unwrap().interrupt(
                    session,
                    *generation,
                    json!({"kind":"brokerStopping"}),
                ) {
                    eprintln!("Persist broker shutdown: {error}");
                }
            }
        }
        self.stdin.lock().await.take();
        let mut child = self.child.lock().await;
        if timeout(Duration::from_secs(15), child.wait())
            .await
            .is_err()
        {
            let _ = child.kill().await;
            let _ = child.wait().await;
        }
    }
}
enum Backend {
    Dedicated(Box<Dedicated>),
    Shared {
        broker: Arc<Broker>,
        key: String,
        session: String,
        generation: u64,
    },
}
pub struct Worker {
    backend: Backend,
    pub ready: Value,
    session: String,
    generation: u64,
}
impl Worker {
    pub async fn spawn(
        node: &str,
        script: &Path,
        db: SharedDb,
        session: String,
        generation: u64,
        pool: &tokio::sync::Mutex<Option<Arc<Broker>>>,
    ) -> Result<Self> {
        if std::env::var_os("SCH_WORKER").is_some()
            || std::env::var_os("SCH_DEDICATED_WORKERS").is_some()
        {
            let worker = Dedicated::spawn(node, script, db, session.clone(), generation).await?;
            return Ok(Self {
                ready: worker.ready.clone(),
                backend: Backend::Dedicated(Box::new(worker)),
                session,
                generation,
            });
        }
        let mut pool = pool.lock().await;
        if pool.as_ref().is_none_or(|broker| !broker.alive()) {
            if let Some(old) = pool.take() {
                old.stop().await;
            }
            *pool = Some(Broker::spawn(node, &script.with_file_name("broker.js"), db).await?);
        }
        let broker = pool.as_ref().unwrap().clone();
        drop(pool); // Context handshakes must not serialize independent session recovery.
        let key = format!("{session}:{generation}");
        broker
            .slots
            .lock()
            .unwrap()
            .insert(key.clone(), (session.clone(), generation));
        let mut worker = Self {
            ready: Value::Null,
            backend: Backend::Shared {
                broker: broker.clone(),
                key: key.clone(),
                session: session.clone(),
                generation,
            },
            session: session.clone(),
            generation,
        };
        let result = broker
            .call(
                &key,
                &session,
                generation,
                "open",
                json!({"id":uuid::Uuid::new_v4().to_string()}),
            )
            .await;
        match result {
            Ok(frame) if frame.get("error").is_none() && frame["result"]["kind"] == "ready" => {
                worker.ready = frame["result"].clone();
                Ok(worker)
            }
            other => {
                worker.stop().await;
                bail!("SDK context handshake failed: {other:?}")
            }
        }
    }
    pub async fn call(&mut self, mut request: Value) -> Result<Value> {
        // The helper capability goes only to the worker that configures the host's MCP
        // server; it is added after journalling and never stored (F1).
        if ["start", "resume"].contains(&request["operation"].as_str().unwrap_or(""))
            && let Some(capability) = crate::relay_identity::current(&self.session)
        {
            request["params"]["relayCapability"] = json!(capability);
        }
        match &mut self.backend {
            Backend::Dedicated(worker) => worker.call(request).await,
            Backend::Shared {
                broker,
                key,
                session,
                generation,
            } => {
                let result = broker
                    .call(key, session, *generation, "call", request)
                    .await;
                if result.is_err() {
                    self.stop().await;
                }
                result
            }
        }
    }
    pub async fn stop(&mut self) {
        crate::relay_identity::revoke(&self.session, self.generation);
        match &mut self.backend {
            Backend::Dedicated(worker) => worker.stop().await,
            Backend::Shared {
                broker,
                key,
                session,
                generation,
            } => {
                if broker.alive() {
                    let closed = broker
                        .call(
                            key,
                            session,
                            *generation,
                            "close",
                            json!({"id":uuid::Uuid::new_v4().to_string()}),
                        )
                        .await;
                    if !closed
                        .as_ref()
                        .is_ok_and(|frame| frame.get("error").is_none())
                    {
                        broker.stop().await;
                    }
                }
                if let Err(error) = broker.db.lock().unwrap().interrupt(
                    session,
                    *generation,
                    json!({"kind":"contextClosed"}),
                ) {
                    eprintln!("Persist context close: {error}");
                }
                broker.slots.lock().unwrap().remove(key);
            }
        }
    }
}
