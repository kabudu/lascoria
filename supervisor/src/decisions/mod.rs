//! R10: explicitly requested, separately billed advice. No Muse authority or automatic actions.
mod providers;
use crate::{
    db::{Db, now_ms},
    review,
    worker::SharedDb,
};
use anyhow::{Context, Result, ensure};
use futures_util::StreamExt;
use providers::{body, provider, question, validated};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    path::Path,
    sync::{Mutex, OnceLock},
    time::{Duration, Instant},
};
use tokio::sync::{Mutex as AsyncMutex, Semaphore};
use tokio_util::sync::CancellationToken;

const CONFIG: &str = "decision-config-v1";
#[cfg(not(test))]
const VAULT: &str = "dev.lascoria.decision-credentials";
const INPUT_LIMIT: usize = 32_000;
const RESPONSE_LIMIT: usize = 32_768;
const RUN_LIMIT: usize = 5_000;
const FULL_RESULTS: usize = 100;
const RUBRIC: &str = "manual-review-v1";
const IDS: [&str; 3] = ["jev", "subq", "openai"];

fn hash(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}
fn config(db: &Db) -> Result<Value> {
    let cfg = db
        .get("presentation", CONFIG)?
        .unwrap_or(json!({"revision":0,"providers":{}}));
    ensure!(
        cfg["revision"]
            .as_u64()
            .is_some_and(|n| n < 9_007_199_254_740_000)
            && cfg["providers"]
                .as_object()
                .is_some_and(|v| v.len() <= IDS.len()),
        "Integration settings are not compatible; use a compatible build or restore a backup"
    );
    Ok(cfg)
}
#[cfg(test)]
fn runs(db: &Db) -> Result<Vec<Value>> {
    db.all("decisions")
}

fn read_run(db: &Db, id: &str) -> Result<Option<Value>> {
    use rusqlite::OptionalExtension;
    let length: Option<i64> =
        db.0.query_row(
            "SELECT length(CAST(value AS BLOB)) FROM decisions WHERE id=?1",
            [id],
            |row| row.get(0),
        )
        .optional()?;
    ensure!(
        length.is_none_or(|n| (0..=65536).contains(&n)),
        "Decision record exceeds its storage budget"
    );
    let row = db.get("decisions", id)?;
    if let Some(row) = &row {
        ensure!(
            row.is_object()
                && row["id"] == id
                && row["fingerprint"]
                    .as_str()
                    .is_some_and(|v| !v.is_empty() && v.len() <= 128),
            "Decision identity is invalid; no call was sent"
        );
    }
    Ok(row)
}
fn recent_runs(db: &Db) -> Result<Vec<Value>> {
    let mut query =
        db.0.prepare("SELECT id FROM decisions ORDER BY rowid DESC LIMIT 100")?;
    let ids = query
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    ids.iter()
        .map(|id| read_run(db, id)?.context("Decision record disappeared"))
        .collect()
}
fn save_run(db: &Db, row: Value) -> Result<()> {
    use rusqlite::OptionalExtension;
    let id = row["id"].as_str().context("Decision identity missing")?;
    let transaction = db.0.unchecked_transaction()?;
    let previous = read_run(db, id)?;
    if let Some(previous) = &previous {
        ensure!(
            previous["fingerprint"] == row["fingerprint"],
            "Decision identity changed"
        );
        if previous["status"] == "retained" {
            return Ok(());
        }
    }
    if previous.is_none() {
        ensure!(
            db.count("decisions")? < RUN_LIMIT,
            "Decision request history is full; assistance is paused to preserve paid-request identities"
        );
    }
    ensure!(
        row.to_string().len() <= 65536,
        "Decision record exceeds its storage budget"
    );
    db.put("decisions", id, &row)?;
    let cutoff: Option<i64> = transaction
        .query_row(
            "SELECT rowid FROM decisions ORDER BY rowid DESC LIMIT 1 OFFSET ?1",
            [FULL_RESULTS as i64],
            |row| row.get(0),
        )
        .optional()?;
    if let Some(cutoff) = cutoff {
        // Compact only the newly old row and, when necessary, a late completion of an
        // already old request. Both predicates use primary identities, never a history scan.
        const PRUNE: &str =
            "json_set(json_remove(value,'$.result','$.question'),'$.detailsPruned',json('true'))";
        transaction.execute(&format!("UPDATE decisions SET value={PRUNE} WHERE rowid=?1 AND (json_type(value,'$.result') IS NOT NULL OR json_type(value,'$.question') IS NOT NULL)"),[cutoff])?;
        transaction.execute(&format!("UPDATE decisions SET value={PRUNE} WHERE id=?1 AND rowid<?2 AND (json_type(value,'$.result') IS NOT NULL OR json_type(value,'$.question') IS NOT NULL)"),rusqlite::params![id,cutoff])?;
    }
    transaction.commit()?;
    Ok(())
}
fn id(params: &Value, key: &str) -> Result<String> {
    let value = params[key]
        .as_str()
        .context("Required identifier missing")?;
    ensure!(
        !value.is_empty()
            && value.len() <= 100
            && value
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-'),
        "Invalid identifier"
    );
    Ok(value.to_owned())
}
fn workspace(db: &Db, session: &str) -> Result<(String, String)> {
    let row = db.get("sessions", session)?.context("Unknown session")?;
    ensure!(
        row["lifecycle"] != "archived",
        "Open a session before using assistance"
    );
    let path = row["workspace"]
        .as_str()
        .context("Workspace missing")?
        .to_owned();
    Ok((hash(path.as_bytes()), path))
}
struct Active<'a> {
    entries: &'a Mutex<HashMap<String, CancellationToken>>,
    id: String,
}
impl Drop for Active<'_> {
    fn drop(&mut self) {
        self.entries.lock().unwrap().remove(&self.id);
    }
}
struct Service {
    epoch: String,
    client: reqwest::Client,
    admission: Semaphore,
    control: AsyncMutex<()>,
    active: Mutex<HashMap<String, CancellationToken>>,
    #[cfg(test)]
    test_keys: Mutex<HashMap<String, Vec<u8>>>,
    #[cfg(test)]
    endpoint: Option<String>,
}
impl Service {
    fn new() -> Result<Self> {
        Ok(Self {
            epoch: uuid::Uuid::new_v4().to_string(),
            client: reqwest::Client::builder()
                .pool_max_idle_per_host(1)
                .pool_idle_timeout(Duration::from_secs(30))
                .connect_timeout(Duration::from_secs(5))
                .timeout(Duration::from_secs(20))
                .redirect(reqwest::redirect::Policy::none())
                .retry(reqwest::retry::never())
                .build()?,
            admission: Semaphore::new(2),
            control: AsyncMutex::new(()),
            active: Mutex::new(HashMap::new()),
            #[cfg(test)]
            test_keys: Mutex::new(HashMap::new()),
            #[cfg(test)]
            endpoint: None,
        })
    }
    #[cfg(not(test))]
    fn account(provider: &str) -> String {
        let root = lascoria_runtime::state_dir();
        let root = std::fs::canonicalize(&root).unwrap_or(root);
        format!("{}:{provider}", hash(root.as_os_str().as_encoded_bytes()))
    }
    async fn key(&self, provider: &str) -> Result<Option<Vec<u8>>> {
        #[cfg(test)]
        {
            return Ok(self.test_keys.lock().unwrap().get(provider).cloned());
        }
        #[cfg(not(test))]
        crate::credentials::read(VAULT, Self::account(provider)).await
    }
    async fn set_key(&self, provider: &str, key: Option<Vec<u8>>) -> Result<()> {
        #[cfg(test)]
        {
            let mut keys = self.test_keys.lock().unwrap();
            if let Some(key) = key {
                keys.insert(provider.to_owned(), key);
            } else {
                keys.remove(provider);
            }
            Ok(())
        }
        #[cfg(not(test))]
        crate::credentials::write(VAULT, Self::account(provider), key).await
    }
    async fn send(
        &self,
        provider_id: &str,
        model: &str,
        input: &str,
        q: &Value,
        key: Vec<u8>,
    ) -> Result<Value> {
        ensure!(
            (8..=4096).contains(&key.len()) && key.iter().all(|b| (33..=126).contains(b)),
            "Saved API key is invalid; replace it in Settings"
        );
        let (_, endpoint, _, _) = provider(provider_id)?;
        #[cfg(test)]
        let endpoint = self.endpoint.as_deref().unwrap_or(endpoint);
        let mut header =
            reqwest::header::HeaderValue::from_bytes(&[b"Bearer ".as_slice(), &key].concat())
                .context("Invalid API key")?;
        header.set_sensitive(true);
        let response = self.client.post(endpoint).header(reqwest::header::AUTHORIZATION, header).json(&body(provider_id,model,input,q)).send().await.context("Decision provider unavailable; the request may have been billed. No retry was sent")?;
        let request_id = response
            .headers()
            .get("x-request-id")
            .or_else(|| response.headers().get("request-id"))
            .and_then(|h| h.to_str().ok())
            .filter(|s| {
                s.len() <= 200
                    && !s
                        .as_bytes()
                        .windows(key.len())
                        .any(|slice| slice == key.as_slice())
                    && s.bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
            })
            .map(str::to_owned);
        let status = response.status().as_u16();
        let reason = match status {
            401 => "The provider rejected this key. Update it in Decision assistance settings",
            402 => "Provider billing or credits need attention in your provider account",
            403 => {
                "This provider key cannot use the chosen model. Check its access and model setting"
            }
            400 | 422 => {
                "The provider rejected the model or question. Check its settings and the preview"
            }
            429 => "The provider's rate limit was reached. Wait before starting a new request",
            500..=599 => "The provider is temporarily unavailable",
            _ => "The provider did not accept this request",
        };
        ensure!(
            response.status().is_success(),
            "{reason} (HTTP {status}). No retry was sent"
        );
        ensure!(
            response
                .content_length()
                .is_none_or(|n| n <= RESPONSE_LIMIT as u64),
            "Decision response exceeds 32 KiB"
        );
        let mut bytes = Vec::new();
        let mut stream = response.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk =
                chunk.context("Incomplete decision response; the request may have been billed")?;
            ensure!(
                bytes.len() + chunk.len() <= RESPONSE_LIMIT,
                "Decision response exceeds 32 KiB"
            );
            bytes.extend_from_slice(&chunk);
        }
        ensure!(
            !bytes
                .windows(key.len())
                .any(|slice| slice == key.as_slice()),
            "Provider response contained a credential and was discarded"
        );
        let value: Value =
            serde_json::from_slice(&bytes).context("Decision response was not valid JSON")?;
        fn contains_key(value: &Value, key: &str) -> bool {
            match value {
                Value::String(text) => text.contains(key),
                Value::Array(values) => values.iter().any(|v| contains_key(v, key)),
                Value::Object(values) => values
                    .iter()
                    .any(|(k, v)| k.contains(key) || contains_key(v, key)),
                _ => false,
            }
        }
        ensure!(
            !contains_key(&value, std::str::from_utf8(&key)?),
            "Provider response contained a credential and was discarded"
        );
        let mut result = validated(provider_id, &value, q)?;
        result["providerRequestId"] = json!(request_id);
        Ok(result)
    }
    async fn handle(
        &self,
        db: SharedDb,
        operation: &str,
        params: &Value,
        request_id: &str,
    ) -> Result<Value> {
        if operation == "decision/status" {
            let database = db.lock().unwrap();
            let cfg = config(&database)?;
            let providers: Vec<_> = IDS.iter().map(|id| {
                let (name, endpoint, model, policy) = provider(id).unwrap();
                let saved = &cfg["providers"][id];
                json!({"id":id,"name":name,"endpoint":endpoint,"defaultModel":model,"policyUrl":policy,"model":saved["model"].as_str().unwrap_or(model),"enabled":saved["enabled"] == true,"keySaved":saved["keySaved"] == true,"workspaces":saved["workspaces"].as_array().cloned().unwrap_or_default()})
            }).collect();
            let workspace = params["sessionId"]
                .as_str()
                .map(|s| workspace(&database, s).map(|v| v.0))
                .transpose()?;
            return Ok(
                json!({"revision":cfg["revision"],"admissionEpoch":self.epoch,"providers":providers,"workspace":workspace,"recent":recent_runs(&database)?.into_iter().map(|mut r| { if r["status"] == "sending" && !self.active.lock().unwrap().contains_key(r["id"].as_str().unwrap_or_default()) {r["status"] = json!("unknown");} r }).collect::<Vec<_>>(),"limits":{"concurrency":2,"inputBytes":INPUT_LIMIT,"responseBytes":RESPONSE_LIMIT,"requestSeconds":20,"retainedResults":FULL_RESULTS,"requestIdentities":RUN_LIMIT}}),
            );
        }
        if operation == "decision/result" {
            let target = id(params, "requestId")?;
            let mut row = read_run(&db.lock().unwrap(),&target)?.context("No recorded request yet; nothing was resent. Review the preview again before starting a new request")?;
            if row["status"] == "sending" && !self.active.lock().unwrap().contains_key(&target) {
                row["status"] = json!("unknown");
            }
            row["reused"] = json!(true);
            return Ok(row);
        }
        if operation == "decision/cancel" {
            let target = id(params, "requestId")?;
            let active = self.active.lock().unwrap();
            let found = active.get(&target);
            if let Some(token) = found {
                token.cancel();
            }
            return Ok(json!({"requested":found.is_some(),"mayHaveBeenBilled":true}));
        }
        let provider_id = id(params, "provider")?;
        let (_, _, default_model, _) = provider(&provider_id)?;
        if [
            "decision/configure",
            "decision/setKey",
            "decision/forgetKey",
        ]
        .contains(&operation)
        {
            let _guard = self
                .control
                .try_lock()
                .context("Another integration change is in progress")?;
            let mut cfg = config(&db.lock().unwrap())?;
            ensure!(
                params["expectedRevision"] == cfg["revision"],
                "Integration settings changed; reload before saving"
            );
            let mut saved = cfg["providers"][&provider_id]
                .as_object()
                .cloned()
                .map(Value::Object)
                .unwrap_or(
                    json!({"model":default_model,"enabled":false,"workspaces":[],"keySaved":false}),
                );
            if operation == "decision/setKey" {
                let key = params["apiKey"].as_str().context("API key required")?;
                ensure!(
                    (8..=4096).contains(&key.len()) && key.bytes().all(|b| (33..=126).contains(&b)),
                    "API key must be 8 to 4096 printable characters without spaces"
                );
                // Replacement keys can belong to a different billed account. Revoke consent
                // and invalidate previews before any vault write, including a failed write.
                saved["enabled"] = json!(false);
                saved["workspaces"] = json!([]);
                saved["keySaved"] = json!(false);
                cfg["providers"][&provider_id] = saved.clone();
                cfg["revision"] = json!(cfg["revision"].as_u64().unwrap() + 1);
                db.lock().unwrap().put("presentation", CONFIG, &cfg)?;
                self.set_key(&provider_id, Some(key.as_bytes().to_vec()))
                    .await?;
                saved["keySaved"] = json!(true);
            } else if operation == "decision/forgetKey" {
                // Revoke admission before vault I/O; a failed vault deletion never re-enables advice.
                saved["enabled"] = json!(false);
                saved["workspaces"] = json!([]);
                saved["keySaved"] = json!(false);
                cfg["providers"][&provider_id] = saved.clone();
                cfg["revision"] = json!(cfg["revision"].as_u64().unwrap() + 1);
                db.lock().unwrap().put("presentation", CONFIG, &cfg)?;
                self.set_key(&provider_id, None).await?;
                return Ok(json!({"revision":cfg["revision"]}));
            } else {
                let model = params["model"].as_str().context("Model required")?;
                ensure!(
                    !model.is_empty()
                        && model.len() <= 128
                        && model
                            .bytes()
                            .all(|b| b.is_ascii_alphanumeric() || b"-._:/".contains(&b)),
                    "Invalid model identifier"
                );
                let enabled = params["enabled"]
                    .as_bool()
                    .context("Enable choice required")?;
                if enabled {
                    ensure!(
                        self.key(&provider_id).await?.is_some(),
                        "Save this provider's key first"
                    );
                }
                saved["model"] = json!(model);
                saved["enabled"] = json!(enabled);
                if let Some(allowed) = params["workspaceEnabled"].as_bool() {
                    let session = id(params, "sessionId")?;
                    let (scope, _) = workspace(&db.lock().unwrap(), &session)?;
                    let mut scopes = saved["workspaces"].as_array().cloned().unwrap_or_default();
                    scopes.retain(|s| s != &scope);
                    if allowed {
                        ensure!(
                            scopes.len() < 32,
                            "Workspace limit reached; disable an unused workspace first"
                        );
                        scopes.push(json!(scope));
                    }
                    saved["workspaces"] = json!(scopes);
                }
            }
            cfg["providers"][&provider_id] = saved;
            cfg["revision"] = json!(cfg["revision"].as_u64().unwrap() + 1);
            db.lock().unwrap().put("presentation", CONFIG, &cfg)?;
            return Ok(json!({"revision":cfg["revision"]}));
        }
        ensure!(
            ["decision/preview", "decision/evaluate", "decision/test"].contains(&operation),
            "Unsupported decision operation"
        );
        let q = if operation == "decision/test" {
            json!({"type":"predicate","prompt":"Does the supplied text say that two plus two is four?"})
        } else {
            question(params)?
        };
        let cfg = config(&db.lock().unwrap())?;
        let saved = &cfg["providers"][&provider_id];
        let model = saved["model"].as_str().unwrap_or(default_model).to_owned();
        let (input, source, scope, root) = if operation == "decision/test" {
            (
                "Two plus two is four.".to_owned(),
                json!({"kind":"connectionTest"}),
                String::new(),
                None,
            )
        } else {
            let session = id(params, "sessionId")?;
            let artifact_id = id(params, "artifactId")?;
            let (scope, root, artifact) = {
                let database = db.lock().unwrap();
                let (scope, root) = workspace(&database, &session)?;
                let artifact = database
                    .get("artifacts", &artifact_id)?
                    .context("Unknown snapshot")?;
                ensure!(
                    artifact["sessionId"] == session,
                    "Snapshot belongs to another session"
                );
                ensure!(
                    saved["enabled"] == true
                        && saved["workspaces"]
                            .as_array()
                            .is_some_and(|v| v.iter().any(|v| v == &scope)),
                    "Enable this provider for the current workspace in Settings first"
                );
                (scope, root, artifact)
            };
            let input =
                json!({"patch":artifact["patch"],"newFiles":artifact["untracked"]}).to_string();
            ensure!(
                input.len() <= INPUT_LIMIT,
                "Snapshot exceeds the 32 KB disclosure limit; choose a smaller capture"
            );
            (
                input,
                json!({"sessionId":session,"artifactId":artifact_id,"fingerprint":artifact["fingerprint"],"revision":artifact["revision"]}),
                scope,
                Some(root),
            )
        };
        let fingerprint = hash(json!({"provider":provider_id,"model":model,"input":input,"question":q,"rubric":RUBRIC,"source":source,"configRevision":cfg["revision"],"admissionEpoch":self.epoch}).to_string().as_bytes());
        if operation == "decision/preview" {
            return Ok(
                json!({"input":input,"payload":body(&provider_id,&model,&input,&q),"bytes":input.len(),"question":q,"source":source,"fingerprint":fingerprint,"model":model,"endpoint":provider(&provider_id)?.1,"rubricVersion":RUBRIC}),
            );
        }
        // Retrying an identity returns its outcome, never re-sends. This survives supervisor death.
        {
            let database = db.lock().unwrap();
            if let Some(mut prior) = read_run(&database, request_id)? {
                ensure!(
                    prior["fingerprint"] == fingerprint,
                    "Decision request ID reused with changed input"
                );
                if prior["status"] == "sending"
                    && !self.active.lock().unwrap().contains_key(request_id)
                {
                    prior["status"] = json!("unknown");
                    prior["message"] = json!(
                        "The app stopped before the outcome was recorded. This request may have been billed and will not be resent"
                    );
                }
                prior["reused"] = json!(true);
                return Ok(prior);
            }
        }
        if operation == "decision/evaluate" {
            ensure!(
                params["fingerprint"] == fingerprint,
                "The disclosure preview changed; review it again before sending"
            );
        }
        if operation == "decision/test" {
            ensure!(
                params["admissionEpoch"] == self.epoch,
                "The background service restarted; reload integration settings before testing the connection"
            );
        }
        let _permit = self
            .admission
            .try_acquire()
            .context("Two decision requests are already running; wait or cancel one")?;
        let cancellation = CancellationToken::new();
        {
            let mut active = self.active.lock().unwrap();
            ensure!(
                !active.contains_key(request_id),
                "Decision request already in flight"
            );
            active.insert(request_id.to_owned(), cancellation.clone());
        }
        let _active = Active {
            entries: &self.active,
            id: request_id.to_owned(),
        };
        let key = self
            .key(&provider_id)
            .await?
            .context("Provider key unavailable; save it again in Settings")?;
        // Check the exact capture before any data leaves this machine.
        if let Some(root) = &root {
            let current =
                tokio::time::timeout(Duration::from_secs(10), review::capture(Path::new(root)))
                    .await
                    .context("Snapshot check timed out; nothing was sent")??;
            ensure!(
                current["fingerprint"] == source["fingerprint"],
                "Files changed since this snapshot; save a fresh snapshot before sending"
            );
        }
        ensure!(
            config(&db.lock().unwrap())?["revision"] == cfg["revision"],
            "Integration changed; nothing was sent"
        );
        ensure!(
            !cancellation.is_cancelled(),
            "Cancelled before sending; nothing was sent"
        );
        let mut row = json!({"id":request_id,"provider":provider_id,"model":model,"fingerprint":fingerprint,"source":source,"workspace":scope,"configRevision":cfg["revision"],"rubricVersion":RUBRIC,"question":q,"status":"sending","createdAtMillis":now_ms(),"inputBytes":input.len(),"mayHaveBeenBilled":true});
        // Reserve both the identity and active token while holding the DB lock. A concurrent retry
        // can observe either the running request or its persisted outcome, never another send.
        {
            let database = db.lock().unwrap();
            ensure!(
                read_run(&database, request_id)?.is_none(),
                "Decision request already admitted; read its result"
            );
            save_run(&database, row.clone())?;
        }
        let began = Instant::now();
        let result = tokio::select! {
            biased;
            _ = cancellation.cancelled() => Err(anyhow::anyhow!("Request cancelled. It may have been billed; no retry was sent")),
            result = self.send(&provider_id,&model,&input,&q,key) => result,
        };
        row["latencyMs"] = json!(began.elapsed().as_millis() as u64);
        row["finishedAtMillis"] = json!(now_ms());
        match result {
            Ok(result) => {
                row["result"] = result;
                let unchanged = config(&db.lock().unwrap())?["revision"] == cfg["revision"];
                let fresh = if let Some(root) = &root {
                    tokio::time::timeout(Duration::from_secs(10), review::capture(Path::new(root)))
                        .await
                        .ok()
                        .and_then(Result::ok)
                        .is_some_and(|v| v["fingerprint"] == source["fingerprint"])
                } else {
                    true
                };
                row["status"] = json!(if unchanged && fresh && !cancellation.is_cancelled() {
                    "completed"
                } else {
                    "stale"
                });
                row["checkedAtMillis"] = json!(now_ms());
            }
            Err(error) => {
                row["status"] = json!(if cancellation.is_cancelled() {
                    "cancelled"
                } else {
                    "failed"
                });
                // Do not retain raw HTTP errors: URLs, response bodies and keys must not leak.
                row["message"] = json!(error.to_string().chars().take(240).collect::<String>());
            }
        }
        let database = db.lock().unwrap();
        if row["status"] == "completed"
            && (config(&database)?["revision"] != cfg["revision"] || cancellation.is_cancelled())
        {
            row["status"] = json!("stale");
        }
        let saved = save_run(&database, row.clone());
        self.active.lock().unwrap().remove(request_id);
        saved?;
        read_run(&database, request_id)?.context("Decision outcome could not be read")
    }
}

pub async fn handle(
    db: SharedDb,
    operation: &str,
    params: &Value,
    request_id: &str,
) -> Result<Value> {
    static SERVICE: OnceLock<std::result::Result<Service, String>> = OnceLock::new();
    let service = SERVICE
        .get_or_init(|| {
            Service::new()
                .map_err(|_| "Decision networking is unavailable; Muse remains usable".to_owned())
        })
        .as_ref()
        .map_err(|e| anyhow::anyhow!(e.clone()))?;
    id(&json!({"id":request_id}), "id")?;
    service.handle(db, operation, params, request_id).await
}

#[cfg(test)]
mod tests;
