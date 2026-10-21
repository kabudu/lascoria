//! Provider-native wire contracts and strict result validation. No HTTP or credentials.
use anyhow::{Context, Result, bail, ensure};
use serde_json::{Value, json};
pub(super) fn provider(
    id: &str,
) -> Result<(&'static str, &'static str, &'static str, &'static str)> {
    match id {
        "jev" => Ok((
            "Jev / TypeSafe",
            "https://api.typesafe.ai/v1/systemone",
            "jev-latest",
            "https://help.typesafe.ai/articles/5974925716-how-is-submitted-data-used-or-retained",
        )),
        "subq" => Ok((
            "SubQ",
            "https://api.subq.ai/v1/systemone",
            "subq-snap-preview",
            "https://docs.subq.ai/using-the-api/data-retention/",
        )),
        "openai" => Ok((
            "OpenAI",
            "https://api.openai.com/v1/decisions",
            "gpt-6-luna",
            "https://developers.openai.com/api/docs/guides/your-data",
        )),
        _ => bail!("Unknown decision provider"),
    }
}
pub(super) fn question(params: &Value) -> Result<Value> {
    let q = &params["question"];
    let prompt = q["prompt"].as_str().context("Question required")?;
    ensure!(
        !prompt.trim().is_empty() && prompt.len() <= 2_000,
        "Question must be between 1 and 2000 bytes"
    );
    let kind = q["type"].as_str().context("Question type required")?;
    ensure!(
        ["predicate", "choice", "score"].contains(&kind),
        "Unsupported question type"
    );
    let mut result = json!({"type":kind,"prompt":prompt});
    if kind != "predicate" {
        let options = q["options"]
            .as_array()
            .context("Provide two to eight descriptions")?;
        ensure!(
            (2..=8).contains(&options.len()),
            "Provide two to eight descriptions"
        );
        let mut unique = std::collections::HashSet::new();
        for option in options {
            let text = option.as_str().context("Descriptions must be text")?;
            ensure!(
                !text.trim().is_empty() && text.len() <= 300 && unique.insert(text),
                "Descriptions must be short, nonempty and unique"
            );
        }
        result["options"] = json!(options);
    }
    Ok(result)
}
pub(super) fn body(provider: &str, model: &str, input: &str, q: &Value) -> Value {
    let kind = q["type"].as_str().unwrap();
    let options = q["options"].as_array().cloned().unwrap_or_default();
    if provider == "openai" {
        let mut question = json!({"name":"review","type":kind,"instructions":q["prompt"]});
        if kind == "choice" {
            question["choices"] = json!(
                options
                    .iter()
                    .enumerate()
                    .map(|(i, v)| json!({"value":format!("option_{i}"),"description":v}))
                    .collect::<Vec<_>>()
            );
        }
        if kind == "score" {
            question["levels"] = json!(
                options
                    .iter()
                    .enumerate()
                    .map(|(i, v)| json!({"label":format!("level_{i}"),"description":v}))
                    .collect::<Vec<_>>()
            );
        }
        json!({"model":model,"input":input,"questions":[question]})
    } else {
        let mut question =
            json!({"type":if kind == "predicate" {"noul"} else {kind},"instructions":q["prompt"]});
        question["criteria"] = match kind {
            "predicate" => {
                json!({"true":"The supplied evidence supports yes","false":"The supplied evidence supports no"})
            }
            "score" => json!(options),
            _ => Value::Object(
                options
                    .iter()
                    .enumerate()
                    .map(|(i, v)| (format!("option_{i}"), v.clone()))
                    .collect(),
            ),
        };
        json!({"model":model,"state":input,"questions":{"review":question}})
    }
}
fn probability(v: &Value) -> bool {
    v.as_f64()
        .is_some_and(|v| v.is_finite() && (0.0..=1.0).contains(&v))
}
pub(super) fn validated(provider: &str, value: &Value, q: &Value) -> Result<Value> {
    let model = value["model"]
        .as_str()
        .filter(|s| !s.is_empty() && s.len() <= 128)
        .context("Provider did not report a valid model")?;
    let answer = if provider == "openai" {
        let answers = value["answers"]
            .as_array()
            .context("Provider answer format changed")?;
        ensure!(
            answers.len() == 1 && answers[0]["name"] == "review",
            "Unexpected question identity"
        );
        &answers[0]
    } else {
        &value["answers"]["review"]
    };
    let kind = q["type"].as_str().unwrap();
    let expected = if kind == "predicate" && provider != "openai" {
        "noul"
    } else {
        kind
    };
    ensure!(
        answer["type"] == expected,
        "Provider refused the question or changed its answer type"
    );
    let mut native = json!({"type":expected});
    match kind {
        "predicate" => {
            let key = if provider == "openai" {
                "probability"
            } else {
                "noul"
            };
            ensure!(probability(&answer[key]), "Invalid probability");
            native[key] = answer[key].clone();
        }
        "choice" | "score" => {
            // Provider-specific distributions are retained below; invalid numbers are never advice.
            let mapped;
            let probabilities = if provider == "openai" {
                let values = answer["probabilities"]
                    .as_array()
                    .context("Probability distribution missing")?;
                let mut object = serde_json::Map::new();
                for entry in values {
                    let key = if kind == "choice" {
                        entry["value"]
                            .as_str()
                            .context("Invalid choice label")?
                            .to_owned()
                    } else {
                        let index = entry["value"].as_u64().context("Invalid score level")?;
                        ensure!(
                            entry["label"] == format!("level_{index}"),
                            "Score label changed"
                        );
                        index.to_string()
                    };
                    ensure!(
                        object.insert(key, entry["probability"].clone()).is_none(),
                        "Duplicate probability label"
                    );
                }
                mapped = object;
                &mapped
            } else {
                answer["probabilities"]
                    .as_object()
                    .context("Probability distribution missing")?
            };
            let count = q["options"].as_array().unwrap().len();
            ensure!(
                probabilities.len() == count && probabilities.values().all(probability),
                "Invalid probability distribution"
            );
            let sum: f64 = probabilities.values().filter_map(Value::as_f64).sum();
            ensure!((sum - 1.0).abs() <= 0.01, "Probabilities do not sum to one");
            for i in 0..count {
                let key = if kind == "choice" {
                    format!("option_{i}")
                } else {
                    i.to_string()
                };
                ensure!(
                    probabilities.contains_key(&key),
                    "Probability labels changed"
                );
            }
            ensure!(
                probability(&answer["confidence"]),
                "Confidence missing or invalid"
            );
            if kind == "choice" {
                ensure!(
                    answer["choice"]
                        .as_str()
                        .is_some_and(|s| probabilities.contains_key(s)),
                    "Unknown choice"
                );
            } else {
                ensure!(
                    answer["score"]
                        .as_f64()
                        .is_some_and(|v| v.is_finite() && v >= 0.0 && v <= (count - 1) as f64),
                    "Invalid score"
                );
            }
            if kind == "score" {
                let weighted: f64 = (0..count)
                    .map(|i| i as f64 * probabilities[&i.to_string()].as_f64().unwrap())
                    .sum();
                ensure!(
                    (weighted - answer["score"].as_f64().unwrap()).abs() <= 0.01,
                    "Score does not match its probabilities"
                );
            } else {
                let chosen = probabilities[answer["choice"].as_str().unwrap()]
                    .as_f64()
                    .unwrap();
                ensure!(
                    probabilities
                        .values()
                        .filter_map(Value::as_f64)
                        .all(|p| p <= chosen + 0.01),
                    "Choice does not match its probabilities"
                );
            }
            native[kind] = answer[kind].clone();
            native["probabilities"] = if provider == "openai" {
                json!(answer["probabilities"].as_array().unwrap().iter().map(|entry| {
                    if kind == "choice" {json!({"value":entry["value"],"probability":entry["probability"]})}
                    else {json!({"label":entry["label"],"value":entry["value"],"probability":entry["probability"]})}
                }).collect::<Vec<_>>())
            } else {
                json!(probabilities)
            };
            native["confidence"] = answer["confidence"].clone();
            if kind == "score" && provider != "openai" {
                let expected: serde_json::Map<String, Value> = q["options"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .enumerate()
                    .map(|(i, v)| (i.to_string(), v.clone()))
                    .collect();
                ensure!(answer["legend"] == json!(expected), "Score legend changed");
                native["legend"] = json!(expected);
            }
        }
        _ => unreachable!(),
    }
    let mut usage = json!({});
    for key in ["input_tokens", "output_tokens", "total_tokens"] {
        if !value["usage"][key].is_null() {
            ensure!(value["usage"][key].as_u64().is_some(), "Invalid usage");
            usage[key] = value["usage"][key].clone();
        }
    }
    for (group, fields) in [
        (
            "input_tokens_details",
            &["cached_tokens", "cache_write_tokens"][..],
        ),
        ("output_tokens_details", &["reasoning_tokens"][..]),
    ] {
        for field in fields {
            let reported = &value["usage"][group][field];
            if !reported.is_null() {
                ensure!(reported.as_u64().is_some(), "Invalid detailed usage");
                if usage[group].is_null() {
                    usage[group] = json!({});
                }
                usage[group][field] = reported.clone();
            }
        }
    }
    Ok(json!({"model":model,"answer":native,"usage":usage,"cost":null}))
}
