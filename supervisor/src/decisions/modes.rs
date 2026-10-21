//! R10 interaction models (b) background triage and (c) the Muse-callable tool, plus
//! aggregate metrics and the user's agree/disagree overrides.
//!
//! Both modes reuse the manual path's single spending routine (`Service::spend`): bounded
//! admission, identity persisted before egress, no automatic retry and a recorded outcome.
//! Each mode has its own provider choice and its own per-workspace consent, separate from
//! manual reviews; replacing, removing or disabling a provider's key revokes every mode that
//! used it. Answers are advisory: nothing here approves, accepts evidence or drives Muse.
use super::{
    INPUT_LIMIT, Service, SharedDb, Spend, config, hash, id, provider, read_run, save_run,
    workspace,
};
use crate::db::{Db, now_ms};
use anyhow::{Context, Result, bail, ensure};
use serde_json::{Value, json};

pub(super) const MODES: [&str; 2] = ["triage", "tool"];
const SHARES: [&str; 3] = ["request", "reply", "question"];
const TRIAGE_RUBRIC: &str = "triage-v1";
const TOOL_RUBRIC: &str = "muse-tool-v1";
const TOOL_CONTEXT_LIMIT: usize = 16_000;
/// At most this many triage requests start in one pass, so a burst of finished tasks cannot
/// fan out into a burst of paid calls.
const TRIAGE_PER_PASS: usize = 3;

pub(super) fn default_mode(mode: &str) -> Value {
    if mode == "triage" {
        json!({"provider":null,"workspaces":[],"share":["request","reply","question"],"dailyLimit":50})
    } else {
        json!({"provider":null,"workspaces":[],"dailyLimit":50})
    }
}
pub(super) fn mode(cfg: &Value, name: &str) -> Value {
    let saved = &cfg["modes"][name];
    if saved.is_object() {
        saved.clone()
    } else {
        default_mode(name)
    }
}

/// Clears any mode that uses `provider`; called before a key change or disable is stored.
pub(super) fn revoke(cfg: &mut Value, provider_id: &str) {
    for name in MODES {
        if mode(cfg, name)["provider"] == provider_id {
            let mut cleared = mode(cfg, name);
            cleared["provider"] = Value::Null;
            cleared["workspaces"] = json!([]);
            if !cfg["modes"].is_object() {
                cfg["modes"] = json!({});
            }
            cfg["modes"][name] = cleared;
        }
    }
}

pub(super) fn spent_today(db: &Db, purpose: &str) -> Result<i64> {
    let since = now_ms().saturating_sub(86_400_000) as i64;
    Ok(db.0.query_row(
        "SELECT count(*) FROM decisions WHERE json_extract(value,'$.purpose')=?1 AND json_extract(value,'$.createdAtMillis')>=?2",
        rusqlite::params![purpose, since],
        |row| row.get(0),
    )?)
}

fn usable_provider(cfg: &Value, provider_id: &str) -> Result<()> {
    let saved = &cfg["providers"][provider_id];
    ensure!(
        saved["enabled"] == true && saved["keySaved"] == true,
        "Turn this provider on with a saved key first"
    );
    Ok(())
}

/// Text sent for triage, built from the session record, limited to the parts the user chose.
/// The user's own words are used (never Lascoria's hidden context notes).
pub(super) fn triage_input(row: &Value, turn_id: &str, share: &[String]) -> Result<String> {
    let items = row["state"]["items"]
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or_default();
    let tail = |text: &str, n: usize| -> String {
        text.chars()
            .rev()
            .take(n)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect()
    };
    let mut out = String::from(
        "An update from a coding assistant (Muse) working in a software repository.\n",
    );
    for part in share {
        match part.as_str() {
            "request" => {
                let text = items
                    .iter()
                    .find(|i| i["kind"] == "userMessage" && i["turnId"] == turn_id)
                    .and_then(|i| i["displayText"].as_str().or(i["text"].as_str()))
                    .unwrap_or("(not retained)");
                out += &format!("\nThe user asked:\n{}\n", tail(text, 6000));
            }
            "reply" => {
                let text = items
                    .iter()
                    .rev()
                    .find(|i| i["kind"] == "agentMessage" && i["turnId"] == turn_id)
                    .and_then(|i| i["text"].as_str())
                    .unwrap_or("(no reply retained)");
                let outcome = row["state"]["turns"]
                    .as_array()
                    .and_then(|t| t.iter().find(|t| t["turnId"] == turn_id))
                    .and_then(|t| t["terminal"].as_str())
                    .unwrap_or("still running");
                out += &format!(
                    "\nThe assistant's latest reply:\n{}\nTask outcome reported by Muse: {outcome}\n",
                    tail(text, 12000)
                );
            }
            "question" => {
                let waiting = row["state"]["userInputs"].as_array().map_or(0, Vec::len);
                let approvals = row["state"]["approvals"].as_array().map_or(0, Vec::len);
                if waiting + approvals > 0 {
                    out += &format!(
                        "\nThe assistant is waiting for the user: {waiting} question(s) and {approvals} permission request(s).\n"
                    );
                    for input in row["state"]["userInputs"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .take(3)
                    {
                        // Share question text, never the rest of the native request record.
                        let prompts = input["questions"]
                            .as_array()
                            .into_iter()
                            .flatten()
                            .take(3)
                            .filter_map(|q| q["question"].as_str())
                            .collect::<Vec<_>>();
                        if prompts.is_empty() {
                            if let Some(prompt) = input["requested"]["prompt"].as_str() {
                                out += &format!("Question: {}\n", tail(prompt, 3000));
                            }
                        } else {
                            for prompt in prompts {
                                out += &format!("Question: {}\n", tail(prompt, 3000));
                            }
                        }
                    }
                }
            }
            _ => bail!("Unknown part to share"),
        }
    }
    ensure!(
        out.len() <= INPUT_LIMIT,
        "Triage text exceeds the 32 KB disclosure limit"
    );
    Ok(out)
}

/// Reconstruct only the selected session's current triage identity. One read suffices
/// for all its retained answers; history polling must not read the session per answer.
pub(super) fn current_source(db: &Db, cfg: &Value, session: &str) -> Result<Option<Value>> {
    let Some(row) = db.get("sessions", session)? else {
        return Ok(None);
    };
    if row["lifecycle"] == "archived" {
        return Ok(None);
    }
    let Some(turn) = row["state"]["turns"].as_array().and_then(|t| t.last()) else {
        return Ok(None);
    };
    let Some(turn_id) = turn["turnId"].as_str() else {
        return Ok(None);
    };
    let waiting = row["state"]["userInputs"]
        .as_array()
        .is_some_and(|a| !a.is_empty())
        || row["state"]["approvals"]
            .as_array()
            .is_some_and(|a| !a.is_empty());
    let saved = mode(cfg, "triage");
    let share = saved["share"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|v| v.as_str().map(str::to_owned))
        .collect::<Vec<_>>();
    Ok(triage_input(&row,turn_id,&share).ok().map(|input| json!({"kind":"triage","sessionId":session,"turnId":turn_id,"waiting":waiting,"inputFingerprint":hash(input.as_bytes())})))
}

pub(super) fn source_current(db: &Db, source: &Value) -> Result<bool> {
    if source["kind"] != "triage" {
        return Ok(true);
    }
    let cfg = config(db)?;
    Ok(
        current_source(db, &cfg, source["sessionId"].as_str().unwrap_or_default())?.as_ref()
            == Some(source),
    )
}

fn triage_question() -> Value {
    json!({"type":"predicate","prompt":"Does this update from a coding assistant need the user's attention soon? Answer yes if the user should look at it soon (it is waiting for them, failed, or finished something they need to check); no if it can wait until they next check in."})
}

/// A question Muse asks through the tool, validated into the shared question form.
pub(super) fn tool_question(args: &Value) -> Result<Value> {
    let prompt = args["question"]
        .as_str()
        .context("Question required")?
        .trim();
    ensure!(
        !prompt.is_empty() && prompt.len() <= 2_000,
        "Ask one question of at most 2,000 bytes"
    );
    let options: Vec<&str> = args["options"]
        .as_str()
        .unwrap_or("")
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .collect();
    let kind = match args["kind"].as_str().unwrap_or("yes_no") {
        "yes_no" => "predicate",
        "choice" => "choice",
        "score" => "score",
        _ => bail!("Use kind yes_no, choice or score"),
    };
    let mut q = json!({"type":kind,"prompt":prompt});
    if kind != "predicate" {
        q["options"] = json!(options);
    }
    // Same bounds as manual questions: 2 to 8 short, unique options.
    super::question(&json!({"question":q}))
}

impl Service {
    pub(super) async fn handle_mode(
        &self,
        db: SharedDb,
        operation: &str,
        params: &Value,
        request_id: &str,
    ) -> Result<Value> {
        match operation {
            "decision/configureMode" => {
                let _guard = self
                    .control
                    .try_lock()
                    .context("Another integration change is in progress")?;
                let name = params["mode"]
                    .as_str()
                    .filter(|m| MODES.contains(m))
                    .context("Unknown assistance mode")?;
                let database = db.lock().unwrap();
                let mut cfg = config(&database)?;
                ensure!(
                    params["expectedRevision"] == cfg["revision"],
                    "Integration settings changed; reload before saving"
                );
                let mut saved = mode(&cfg, name);
                if let Some(chosen) = params.get("provider") {
                    let chosen = match chosen {
                        Value::Null => Value::Null,
                        other => {
                            let p = id(&json!({"p":other}), "p")?;
                            provider(&p)?;
                            usable_provider(&cfg, &p)?;
                            json!(p)
                        }
                    };
                    // Consent belongs to a provider: switching provider clears it.
                    if chosen != saved["provider"] {
                        saved["workspaces"] = json!([]);
                    }
                    saved["provider"] = chosen;
                }
                if let Some(allowed) = params["workspaceEnabled"].as_bool() {
                    ensure!(
                        !saved["provider"].is_null(),
                        "Choose a provider for this mode first"
                    );
                    let session = id(params, "sessionId")?;
                    let (scope, _) = workspace(&database, &session)?;
                    let mut scopes = saved["workspaces"].as_array().cloned().unwrap_or_default();
                    scopes.retain(|s| s != &scope);
                    if allowed {
                        ensure!(
                            scopes.len() < 32,
                            "Workspace limit reached; turn off an unused workspace first"
                        );
                        scopes.push(json!(scope));
                    }
                    saved["workspaces"] = json!(scopes);
                }
                if name == "triage"
                    && let Some(share) = params.get("share")
                {
                    let share: Vec<String> = share
                        .as_array()
                        .context("Choose what to share")?
                        .iter()
                        .filter_map(|v| v.as_str().map(str::to_owned))
                        .collect();
                    ensure!(
                        !share.is_empty() && share.iter().all(|s| SHARES.contains(&s.as_str())),
                        "Choose what to share"
                    );
                    saved["share"] = json!(share);
                }
                if let Some(limit) = params.get("dailyLimit") {
                    let limit = limit
                        .as_u64()
                        .filter(|n| (1..=1000).contains(n))
                        .context("Daily limit must be 1 to 1000")?;
                    saved["dailyLimit"] = json!(limit);
                }
                if !cfg["modes"].is_object() {
                    cfg["modes"] = json!({});
                }
                cfg["modes"][name] = saved;
                cfg["revision"] = json!(cfg["revision"].as_u64().unwrap() + 1);
                database.put("presentation", super::CONFIG, &cfg)?;
                Ok(json!({"revision":cfg["revision"]}))
            }
            "decision/feedback" => {
                let target = id(params, "requestId")?;
                let verdict = params["verdict"]
                    .as_str()
                    .filter(|v| ["agree", "disagree"].contains(v))
                    .context("Use agree or disagree")?;
                let database = db.lock().unwrap();
                let mut row = read_run(&database, &target)?.context("Unknown decision request")?;
                ensure!(
                    ["completed", "stale"].contains(&row["status"].as_str().unwrap_or("")),
                    "Only an answered request can be marked"
                );
                row["userVerdict"] = json!(verdict);
                row["verdictAtMillis"] = json!(now_ms());
                save_run(&database, row.clone())?;
                Ok(row)
            }
            "decision/metrics" => metrics(&db.lock().unwrap()),
            "decision/tool" => self.tool(db, params, request_id).await,
            "decision/toolAvailable" => Self::tool_available(&db, params),
            _ => bail!("Unsupported decision operation"),
        }
    }

    /// Whether Muse should be offered the tool at all for this session. No provider request.
    /// The relay helper lists the tool only when this is true, so a session never sees a
    /// tool that would refuse every call.
    fn tool_available(db: &SharedDb, params: &Value) -> Result<Value> {
        let session = id(params, "sessionId")?;
        let database = db.lock().unwrap();
        let cfg = config(&database)?;
        let Ok((scope, _)) = workspace(&database, &session) else {
            return Ok(json!({"available":false}));
        };
        let saved = mode(&cfg, "tool");
        let available = saved["provider"]
            .as_str()
            .is_some_and(|p| usable_provider(&cfg, p).is_ok())
            && saved["workspaces"]
                .as_array()
                .is_some_and(|w| w.iter().any(|v| v == &scope));
        Ok(json!({"available":available}))
    }

    /// Model (c): Muse asks one question about text it chose, for a session whose workspace the
    /// user enabled for the tool.
    async fn tool(&self, db: SharedDb, params: &Value, request_id: &str) -> Result<Value> {
        let session = id(params, "sessionId")?;
        let (cfg, scope) = {
            let database = db.lock().unwrap();
            (config(&database)?, workspace(&database, &session)?.0)
        };
        let saved = mode(&cfg, "tool");
        let provider_id = saved["provider"].as_str().context("Decision assistance is not enabled for this session. Continue without it; do not retry.")?.to_owned();
        ensure!(
            saved["workspaces"]
                .as_array()
                .is_some_and(|w| w.iter().any(|v| v == &scope)),
            "Decision assistance is not enabled for this session. Continue without it; do not retry."
        );
        usable_provider(&cfg, &provider_id).context(
            "Decision assistance is not available now. Continue without it; do not retry.",
        )?;
        let q = tool_question(params)?;
        let input = params["context"].as_str().unwrap_or("").to_owned();
        ensure!(
            input.chars().count() <= TOOL_CONTEXT_LIMIT,
            "Context is limited to 16,000 characters"
        );
        let model = cfg["providers"][&provider_id]["model"]
            .as_str()
            .unwrap_or(provider(&provider_id)?.2)
            .to_owned();
        let source = json!({"kind":"museTool","sessionId":session});
        let fingerprint = hash(json!({"provider":provider_id,"model":model,"input":input,"question":q,"rubric":TOOL_RUBRIC,"source":source,"configRevision":cfg["revision"],"admissionEpoch":self.epoch}).to_string().as_bytes());
        let identity: String = format!(
            "tool-{}",
            hash(format!("{session}:{request_id}").as_bytes())
        )
        .chars()
        .take(64)
        .collect();
        let row = match self.prior(&db, &identity, &fingerprint)? {
            Some(prior) => prior,
            None => {
                let limit = saved["dailyLimit"].as_i64().unwrap_or(50);
                ensure!(
                    spent_today(&db.lock().unwrap(), "museTool")? < limit,
                    "Today's limit for Muse's decision questions is reached. Continue without it."
                );
                self.spend(
                    db,
                    Spend {
                        request_id: &identity,
                        purpose: "museTool",
                        rubric: TOOL_RUBRIC,
                        provider_id: &provider_id,
                        model: &model,
                        input: &input,
                        q: &q,
                        source,
                        scope,
                        root: None,
                        revision: cfg["revision"].clone(),
                        fingerprint,
                    },
                )
                .await?
            }
        };
        ensure!(
            row["status"] == "completed",
            "{}",
            if row["status"] == "stale" {
                "The decision answer is no longer current. Continue without it; do not retry."
            } else {
                row["message"].as_str().unwrap_or(
                    "The decision assistant did not answer. Continue without it; do not retry.",
                )
            }
        );
        Ok(json!({
            "advisory": "An estimate from the user's external decision model. It does not approve anything and may be wrong; check the work yourself.",
            "provider": provider(&provider_id)?.0,
            "model": row["result"]["model"],
            "answer": row["result"]["answer"],
        }))
    }

    /// Model (b): one bounded pass over the workspaces the user chose for triage. Each finished
    /// task, and each new wait for the user, is evaluated at most once.
    pub(super) async fn triage_pass(&self, db: SharedDb) -> Result<usize> {
        let (cfg, candidates) = {
            let database = db.lock().unwrap();
            let cfg = config(&database)?;
            let saved = mode(&cfg, "triage");
            let Some(provider_id) = saved["provider"].as_str() else {
                return Ok(0);
            };
            if usable_provider(&cfg, provider_id).is_err() {
                return Ok(0);
            }
            let scopes = saved["workspaces"].as_array().cloned().unwrap_or_default();
            if scopes.is_empty() {
                return Ok(0);
            }
            let room = (saved["dailyLimit"].as_i64().unwrap_or(50)
                - spent_today(&database, "triage")?)
            .max(0) as usize;
            let mut found = Vec::new();
            for row in database.all("sessions")? {
                if found.len() >= room.min(TRIAGE_PER_PASS) {
                    break;
                }
                if row["lifecycle"] == "archived" {
                    continue;
                }
                let Some(path) = row["workspace"].as_str() else {
                    continue;
                };
                if !scopes.iter().any(|s| s == &hash(path.as_bytes())) {
                    continue;
                }
                let Some(turn) = row["state"]["turns"]
                    .as_array()
                    .and_then(|t| t.last())
                    .cloned()
                else {
                    continue;
                };
                let waiting = row["state"]["userInputs"]
                    .as_array()
                    .is_some_and(|a| !a.is_empty())
                    || row["state"]["approvals"]
                        .as_array()
                        .is_some_and(|a| !a.is_empty());
                if turn["terminal"].is_null() && !waiting {
                    continue;
                }
                let session = row["id"].as_str().unwrap_or_default().to_owned();
                let turn_id = turn["turnId"].as_str().unwrap_or_default().to_owned();
                let identity: String = format!(
                    "triage-{}",
                    hash(format!("{session}:{turn_id}:{waiting}").as_bytes())
                )
                .chars()
                .take(64)
                .collect();
                if read_run(&database, &identity)?.is_some() {
                    continue;
                }
                let share: Vec<String> = saved["share"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|v| v.as_str().map(str::to_owned))
                    .collect();
                let input = triage_input(&row, &turn_id, &share)?;
                let input_fingerprint = hash(input.as_bytes());
                found.push((
                    identity,
                    provider_id.to_owned(),
                    hash(path.as_bytes()),
                    input,
                    json!({"kind":"triage","sessionId":session,"turnId":turn_id,"waiting":waiting,"inputFingerprint":input_fingerprint}),
                ));
            }
            (cfg, found)
        };
        let q = triage_question();
        let mut started = 0;
        for (identity, provider_id, scope, input, source) in candidates {
            let model = cfg["providers"][&provider_id]["model"]
                .as_str()
                .unwrap_or(provider(&provider_id)?.2)
                .to_owned();
            let fingerprint = hash(json!({"provider":provider_id,"model":model,"input":input,"question":q,"rubric":TRIAGE_RUBRIC,"source":source,"configRevision":cfg["revision"],"admissionEpoch":self.epoch}).to_string().as_bytes());
            // Errors (busy admission, key unavailable) leave no identity and are tried on a
            // later pass; once an identity is recorded it is never sent again.
            if self
                .spend(
                    db.clone(),
                    Spend {
                        request_id: &identity,
                        purpose: "triage",
                        rubric: TRIAGE_RUBRIC,
                        provider_id: &provider_id,
                        model: &model,
                        input: &input,
                        q: &q,
                        source,
                        scope,
                        root: None,
                        revision: cfg["revision"].clone(),
                        fingerprint,
                    },
                )
                .await
                .is_ok()
            {
                started += 1;
            }
        }
        Ok(started)
    }
}

/// Aggregates over the retained request history (bounded at 5,000 identities): counts by
/// provider, mode and outcome, reported tokens, latency percentiles and overrides. Costs stay
/// unknown because these APIs do not report a billed amount.
pub(super) fn metrics(db: &Db) -> Result<Value> {
    let mut query = db.0.prepare(
        "SELECT json_extract(value,'$.provider'), coalesce(json_extract(value,'$.purpose'),'manual'), json_extract(value,'$.status'),
                json_extract(value,'$.latencyMs'), json_extract(value,'$.result.usage.input_tokens'),
                json_extract(value,'$.result.usage.output_tokens'), json_extract(value,'$.userVerdict'),
                json_extract(value,'$.createdAtMillis')
           FROM decisions",
    )?;
    let mut providers = serde_json::Map::new();
    let mut latencies: std::collections::HashMap<String, Vec<i64>> = Default::default();
    let since = now_ms().saturating_sub(86_400_000) as i64;
    let rows = query.query_map([], |r| {
        Ok((
            r.get::<_, Option<String>>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, Option<String>>(2)?,
            r.get::<_, Option<i64>>(3)?,
            r.get::<_, Option<i64>>(4)?,
            r.get::<_, Option<i64>>(5)?,
            r.get::<_, Option<String>>(6)?,
            r.get::<_, Option<i64>>(7)?,
        ))
    })?;
    for row in rows {
        let (p, purpose, status, latency, input, output, verdict, created) = row?;
        let p = p.unwrap_or_else(|| "unknown".into());
        let e = providers.entry(p.clone()).or_insert_with(|| json!({"requests":0,"last24h":0,"inputTokens":0,"outputTokens":0,"tokensReported":0,"agreed":0,"disagreed":0,"byPurpose":{},"byStatus":{}}));
        let add = |e: &mut Value, path: &[&str], n: i64| {
            let mut target = &mut *e;
            for key in path {
                target = &mut target[*key];
            }
            *target = json!(target.as_i64().unwrap_or(0) + n);
        };
        add(e, &["requests"], 1);
        if created.unwrap_or(0) >= since {
            add(e, &["last24h"], 1);
        }
        add(e, &["byPurpose", &purpose], 1);
        add(e, &["byStatus", status.as_deref().unwrap_or("unknown")], 1);
        if let Some(input) = input {
            add(e, &["inputTokens"], input);
            add(e, &["tokensReported"], 1);
        }
        if let Some(output) = output {
            add(e, &["outputTokens"], output);
        }
        match verdict.as_deref() {
            Some("agree") => add(e, &["agreed"], 1),
            Some("disagree") => add(e, &["disagreed"], 1),
            _ => {}
        }
        if let Some(latency) = latency {
            latencies.entry(p).or_default().push(latency);
        }
    }
    for (p, mut values) in latencies {
        values.sort_unstable();
        let at =
            |q: f64| values[((values.len() as f64 * q).ceil() as usize).clamp(1, values.len()) - 1];
        providers[&p]["latencyP50Ms"] = json!(at(0.5));
        providers[&p]["latencyP95Ms"] = json!(at(0.95));
    }
    Ok(json!({"providers":providers,"cost":"unknown: these APIs do not report a billed amount"}))
}

/// The background triage loop, started by the supervisor. Does nothing until the user turns
/// triage on for a provider and at least one workspace.
pub async fn triage_loop(db: SharedDb) {
    let mut timer = tokio::time::interval(std::time::Duration::from_secs(15));
    timer.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        timer.tick().await;
        let Ok(service) = super::service() else {
            continue;
        };
        if let Err(error) = service.triage_pass(db.clone()).await {
            eprintln!("Decision triage: {error}");
        }
    }
}
