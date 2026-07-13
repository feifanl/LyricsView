// Translation via the user's own API key (off by default). One batched request
// per track; results are cached per track (see cache.rs) — never re-translated,
// never translated line-by-line during playback.
use reqwest::Client;
use serde_json::Value;

use crate::config::TranslationCfg;
use crate::http::{client, APP_UA};

/// Translate all `lines` in a single request. Returns `None` on any failure so
/// the caller can fall back to the untranslated lines.
pub async fn translate(cfg: &TranslationCfg, lines: &[String]) -> Option<Vec<String>> {
    if lines.is_empty() {
        return Some(Vec::new());
    }
    let http = client(APP_UA);
    match cfg.provider.as_str() {
        "deepl" => deepl(&http, cfg, lines).await,
        "google" => google(&http, cfg, lines).await,
        "openai" => openai(&http, cfg, lines).await,
        _ => None,
    }
}

async fn deepl(http: &Client, cfg: &TranslationCfg, lines: &[String]) -> Option<Vec<String>> {
    let base = if cfg.base_url.trim().is_empty() {
        "https://api-free.deepl.com"
    } else {
        cfg.base_url.trim_end_matches('/')
    };
    // Each line as a separate `text` param preserves the 1:1 mapping.
    let mut form: Vec<(&str, String)> = vec![
        ("target_lang", cfg.target_lang.to_uppercase()),
        ("tag_handling", "xml".into()),
    ];
    for l in lines {
        form.push(("text", l.clone()));
    }
    let v: Value = http
        .post(format!("{base}/v2/translate"))
        .header("Authorization", format!("DeepL-Auth-Key {}", cfg.api_key))
        .form(&form)
        .send()
        .await
        .ok()?
        .json()
        .await
        .ok()?;
    let arr = v.get("translations")?.as_array()?;
    let out: Vec<String> = arr
        .iter()
        .filter_map(|t| t.get("text").and_then(Value::as_str).map(str::to_string))
        .collect();
    (out.len() == lines.len()).then_some(out)
}

async fn google(http: &Client, cfg: &TranslationCfg, lines: &[String]) -> Option<Vec<String>> {
    let base = if cfg.base_url.trim().is_empty() {
        "https://translation.googleapis.com"
    } else {
        cfg.base_url.trim_end_matches('/')
    };
    let body = serde_json::json!({ "q": lines, "target": cfg.target_lang, "format": "text" });
    let v: Value = http
        .post(format!("{base}/language/translate/v2?key={}", cfg.api_key))
        .json(&body)
        .send()
        .await
        .ok()?
        .json()
        .await
        .ok()?;
    let arr = v.get("data")?.get("translations")?.as_array()?;
    let out: Vec<String> = arr
        .iter()
        .filter_map(|t| {
            t.get("translatedText")
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .collect();
    (out.len() == lines.len()).then_some(out)
}

async fn openai(http: &Client, cfg: &TranslationCfg, lines: &[String]) -> Option<Vec<String>> {
    let base = if cfg.base_url.trim().is_empty() {
        "https://api.openai.com/v1"
    } else {
        cfg.base_url.trim_end_matches('/')
    };
    let model = if cfg.model.trim().is_empty() {
        "gpt-4o-mini"
    } else {
        cfg.model.trim()
    };
    let sys = format!(
        "Translate each element of the given JSON array of lyric lines into {}. \
         Reply with ONLY a JSON array of the same length, same order, translations only.",
        cfg.target_lang
    );
    let user = serde_json::to_string(lines).ok()?;
    let body = serde_json::json!({
        "model": model,
        "temperature": 0,
        "messages": [
            { "role": "system", "content": sys },
            { "role": "user", "content": user },
        ],
    });
    let v: Value = http
        .post(format!("{base}/chat/completions"))
        .header("Authorization", format!("Bearer {}", cfg.api_key))
        .json(&body)
        .send()
        .await
        .ok()?
        .json()
        .await
        .ok()?;
    let content = v
        .get("choices")?
        .get(0)?
        .get("message")?
        .get("content")?
        .as_str()?;
    let parsed = parse_json_array(content)?;
    (parsed.len() == lines.len()).then_some(parsed)
}

/// Extract a JSON string array from a model reply (tolerates code fences / prose).
fn parse_json_array(content: &str) -> Option<Vec<String>> {
    let start = content.find('[')?;
    let end = content.rfind(']')?;
    if end <= start {
        return None;
    }
    let slice = &content[start..=end];
    let arr: Vec<Value> = serde_json::from_str(slice).ok()?;
    Some(
        arr.into_iter()
            .map(|v| match v {
                Value::String(s) => s,
                other => other.to_string(),
            })
            .collect(),
    )
}

#[cfg(test)]
mod tests {
    use super::parse_json_array;

    #[test]
    fn extracts_array_from_fenced_reply() {
        let reply = "```json\n[\"hola\", \"mundo\"]\n```";
        assert_eq!(parse_json_array(reply).unwrap(), vec!["hola", "mundo"]);
    }

    #[test]
    fn returns_none_without_array() {
        assert!(parse_json_array("no array here").is_none());
    }
}
