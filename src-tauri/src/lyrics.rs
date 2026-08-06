// Normalized lyrics model — single source of truth, mirrored in TS
// (src/shared/types.ts). Every provider parses into this shape; the renderer
// only ever sees this shape. All times are milliseconds.
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SourceId {
    Lrclib,
    Musixmatch,
    Netease,
    Applemusic,
    Manual,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LyricWord {
    pub start: u64,
    pub end: u64,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LyricLine {
    pub start: u64,
    pub end: u64,
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub words: Option<Vec<LyricWord>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub translation: Option<String>,
}

impl LyricLine {
    pub fn new(start: u64, end: u64, text: String) -> Self {
        Self {
            start,
            end,
            text,
            words: None,
            translation: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LyricsDoc {
    pub source: SourceId,
    pub track_key: String,
    pub lines: Vec<LyricLine>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plain: Option<String>,
    pub has_word_timing: bool,
}

impl LyricsDoc {
    /// A plain (unsynced) document: no timestamps, just fallback text.
    pub fn plain_only(source: SourceId, track_key: &str, plain: String) -> Self {
        Self {
            source,
            track_key: track_key.to_string(),
            lines: Vec::new(),
            plain: Some(plain),
            has_word_timing: false,
        }
    }

    /// Whether any line carries a bundled translation.
    pub fn has_translation(&self) -> bool {
        self.lines.iter().any(|l| l.translation.is_some())
    }

    /// Whether any bundled translation is in `target`, which must already be
    /// reduced by `base_lang`.
    ///
    /// "Has a translation" is not the same question as "has a translation the
    /// user can read". NetEase bundles Chinese translations with Korean and
    /// Japanese songs; for an English target the overlay discards every one of
    /// them, so counting them when ranking picked a document *for* a translation
    /// that was then thrown away — losing whatever the rejected document had to
    /// offer and still showing no translated line.
    pub fn has_translation_in(&self, target: &str) -> bool {
        self.lines
            .iter()
            .filter_map(|l| l.translation.as_deref())
            .any(|t| base_lang(&script_of(t)) == target)
    }
}

/// Dominant script of a string, as the coarse bucket the overlay uses:
/// `ja` | `zh` | `ko` | `ru` | `latin`. Mirrors `detectScript` +`langOf` in
/// src/overlay/romanize.ts and src/overlay/translation.ts — the two must agree,
/// or the backend ranks on a judgement the frontend then reverses.
fn script_of(text: &str) -> String {
    // Share of a line's letters a script must hold to be called the line's
    // script. Providers plant homoglyphs (a Cyrillic "е" inside an English
    // word) to dodge content matching, so "contains one" is not enough.
    const MIN_SHARE: f64 = 0.2;
    let (mut ja, mut ko, mut ru, mut zh, mut letters) = (0.0, 0.0, 0.0, 0.0, 0.0);
    for ch in text.chars() {
        if !ch.is_alphabetic() {
            continue;
        }
        letters += 1.0;
        match ch as u32 {
            0x3040..=0x30FF => ja += 1.0,          // hiragana + katakana
            0xAC00..=0xD7A3 | 0x1100..=0x11FF => ko += 1.0, // hangul
            0x0400..=0x04FF => ru += 1.0,          // cyrillic
            0x3400..=0x4DBF | 0x4E00..=0x9FFF => zh += 1.0, // CJK ideographs
            _ => {}
        }
    }
    if letters == 0.0 {
        return "latin".into();
    }
    // Kana beat kanji: Japanese prose is mostly kanji by count, so any
    // meaningful kana share makes the line Japanese rather than Chinese.
    if ja / letters >= MIN_SHARE || (ja > 0.0 && (ja + zh) / letters >= MIN_SHARE) {
        return "ja".into();
    }
    if ko / letters >= MIN_SHARE {
        return "ko".into();
    }
    if ru / letters >= MIN_SHARE {
        return "ru".into();
    }
    if zh / letters >= MIN_SHARE {
        return "zh".into();
    }
    "latin".into()
}

/// A language code reduced to the buckets `script_of` produces. Mirrors
/// `baseLang` in src/overlay/translation.ts.
pub fn base_lang(code: &str) -> String {
    let base = code
        .to_lowercase()
        .split(['-', '_'])
        .next()
        .unwrap_or_default()
        .to_string();
    match base.as_str() {
        "en" | "es" | "fr" | "de" | "it" | "pt" | "nl" | "id" | "ms" | "vi" | "tr" | "pl" => {
            "latin".into()
        }
        _ => base,
    }
}

/// Rank a document: timing dominates (word-level 4, synced 2, plain 0), and a
/// bundled translation adds 1 when it is in `want_lang` (already reduced by
/// `base_lang`; `None` when the user hides translations). So a usefully
/// translated line-level doc (3) beats a translation-less one (2) but never
/// beats word timing.
///
/// Both the live provider race and the cache pick with this. They used to score
/// separately, and the cache's copy had no translation term — so a fetch would
/// correctly choose a translated doc, then every later play of the same track
/// re-picked a translation-less one out of the cache. The bug only showed once
/// a track had docs from two providers, which is exactly what enabling a new
/// provider does to an existing cache.
pub fn doc_score(doc: &LyricsDoc, want_lang: Option<&str>) -> i32 {
    let timing = if doc.has_word_timing {
        4
    } else if !doc.lines.is_empty() {
        2
    } else {
        0
    };
    let useful = want_lang.is_some_and(|l| doc.has_translation_in(l));
    timing + i32::from(useful)
}

#[derive(Debug, thiserror::Error)]
pub enum ParseError {
    #[error("no timestamped lines found")]
    NoTimestamps,
    #[error("malformed payload: {0}")]
    Malformed(String),
}
