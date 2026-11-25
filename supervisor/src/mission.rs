//! Project-owned plans. Muse task and Git facts come from their existing authorities.
mod rehearsal;

use crate::{coordination, db::Db, worker::SharedDb, workspace};
use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, BTreeSet},
    path::Path,
};
use tokio::sync::Semaphore;

const MAX_TASKS: usize = 12;
const MAX_DEPENDENCIES: usize = 6;
static SNAPSHOTS: Semaphore = Semaphore::const_new(2);

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct Plan {
    revision: u64,
    goal: String,
    tasks: Vec<Task>,
    #[serde(default)]
    rehearsal: Option<rehearsal::Rehearsal>,
    #[serde(default)]
    superseded_integrations: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TaskSpec {
    id: String,
    title: String,
    brief: String,
    criteria: String,
    depends_on: Vec<String>,
    session_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
struct Task {
    spec: TaskSpec,
    launch: Option<Launch>,
    evidence: Option<Evidence>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct Launch {
    request_id: String,
    text: String,
    upstream: BTreeMap<String, String>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct Evidence {
    turn_id: String,
    revision: String,
    note: String,
    handoff_id: Option<String>,
    acceptance_id: String,
}

fn uuid(value: &Value) -> Result<&str> {
    let id = value.as_str().context("Project identity required")?;
    ensure!(
        uuid::Uuid::parse_str(id).is_ok_and(|value| value.to_string() == id),
        "Invalid project identity"
    );
    Ok(id)
}

fn required(value: &Value, max: usize, label: &str) -> Result<String> {
    crate::projects::note_text(Some(value), max, label)?
        .with_context(|| format!("{label} is required"))
}

fn load(db: &Db, project: &str) -> Result<(Plan, Value)> {
    let saved = db
        .get("presentation", &format!("project:{project}"))?
        .context("Save the project before opening a mission")?;
    let plan = db
        .get("presentation", &format!("mission:{project}"))?
        .map(serde_json::from_value)
        .transpose()?
        .unwrap_or_else(|| Plan {
            goal: saved["goal"].as_str().unwrap_or_default().into(),
            ..Plan::default()
        });
    Ok((plan, saved))
}

fn store(db: &Db, project: &str, plan: &mut Plan) -> Result<()> {
    plan.revision = plan
        .revision
        .checked_add(1)
        .context("Mission revision limit reached")?;
    db.put(
        "presentation",
        &format!("mission:{project}"),
        &serde_json::to_value(plan)?,
    )
}

fn verify_revision(plan: &Plan, params: &Value) -> Result<()> {
    ensure!(
        params["revision"].as_u64() == Some(plan.revision),
        "The mission changed. Refresh it and review the latest state."
    );
    Ok(())
}

fn project_session(db: &Db, project: &str, session: &str) -> Result<Value> {
    db.get("sessions", session)?
        .filter(|row| {
            row["projectContext"]["id"] == project
                && row["lifecycle"] != "archived"
                && row["workspaceDiscarded"] != true
        })
        .context("Choose an open session in this project")
}

fn validate_graph(specs: &[TaskSpec]) -> Result<()> {
    ensure!(
        specs.len() <= MAX_TASKS,
        "A mission can have up to {MAX_TASKS} tasks"
    );
    let mut index = BTreeMap::new();
    for spec in specs {
        uuid(&json!(spec.id))?;
        ensure!(
            index.insert(spec.id.as_str(), spec).is_none(),
            "Task identities must be unique"
        );
        ensure!(
            spec.depends_on.len() <= MAX_DEPENDENCIES,
            "A task can have up to six dependencies"
        );
        let unique: BTreeSet<_> = spec.depends_on.iter().collect();
        ensure!(
            unique.len() == spec.depends_on.len(),
            "A dependency was selected twice"
        );
    }
    // A bounded topological pass also rejects references to removed tasks.
    let mut ready = BTreeSet::new();
    for _ in 0..specs.len() {
        let newly_ready: Vec<_> = specs
            .iter()
            .filter(|s| {
                !ready.contains(s.id.as_str())
                    && s.depends_on.iter().all(|id| ready.contains(id.as_str()))
            })
            .collect();
        if newly_ready.is_empty() {
            break;
        }
        ready.extend(newly_ready.into_iter().map(|s| s.id.as_str()));
    }
    ensure!(
        ready.len() == index.len(),
        "Dependencies contain a cycle or a missing task"
    );
    Ok(())
}

fn task(plan: &Plan, params: &Value) -> Result<usize> {
    let id = params["taskId"].as_str().context("Choose a mission task")?;
    plan.tasks
        .iter()
        .position(|task| task.spec.id == id)
        .context("Mission task is no longer present")
}

fn save(db: &Db, project: &str, params: &Value) -> Result<Value> {
    let (mut plan, _) = load(db, project)?;
    verify_revision(&plan, params)?;
    let mut specs: Vec<TaskSpec> = serde_json::from_value(params["tasks"].clone())?;
    ensure!(
        specs.len() <= MAX_TASKS,
        "A mission can have up to {MAX_TASKS} tasks"
    );
    for spec in &mut specs {
        spec.title = required(&json!(spec.title), 96, "Task title")?;
        spec.brief = required(&json!(spec.brief), 2400, "Task brief")?;
        spec.criteria = required(&json!(spec.criteria), 1200, "Acceptance criteria")?;
        if let Some(session) = &spec.session_id
            && !plan.tasks.iter().any(|task| {
                task.spec.id == spec.id && task.spec.session_id.as_ref() == Some(session)
            })
        {
            project_session(db, project, session)?;
        }
    }
    validate_graph(&specs)?;
    ensure!(
        !specs.iter().any(|spec| spec
            .session_id
            .as_ref()
            .is_some_and(|id| plan.superseded_integrations.contains(id))),
        "A superseded integration worktree cannot run mission tasks"
    );
    for started in plan.tasks.iter().filter(|task| task.launch.is_some()) {
        ensure!(
            specs.iter().any(|s| s == &started.spec),
            "Reopen started tasks before changing or removing them"
        );
    }
    if let Some(rehearsal) = &plan.rehearsal {
        ensure!(
            !specs
                .iter()
                .any(|spec| spec.session_id.as_deref() == Some(&rehearsal.session_id)),
            "The integration session is reserved for rehearsal"
        );
        ensure!(
            !specs.iter().any(|spec| rehearsal
                .review
                .as_ref()
                .is_some_and(|r| spec.session_id.as_deref() == Some(&r.session_id))),
            "The independent review session is reserved for review"
        );
    }
    let goal = required(&params["goal"], 2400, "Mission goal")?;
    if plan.goal != goal {
        ensure!(
            plan.tasks.iter().all(|task| task.launch.is_none()),
            "Reopen started tasks before changing the mission goal"
        );
        if let Some(integration) = &mut plan.rehearsal {
            integration.review = None;
        }
    }
    plan.goal = goal;
    plan.tasks = specs
        .into_iter()
        .map(|spec| {
            plan.tasks
                .iter()
                .find(|task| task.spec == spec)
                .cloned()
                .unwrap_or(Task {
                    spec,
                    launch: None,
                    evidence: None,
                })
        })
        .collect();
    store(db, project, &mut plan)?;
    Ok(json!({ "revision": plan.revision }))
}

fn turn(db: &Db, row: &Value, launch: &Launch) -> Result<(Option<Value>, Option<Value>)> {
    let command = db.get("commands", &launch.request_id)?;
    let matched = command.as_ref().and_then(|cmd| {
        let turn_id = cmd["result"]["turnId"].as_str();
        let native_id = cmd["commandId"].as_str();
        row["state"]["turns"]
            .as_array()?
            .iter()
            .find(|entry| {
                turn_id.is_some_and(|id| entry["turnId"] == id)
                    || native_id.is_some_and(|id| entry["commandId"] == id)
            })
            .cloned()
    });
    Ok((command, matched))
}

fn load_rows(db: &Db, project: &str, plan: &Plan) -> Result<BTreeMap<String, Value>> {
    let mut rows = BTreeMap::new();
    for id in plan
        .tasks
        .iter()
        .filter_map(|t| t.spec.session_id.as_deref())
    {
        if let Some(row) = db.get("sessions", id)?.filter(|r| {
            r["projectContext"]["id"] == project
                && r["lifecycle"] != "archived"
                && r["workspaceDiscarded"] != true
        }) {
            rows.insert(id.to_owned(), row);
        }
    }
    Ok(rows)
}

async fn proof_current(db: &SharedDb, task: &Task, row: &Value) -> Result<bool> {
    let Some(proof) = &task.evidence else {
        return Ok(false);
    };
    // Acceptance established completion even if that event ages out of the
    // bounded snapshot. A subsequent active turn may still change the tree.
    if !row["state"]["activeTurnId"].is_null() {
        return Ok(false);
    }
    workspace::check_trusted_root(row)?;
    let root = Path::new(row["workspace"].as_str().context("Workspace unavailable")?);
    if workspace::content_fingerprint(root).await? != proof.revision {
        return Ok(false);
    }
    if let Some(id) = &proof.handoff_id {
        return Ok(
            coordination::handoff(db, "handoff/check", &json!({"handoffId":id}), "").await?["current"]
                == true,
        );
    }
    Ok(true)
}

/// A proof becomes unavailable on any changed ancestor, even if this task's files still match.
async fn ready_proofs(
    db: &SharedDb,
    plan: &Plan,
    rows: &BTreeMap<String, Value>,
) -> BTreeMap<String, String> {
    let mut facts = BTreeMap::new();
    for task in &plan.tasks {
        if let (Some(proof), Some(row)) = (
            task.evidence.as_ref(),
            task.spec.session_id.as_ref().and_then(|id| rows.get(id)),
        ) && proof_current(db, task, row).await.unwrap_or(false)
        {
            facts.insert(task.spec.id.clone(), proof.acceptance_id.clone());
        }
    }
    for _ in 0..plan.tasks.len() {
        let invalid: Vec<_> = plan
            .tasks
            .iter()
            .filter(|task| {
                facts.contains_key(&task.spec.id)
                    && task.launch.as_ref().is_some_and(|launch| {
                        launch
                            .upstream
                            .iter()
                            .any(|(id, rev)| facts.get(id) != Some(rev))
                    })
            })
            .map(|task| task.spec.id.clone())
            .collect();
        if invalid.is_empty() {
            break;
        }
        for id in invalid {
            facts.remove(&id);
        }
    }
    facts
}

fn task_state(
    db: &Db,
    task: &Task,
    rows: &BTreeMap<String, Value>,
    facts: &BTreeMap<String, String>,
) -> Result<Value> {
    let (command, observed) = match (
        &task.launch,
        task.spec.session_id.as_ref().and_then(|id| rows.get(id)),
    ) {
        (Some(launch), Some(row)) => turn(db, row, launch)?,
        _ => (None, None),
    };
    let waiting: Vec<_> = task
        .spec
        .depends_on
        .iter()
        .filter(|id| !facts.contains_key(*id))
        .collect();
    let stale = task.launch.as_ref().is_some_and(|launch| {
        launch
            .upstream
            .iter()
            .any(|(id, rev)| facts.get(id) != Some(rev))
    }) || (task.evidence.is_some() && !facts.contains_key(&task.spec.id));
    let row = task.spec.session_id.as_ref().and_then(|id| rows.get(id));
    let terminal = observed
        .as_ref()
        .and_then(|value| value["terminal"].as_str());
    let command_status = command.as_ref().and_then(|value| value["status"].as_str());
    let decision = row
        .filter(|row| {
            observed
                .as_ref()
                .is_some_and(|t| t["turnId"] == row["state"]["activeTurnId"])
        })
        .and_then(|row| {
            let turn_id = &row["state"]["activeTurnId"];
            if let Some(approval) = row["state"]["approvals"].as_array().and_then(|items| {
                items
                    .iter()
                    .find(|item| &item["requested"]["turnId"] == turn_id)
            }) {
                return Some(
                    json!({"kind": "approval", "id": approval["requested"]["approvalId"]}),
                );
            }
            row["state"]["userInputs"]
                .as_array()
                .and_then(|items| items.iter().find(|item| &item["turnId"] == turn_id))
                .map(|item| json!({"kind": "question", "id": item["userInputId"]}))
        });
    let state = match (task.launch.is_some(), terminal, stale, command_status) {
        (_, _, _, _) if task.spec.session_id.is_some() && row.is_none() => "sessionUnavailable",
        (true, None, _, _) if decision.is_some() => "needsInput",
        (_, _, true, _) => "stale",
        (true, _, _, _) if facts.contains_key(&task.spec.id) => "accepted",
        (true, Some("completed"), _, _) => "readyToAccept",
        (true, Some(_), _, _) | (true, None, _, Some("rejected")) => "stopped",
        (true, None, _, Some("sending" | "accepted" | "applied")) => "running",
        (true, None, _, _) => "startUnconfirmed",
        (false, _, _, _) if !waiting.is_empty() => "waiting",
        (false, _, _, _) if task.spec.session_id.is_none() => "unassigned",
        (false, _, _, _)
            if row.is_some_and(|row| {
                row["lifecycle"] != "connected"
                    || row["state"]["current"] != true
                    || !row["state"]["activeTurnId"].is_null()
            }) =>
        {
            "sessionBusy"
        }
        _ => "ready",
    };
    let turn_id = observed
        .map(|v| v["turnId"].clone())
        .or_else(|| task.evidence.as_ref().map(|proof| json!(proof.turn_id)));
    Ok(json!({"state":state,"waitingFor":waiting,"turnId":turn_id,"decision":decision}))
}

async fn snapshot(db: &SharedDb, project: &str) -> Result<Value> {
    let _permit = SNAPSHOTS
        .try_acquire()
        .context("A mission refresh is already running")?;
    let (plan, project_row, rows) = {
        let guard = db.lock().unwrap();
        let (plan, saved) = load(&guard, project)?;
        let rows = load_rows(&guard, project, &plan)?;
        (plan, saved, rows)
    };
    let facts = ready_proofs(db, &plan, &rows).await;
    let observed = {
        let guard = db.lock().unwrap();
        plan.tasks
            .iter()
            .map(|t| task_state(&guard, t, &rows, &facts))
            .collect::<Result<Vec<_>>>()?
    };
    let rehearsal = rehearsal::project_view(db, &plan, project, &facts).await?;
    let mut visible = serde_json::to_value(plan)?;
    for task in visible["tasks"]
        .as_array_mut()
        .context("Mission tasks missing")?
    {
        if let Some(launch) = task["launch"].as_object_mut() {
            launch.remove("text");
            launch.remove("upstream");
        }
    }
    if let Some(launch) = visible
        .pointer_mut("/rehearsal/review/launch")
        .and_then(Value::as_object_mut)
    {
        launch.remove("text");
        launch.remove("upstream");
    }
    Ok(
        json!({"plan":visible,"tasks":observed,"projectName":project_row["name"],"projectRevision":project_row["revision"],"integration":rehearsal}),
    )
}

async fn evidence(
    db: &SharedDb,
    project: &str,
    params: &Value,
    id: &str,
    commit: bool,
) -> Result<Value> {
    let (plan, index, row, turn_id, rows) = {
        let guard = db.lock().unwrap();
        let (plan, _) = load(&guard, project)?;
        verify_revision(&plan, params)?;
        let index = task(&plan, params)?;
        let t = &plan.tasks[index];
        let row = project_session(
            &guard,
            project,
            t.spec.session_id.as_deref().context("Assign a session")?,
        )?;
        let (_, observed) = turn(
            &guard,
            &row,
            t.launch.as_ref().context("Start this task first")?,
        )?;
        let observed = observed
            .filter(|t| t["terminal"] == "completed")
            .context("Muse must finish this task first")?;
        let rows = load_rows(&guard, project, &plan)?;
        (
            plan,
            index,
            row,
            observed["turnId"]
                .as_str()
                .context("Missing completed turn")?
                .to_owned(),
            rows,
        )
    };
    workspace::check_trusted_root(&row)?;
    let root = Path::new(row["workspace"].as_str().context("Workspace unavailable")?);
    let fingerprint = workspace::content_fingerprint(root).await?;
    let note = required(&params["note"], 1600, "Evidence summary")?;
    let mut handoff_id = None;
    let mut handoff_body = None;
    if let Some(chosen) = params["handoffId"].as_str().filter(|v| !v.is_empty()) {
        let checked =
            coordination::handoff(db, "handoff/check", &json!({"handoffId":chosen}), "").await?;
        ensure!(
            checked["current"] == true
                && checked["handoff"]["source"]["turnId"] == turn_id
                && checked["handoff"]["source"]["sessionId"] == row["id"],
            "Choose a current handoff from this mission task"
        );
        handoff_id = Some(chosen.to_owned());
        handoff_body = checked["handoff"]["evidence"]["body"]
            .as_str()
            .map(str::to_owned);
    }
    let current = ready_proofs(db, &plan, &rows).await;
    ensure!(
        plan.tasks[index]
            .launch
            .as_ref()
            .unwrap()
            .upstream
            .iter()
            .all(|(key, value)| current.get(key) == Some(value)),
        "Upstream evidence changed. Reopen this task and run it with the current evidence."
    );
    let view = json!({"revision":fingerprint,"turnId":turn_id,"note":note,"handoffId":handoff_id,"handoffBody":handoff_body});
    if !commit {
        return Ok(view);
    }
    ensure!(params["sessionId"] == row["id"], "Task session changed");
    ensure!(
        params["preview"] == view,
        "Evidence changed. Review a new preview before accepting."
    );
    workspace::idle(db, &row)?;
    let guard = db.lock().unwrap();
    let (mut latest, _) = load(&guard, project)?;
    verify_revision(&latest, params)?;
    latest.tasks[index].evidence = Some(Evidence {
        turn_id,
        revision: fingerprint,
        note,
        handoff_id,
        acceptance_id: id.into(),
    });
    store(&guard, project, &mut latest)?;
    Ok(json!({"revision":latest.revision}))
}

fn reopen(db: &SharedDb, project: &str, params: &Value) -> Result<Value> {
    let (plan, _) = load(&db.lock().unwrap(), project)?;
    let index = task(&plan, params)?;
    let session = plan.tasks[index]
        .spec
        .session_id
        .as_deref()
        .context("Task has no session")?;
    let row = { project_session(&db.lock().unwrap(), project, session).ok() };
    if let Some(row) = &row {
        ensure!(params["sessionId"] == session, "Task session changed");
        workspace::idle(db, row)?;
    }
    let guard = db.lock().unwrap();
    let (mut plan, _) = load(&guard, project)?;
    verify_revision(&plan, params)?;
    plan.tasks[index].launch = None;
    plan.tasks[index].evidence = None;
    if row.is_none() {
        plan.tasks[index].spec.session_id = None;
    }
    store(&guard, project, &mut plan)?;
    Ok(json!({"revision":plan.revision}))
}

/// The resulting request is admitted by the normal session lane and durable turn journal.
pub(crate) async fn launch(db: &SharedDb, params: &Value, id: &str) -> Result<Value> {
    let project = uuid(&params["projectId"])?;
    let (plan, index, rows) = {
        let guard = db.lock().unwrap();
        let (plan, _) = load(&guard, project)?;
        let index = task(&plan, params)?;
        let rows = load_rows(&guard, project, &plan)?;
        (plan, index, rows)
    };
    let task = &plan.tasks[index];
    let session = task
        .spec
        .session_id
        .as_deref()
        .context("Assign a session first")?;
    ensure!(params["sessionId"] == session, "Task session changed");
    let row = rows.get(session).context("Choose an open session")?;
    if let Some(launch) = &task.launch {
        ensure!(
            launch.request_id == id,
            "This task was started. Reopen it before starting again."
        );
        ensure!(
            !launch.text.is_empty(),
            "Upstream evidence was removed. Reopen this task."
        );
        return Ok(json!({"sessionId":session,"text":launch.text}));
    }
    verify_revision(&plan, params)?;
    workspace::idle(db, row)?;
    let facts = ready_proofs(db, &plan, &rows).await;
    let mut upstream = BTreeMap::new();
    let mut text = format!(
        "{}\n\nMission goal: {}\n\n{}\n\nAcceptance criteria:\n{}",
        task.spec.title, plan.goal, task.spec.brief, task.spec.criteria
    );
    for key in &task.spec.depends_on {
        let id = facts
            .get(key)
            .context("Accept current evidence from each upstream task first")?;
        let source = plan
            .tasks
            .iter()
            .find(|item| item.spec.id == *key)
            .context("Dependency missing")?;
        let proof = source
            .evidence
            .as_ref()
            .context("Dependency evidence missing")?;
        upstream.insert(key.clone(), id.clone());
        text.push_str(&format!(
            "\n\nAccepted upstream evidence from {} ({}):\n{}",
            source.spec.title, proof.revision, proof.note
        ));
        if let Some(handoff) = &proof.handoff_id {
            let checked =
                coordination::handoff(db, "handoff/check", &json!({"handoffId":handoff}), "")
                    .await?;
            ensure!(
                checked["current"] == true,
                "Upstream handoff changed. Review it again."
            );
            text.push_str(&format!(
                "\n{}",
                checked["handoff"]["evidence"]["body"]
                    .as_str()
                    .unwrap_or_default()
            ));
        }
    }
    ensure!(
        text.len() <= 40_000,
        "The mission brief and evidence exceed 40,000 bytes"
    );
    let guard = db.lock().unwrap();
    ensure!(
        guard.get("commands", id)?.is_none(),
        "Request identity was already used"
    );
    let (mut latest, _) = load(&guard, project)?;
    verify_revision(&latest, params)?;
    latest.tasks[index].launch = Some(Launch {
        request_id: id.into(),
        text: text.clone(),
        upstream,
    });
    store(&guard, project, &mut latest)?;
    Ok(json!({"sessionId":session,"text":text}))
}

pub(crate) async fn handle(db: &SharedDb, op: &str, params: &Value, id: &str) -> Result<Value> {
    let project = uuid(&params["projectId"])?;
    ensure!(
        !id.is_empty()
            && id.len() <= 100
            && id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b)),
        "Invalid mission request identity"
    );
    match op {
        "mission/get" => snapshot(db, project).await,
        "mission/save" => save(&db.lock().unwrap(), project, params),
        "mission/evidencePreview" => evidence(db, project, params, id, false).await,
        "mission/accept" => evidence(db, project, params, id, true).await,
        "mission/reopen" => reopen(db, project, params),
        _ => rehearsal::handle(db, op, project, params, id).await,
    }
}
pub(crate) async fn review_preview(
    db: &SharedDb,
    params: &Value,
    effective: &Value,
) -> Result<Value> {
    rehearsal::review_preview(db, uuid(&params["projectId"])?, params, effective).await
}

pub(crate) async fn review_launch(
    db: &SharedDb,
    params: &Value,
    id: &str,
    effective: &Value,
) -> Result<Value> {
    rehearsal::review_launch(db, uuid(&params["projectId"])?, params, id, effective).await
}

fn integration(db: &SharedDb, row: &Value) -> Result<Option<Plan>> {
    let Some(project) = row["projectContext"]["id"].as_str() else {
        return Ok(None);
    };
    let Some(plan): Option<Plan> = db
        .lock()
        .unwrap()
        .get("presentation", &format!("mission:{project}"))?
        .map(serde_json::from_value)
        .transpose()?
    else {
        return Ok(None);
    };
    let reserved = plan
        .rehearsal
        .as_ref()
        .is_some_and(|state| row["id"] == state.session_id)
        || plan
            .superseded_integrations
            .iter()
            .any(|id| row["id"] == *id);
    Ok(reserved.then_some(plan))
}

pub(crate) fn integration_session(db: &SharedDb, row: &Value) -> Result<bool> {
    Ok(integration(db, row)?.is_some())
}

fn default_worktree(row: &Value) -> bool {
    row["managedWorkspace"]["path"].is_string()
        && row["managedWorkspace"]["path"] == row["managedWorkspaces"][0]["path"]
}

pub(crate) fn integration_worktree(db: &SharedDb, row: &Value) -> Result<bool> {
    Ok(default_worktree(row)
        && integration(db, row)?.is_some_and(|plan| {
            plan.rehearsal
                .as_ref()
                .is_some_and(|rehearsal| row["id"] == rehearsal.session_id)
        }))
}

pub(crate) fn check_archive(db: &SharedDb, row: &Value) -> Result<()> {
    if let Some(plan) = integration(db, row)?
        && let Some(rehearsal) = &plan.rehearsal
        && row["id"] == rehearsal.session_id
    {
        ensure!(
            !rehearsal.active(),
            "Finish or stop the mission rehearsal before archiving"
        );
    }
    Ok(())
}

pub(crate) async fn delivery_gate(db: &SharedDb, row: &Value) -> Result<()> {
    if default_worktree(row)
        && let Some(plan) = integration(db, row)?
    {
        let project = row["projectContext"]["id"].as_str().unwrap();
        let state = plan
            .rehearsal
            .as_ref()
            .filter(|rehearsal| row["id"] == rehearsal.session_id)
            .context("This rehearsal was replaced. Open the current integration to deliver.")?;
        rehearsal::check_delivery(db, &plan, project, state, row).await?;
    }
    Ok(())
}

/// Part of the existing archived-session cleanup transaction. Keep the user's plan
/// and task titles, clearing evidence and review prompts that copied session data.
pub(crate) fn forget_session(
    transaction: &rusqlite::Transaction<'_>,
    project: &str,
    session: &str,
) -> Result<()> {
    use rusqlite::OptionalExtension;
    let key = format!("mission:{project}");
    let raw: Option<String> = transaction
        .query_row(
            "SELECT value FROM presentation WHERE id=?1",
            [&key],
            |row| row.get(0),
        )
        .optional()?;
    let Some(raw) = raw else { return Ok(()) };
    let mut plan: Plan = serde_json::from_str(&raw)?;
    let mut removed = BTreeSet::new();
    for task in &mut plan.tasks {
        if task.spec.session_id.as_deref() == Some(session) {
            removed.insert(task.spec.id.clone());
            task.spec.session_id = None;
            task.launch = None;
            task.evidence = None;
        }
    }
    let mut changed = !removed.is_empty();
    for task in &mut plan.tasks {
        if let Some(launch) = &mut task.launch
            && launch.upstream.keys().any(|id| removed.contains(id))
        {
            // A delayed retry cannot resend data removed with the source session.
            launch.text.clear();
        }
    }
    if let Some(rehearsal) = &mut plan.rehearsal {
        if rehearsal.session_id == session {
            plan.rehearsal = None;
            changed = true;
        } else {
            changed |= rehearsal.forget_session(session, &removed);
        }
    }
    let prior_count = plan.superseded_integrations.len();
    plan.superseded_integrations.retain(|id| id != session);
    changed |= prior_count != plan.superseded_integrations.len();
    if changed {
        plan.revision = plan
            .revision
            .checked_add(1)
            .context("Mission revision limit reached")?;
        transaction.execute(
            "UPDATE presentation SET value=?2 WHERE id=?1",
            rusqlite::params![key, serde_json::to_string(&plan)?],
        )?;
    }
    Ok(())
}
