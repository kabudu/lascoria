//! Read-only search over locally retained transcript text, as the user saw it (`displayText`
//! when Muse recorded one). Muse keeps full native history;
//! Lascoria retains the most recent 100 items of each session, so results say which window
//! they cover. Never reads command payloads, credentials or files, and never contacts Muse.
use crate::db::Db;
use anyhow::{Context, Result, ensure};
use serde_json::{Value, json};

pub const MAX_RESULTS: usize = 50;
const SNIPPET_CHARS: usize = 120;

fn snippet(text: &str, needle: &str) -> String {
    let lower = text.to_lowercase();
    let at = lower.find(&needle.to_lowercase()).unwrap_or(0);
    // Work in characters so multi-byte text is never split.
    let before = lower[..at].chars().count();
    let chars: Vec<char> = text.chars().collect();
    let start = before.saturating_sub(SNIPPET_CHARS / 2);
    let end = (before + needle.chars().count() + SNIPPET_CHARS / 2).min(chars.len());
    // Case mapping can change character counts; never slice past either end.
    let start = start.min(end);
    let mut out: String = chars[start..end].iter().collect();
    out = out.split_whitespace().collect::<Vec<_>>().join(" ");
    if start > 0 {
        out.insert(0, '…');
    }
    if end < chars.len() {
        out.push('…');
    }
    out
}

pub fn run(db: &Db, params: &Value) -> Result<Value> {
    ensure!(params.is_object(), "Params must be an object");
    let query = params["query"]
        .as_str()
        .context("Search text required")?
        .trim();
    ensure!(
        !query.is_empty() && query.chars().count() <= 200 && !query.chars().any(char::is_control),
        "Search for 1 to 200 characters"
    );
    let session = params.get("sessionId").and_then(Value::as_str);
    let lowered = query.to_lowercase();
    // Lowercasing in Rust handles non-ASCII text; SQLite narrows candidates by exact substring
    // or ASCII case only when that is safe, then Rust confirms each match.
    let mut statement = db.0.prepare(
        "SELECT s.id, json_extract(s.value,'$.lifecycle'), json_extract(i.value,'$.itemId'),
                json_extract(i.value,'$.kind'), json_extract(i.value,'$.turnId'),
                coalesce(json_extract(i.value,'$.displayText'), json_extract(i.value,'$.text')), json_extract(i.value,'$.recordedAt')
           FROM sessions s, json_each(s.value,'$.state.items') i
          WHERE (?2 IS NULL OR s.id = ?2)
            AND json_type(i.value,'$.text') = 'text'
            AND (?3 = 0 OR instr(lower(coalesce(json_extract(i.value,'$.displayText'), json_extract(i.value,'$.text'))), ?1) > 0)
          ORDER BY s.rowid DESC, i.key DESC",
    )?;
    let ascii = lowered.is_ascii();
    let mut results = Vec::new();
    let mut truncated = false;
    let rows = statement.query_map(rusqlite::params![lowered, session, ascii as i64], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, Option<String>>(1)?,
            row.get::<_, Option<String>>(2)?,
            row.get::<_, Option<String>>(3)?,
            row.get::<_, Option<String>>(4)?,
            row.get::<_, String>(5)?,
            row.get::<_, Option<String>>(6)?,
        ))
    })?;
    for row in rows {
        let (session_id, lifecycle, item_id, kind, turn_id, text, recorded_at) = row?;
        if !text.to_lowercase().contains(&lowered) {
            continue;
        }
        if results.len() == MAX_RESULTS {
            truncated = true;
            break;
        }
        results.push(json!({
            "sessionId": session_id,
            "archived": lifecycle.as_deref() == Some("archived"),
            "itemId": item_id,
            "kind": kind,
            "turnId": turn_id,
            "recordedAt": recorded_at,
            "snippet": snippet(&text, query),
        }));
    }
    Ok(json!({"query":query,"results":results,"truncated":truncated,"scope":"retained"}))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn finds_retained_text_case_insensitively_across_live_and_archived_sessions() -> Result<()> {
        let db = Db::open(Path::new(":memory:"))?;
        db.put(
            "sessions",
            "a",
            &json!({"id":"a","lifecycle":"archived","state":{"items":[
                {"itemId":"1","kind":"userMessage","text":"Fix the Flaky retry loop"},
                {"itemId":"2","kind":"toolCall","name":"bash"},
                {"itemId":"5","kind":"userMessage","displayText":"Add the docs folder","text":"Lascoria note: hidden context. Add the docs folder"}
            ]}}),
        )?;
        db.put(
            "sessions",
            "b",
            &json!({"id":"b","lifecycle":"connected","state":{"items":[
                {"itemId":"3","kind":"agentMessage","text":"The retry LOOP now backs off"},
                {"itemId":"4","kind":"agentMessage","text":"Ünïcode Straße works"}
            ]}}),
        )?;
        let found = run(&db, &json!({"query":"retry loop"}))?;
        assert_eq!(found["results"].as_array().unwrap().len(), 2);
        assert_eq!(found["results"][0]["sessionId"], "b");
        assert_eq!(found["results"][1]["archived"], true);
        let scoped = run(&db, &json!({"query":"retry","sessionId":"a"}))?;
        assert_eq!(scoped["results"].as_array().unwrap().len(), 1);
        // Non-ASCII case folding happens in Rust, not SQLite.
        let unicode = run(&db, &json!({"query":"STRASSE"}))?;
        assert_eq!(unicode["results"].as_array().unwrap().len(), 0);
        let unicode = run(&db, &json!({"query":"ÜNÏCODE"}))?;
        assert_eq!(unicode["results"][0]["itemId"], "4");
        // What the user typed is searched and shown; a model-only note is not.
        assert_eq!(
            run(&db, &json!({"query":"docs folder"}))?["results"][0]["itemId"],
            "5"
        );
        assert_eq!(
            run(&db, &json!({"query":"Lascoria note"}))?["results"]
                .as_array()
                .unwrap()
                .len(),
            0
        );
        assert!(run(&db, &json!({"query":"  "})).is_err());
        assert!(run(&db, &json!({"query":"x".repeat(201)})).is_err());
        Ok(())
    }

    #[test]
    fn results_and_snippets_are_bounded() -> Result<()> {
        let db = Db::open(Path::new(":memory:"))?;
        let long = format!("{}needle{}", "é".repeat(500), "z".repeat(500));
        let items: Vec<_> = (0..120)
            .map(|i| json!({"itemId":i.to_string(),"kind":"agentMessage","text":long}))
            .collect();
        db.put("sessions", "s", &json!({"id":"s","state":{"items":items}}))?;
        let found = run(&db, &json!({"query":"NEEDLE"}))?;
        assert_eq!(found["results"].as_array().unwrap().len(), MAX_RESULTS);
        assert_eq!(found["truncated"], true);
        let snippet = found["results"][0]["snippet"].as_str().unwrap();
        assert!(snippet.contains("needle") && snippet.starts_with('…') && snippet.ends_with('…'));
        assert!(snippet.chars().count() <= SNIPPET_CHARS + 10);
        Ok(())
    }
}
