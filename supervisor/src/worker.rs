use crate::db::Db;
use anyhow::{Context, Result, bail};
use futures_util::StreamExt;
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    path::Path,
    process::Stdio,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    process::{Child, ChildStdin, Command},
    sync::oneshot,
    task::JoinHandle,
    time::timeout,
};
use tokio_util::codec::{FramedRead, LinesCodec};

type Pending = Arc<Mutex<HashMap<String, oneshot::Sender<Value>>>>;
pub type SharedDb = Arc<Mutex<Db>>;

pub struct Worker {
    pub child: Child,
    stdin: Option<ChildStdin>,
    pending: Pending,
    reader: JoinHandle<()>,
    stderr: JoinHandle<()>,
    pub ready: Value,
}
impl Worker {
    pub async fn spawn(
        node: &str,
        script: &Path,
        db: SharedDb,
        session: String,
        generation: u64,
    ) -> Result<Self> {
        let mut child = Command::new(node)
            .arg(script)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .context("Start Node SDK worker")?;
        let stdin = child.stdin.take().unwrap();
        let stdout = child.stdout.take().unwrap();
        let mut stderr_pipe = child.stderr.take().unwrap();
        let stderr_tail = Arc::new(Mutex::new(Vec::new()));
        let tail = stderr_tail.clone();
        let stderr = tokio::spawn(async move {
            let mut chunk = [0u8; 1024];
            while let Ok(n) = stderr_pipe.read(&mut chunk).await {
                if n == 0 {
                    break;
                }
                let mut tail = tail.lock().unwrap();
                tail.extend_from_slice(&chunk[..n]);
                let surplus = tail.len().saturating_sub(8192);
                if surplus > 0 {
                    tail.drain(..surplus);
                }
            }
        });
        let pending: Pending = Arc::new(Mutex::new(HashMap::new()));
        let waiting = pending.clone();
        let (ready_tx, ready_rx) = oneshot::channel();
        let reader = tokio::spawn(async move {
            let mut ready_tx = Some(ready_tx);
            let mut lines =
                FramedRead::new(stdout, LinesCodec::new_with_max_length(4 * 1024 * 1024));
            let mut reason = json!({"kind":"workerEof"});
            while let Some(line) = lines.next().await {
                let frame: Value = match line.ok().and_then(|line| serde_json::from_str(&line).ok())
                {
                    Some(value) => value,
                    None => {
                        reason = json!({"kind":"invalidWorkerFrame"});
                        break;
                    }
                };
                match frame["kind"].as_str() {
                    Some("ready" | "fatal") => {
                        if let Some(tx) = ready_tx.take() {
                            let _ = tx.send(frame);
                        }
                    }
                    Some("response") => {
                        if let Some(id) = frame["id"].as_str()
                            && let Some(tx) = waiting.lock().unwrap().remove(id)
                        {
                            let _ = tx.send(frame);
                        }
                    }
                    Some("state") => {
                        if let Err(error) = db.lock().unwrap().state(
                            &session,
                            generation,
                            frame["state"].clone(),
                            &frame["event"],
                            &frame["facts"],
                        ) {
                            reason =
                                json!({"kind":"persistenceFailure", "error":error.to_string()});
                            break;
                        }
                    }
                    Some("death") => {
                        reason = frame["exit"].clone();
                    }
                    _ => {
                        reason = json!({"kind":"unknownWorkerFrame"});
                        break;
                    }
                }
            }
            waiting.lock().unwrap().clear();
            reason["stderrTail"] =
                json!(String::from_utf8_lossy(&stderr_tail.lock().unwrap()).to_string());
            if let Err(error) = db.lock().unwrap().interrupt(&session, generation, reason) {
                eprintln!("Persist worker interruption: {error}");
            }
        });
        let mut worker = Self {
            child,
            stdin: Some(stdin),
            pending,
            reader,
            stderr,
            ready: Value::Null,
        };
        match timeout(Duration::from_secs(12), ready_rx).await {
            Ok(Ok(ready)) if ready["kind"] == "ready" => {
                worker.ready = ready;
                Ok(worker)
            }
            outcome => {
                worker.stop().await;
                bail!("SDK worker handshake failed: {outcome:?}");
            }
        }
    }
    pub async fn call(&mut self, request: Value) -> Result<Value> {
        let id = request["id"]
            .as_str()
            .context("Worker request ID missing")?
            .to_string();
        let (tx, rx) = oneshot::channel();
        self.pending.lock().unwrap().insert(id.clone(), tx);
        let line = format!("{request}\n");
        let result = timeout(Duration::from_secs(15), async {
            self.stdin
                .as_mut()
                .context("Worker stdin closed")?
                .write_all(line.as_bytes())
                .await?;
            self.stdin
                .as_mut()
                .context("Worker stdin closed")?
                .flush()
                .await?;
            Ok::<Value, anyhow::Error>(rx.await?)
        })
        .await;
        self.pending.lock().unwrap().remove(&id);
        match result {
            Ok(result) => result,
            Err(_) => {
                self.stop().await;
                bail!("SDK worker timed out; outcome unknown");
            }
        }
    }
    pub async fn stop(&mut self) {
        // Closing stdin invokes the worker's bounded Muse drain. Kill only after that budget.
        drop(self.stdin.take());
        if timeout(Duration::from_secs(4), self.child.wait())
            .await
            .is_err()
        {
            let _ = self.child.kill().await;
            let _ = self.child.wait().await;
        }
        if timeout(Duration::from_secs(1), &mut self.reader)
            .await
            .is_err()
        {
            self.reader.abort();
        }
        if timeout(Duration::from_secs(1), &mut self.stderr)
            .await
            .is_err()
        {
            self.stderr.abort();
        }
    }
}
