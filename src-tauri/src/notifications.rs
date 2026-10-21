//! Desktop notifications for work that needs the user (D4). The WebView gets no notification
//! plugin permissions: it can only ask this module to show one bounded message. A message is
//! shown at most once per attention key, never while a Lascoria window has focus, and at most
//! `BURST_LIMIT` times a minute, so a polling or rendering fault cannot flood the desktop.
use serde::Deserialize;
use std::{
    collections::{HashSet, VecDeque},
    sync::Mutex,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Manager};
use tauri_plugin_notification::NotificationExt;

/// Remembered keys. Older keys are forgotten first; the UI also remembers what it has seen.
const SEEN_LIMIT: usize = 500;
const KEYS_PER_NOTICE: usize = 20;
const KEY_BYTES: usize = 200;
const TITLE_CHARS: usize = 80;
const BODY_CHARS: usize = 240;
const BURST_LIMIT: usize = 12;
const BURST_WINDOW: Duration = Duration::from_secs(60);

#[derive(Default)]
pub struct Notifier(Mutex<State>);

#[derive(Default)]
struct State {
    seen: HashSet<String>,
    order: VecDeque<String>,
    recent: VecDeque<Instant>,
}

#[derive(Debug, PartialEq, Eq, Clone, Copy)]
enum Outcome {
    Shown,
    Focused,
    Duplicate,
    Limited,
}
impl Outcome {
    fn as_str(self) -> &'static str {
        match self {
            Self::Shown => "shown",
            Self::Focused => "focused",
            Self::Duplicate => "duplicate",
            Self::Limited => "limited",
        }
    }
}

#[derive(Deserialize)]
pub struct Notice {
    keys: Vec<String>,
    title: String,
    body: String,
}

/// Single-line, bounded display text. Control characters become spaces.
fn clean(text: &str, limit: usize) -> Result<String, String> {
    let text = text
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    if text.is_empty() {
        return Err("Notification text is required".into());
    }
    if text.chars().count() <= limit {
        return Ok(text);
    }
    let mut short: String = text.chars().take(limit - 1).collect();
    short.push('…');
    Ok(short)
}

impl State {
    fn admit(&mut self, keys: &[String], focused: bool, now: Instant) -> Result<Outcome, String> {
        if keys.is_empty()
            || keys.len() > KEYS_PER_NOTICE
            || keys
                .iter()
                .any(|k| k.is_empty() || k.len() > KEY_BYTES || k.chars().any(char::is_control))
        {
            return Err("Invalid notification keys".into());
        }
        if keys.iter().all(|key| self.seen.contains(key)) {
            return Ok(Outcome::Duplicate);
        }
        // Remember keys even when nothing is shown, so returning to the background later does
        // not announce something the user already saw in the window.
        for key in keys {
            if self.seen.insert(key.clone()) {
                self.order.push_back(key.clone());
            }
        }
        while self.order.len() > SEEN_LIMIT {
            if let Some(old) = self.order.pop_front() {
                self.seen.remove(&old);
            }
        }
        if focused {
            return Ok(Outcome::Focused);
        }
        while self
            .recent
            .front()
            .is_some_and(|at| now.duration_since(*at) >= BURST_WINDOW)
        {
            self.recent.pop_front();
        }
        if self.recent.len() >= BURST_LIMIT {
            return Ok(Outcome::Limited);
        }
        self.recent.push_back(now);
        Ok(Outcome::Shown)
    }
}

fn any_window_focused(app: &AppHandle) -> bool {
    app.webview_windows()
        .values()
        .any(|window| window.is_focused().unwrap_or(false))
}

fn show(app: &AppHandle, title: String, body: String) -> Result<(), String> {
    app.notification()
        .builder()
        .title(title)
        .body(body)
        .show()
        .map_err(|e| format!("Could not show a desktop notification: {e}"))
}

/// Returns what happened: `shown`, `focused`, `duplicate` or `limited`.
#[tauri::command]
pub async fn notify_attention(
    app: AppHandle,
    notifier: tauri::State<'_, Notifier>,
    notice: Notice,
) -> Result<&'static str, String> {
    let title = clean(&notice.title, TITLE_CHARS)?;
    let body = clean(&notice.body, BODY_CHARS)?;
    let focused = any_window_focused(&app);
    let outcome = notifier
        .0
        .lock()
        .unwrap()
        .admit(&notice.keys, focused, Instant::now())?;
    if outcome == Outcome::Shown {
        show(&app, title, body)?;
    }
    Ok(outcome.as_str())
}

/// Explicit check from Settings. The operating system decides whether it appears.
#[tauri::command]
pub async fn notify_test(app: AppHandle) -> Result<(), String> {
    show(
        &app,
        "Lascoria notifications are on".into(),
        "You will see messages like this when a session needs you while Lascoria is in the background."
            .into(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn keys(values: &[&str]) -> Vec<String> {
        values.iter().map(|v| v.to_string()).collect()
    }

    #[test]
    fn shows_each_key_once_and_never_while_focused() {
        let mut state = State::default();
        let now = Instant::now();
        assert_eq!(state.admit(&keys(&["a"]), false, now), Ok(Outcome::Shown));
        assert_eq!(
            state.admit(&keys(&["a"]), false, now),
            Ok(Outcome::Duplicate)
        );
        // Seen in the focused window: later background polling does not announce it.
        assert_eq!(state.admit(&keys(&["b"]), true, now), Ok(Outcome::Focused));
        assert_eq!(
            state.admit(&keys(&["b"]), false, now),
            Ok(Outcome::Duplicate)
        );
        // A summary with one new key is shown; its old keys stay remembered.
        assert_eq!(
            state.admit(&keys(&["a", "c"]), false, now),
            Ok(Outcome::Shown)
        );
    }

    #[test]
    fn bursts_are_limited_and_memory_is_bounded() {
        let mut state = State::default();
        let start = Instant::now();
        for n in 0..BURST_LIMIT {
            assert_eq!(
                state.admit(&[format!("k{n}")], false, start),
                Ok(Outcome::Shown)
            );
        }
        assert_eq!(
            state.admit(&keys(&["over"]), false, start),
            Ok(Outcome::Limited)
        );
        let later = start + BURST_WINDOW;
        assert_eq!(
            state.admit(&keys(&["after"]), false, later),
            Ok(Outcome::Shown)
        );
        for n in 0..SEEN_LIMIT * 2 {
            let _ = state.admit(&[format!("m{n}")], true, later);
        }
        assert_eq!(state.seen.len(), SEEN_LIMIT);
        assert_eq!(state.order.len(), SEEN_LIMIT);
    }

    #[test]
    fn rejects_malformed_keys_and_bounds_text() {
        let mut state = State::default();
        let now = Instant::now();
        assert!(state.admit(&[], false, now).is_err());
        assert!(state.admit(&keys(&[""]), false, now).is_err());
        assert!(
            state
                .admit(&["x".repeat(KEY_BYTES + 1)], false, now)
                .is_err()
        );
        assert!(state.admit(&keys(&["a\nb"]), false, now).is_err());
        let many: Vec<String> = (0..=KEYS_PER_NOTICE).map(|n| n.to_string()).collect();
        assert!(state.admit(&many, false, now).is_err());
        assert_eq!(
            clean("  Muse\nhas\ta question ", 80).unwrap(),
            "Muse has a question"
        );
        assert!(clean(" \n ", 80).is_err());
        let long = clean(&"é".repeat(300), BODY_CHARS).unwrap();
        assert_eq!(long.chars().count(), BODY_CHARS);
        assert!(long.ends_with('…'));
    }
}
