// Musixmatch "richsync" parser (word-level). The richsync body is a JSON array
// of lines: `{ ts, te, l: [{ c, o }], x }` where ts/te are line start/end in
// seconds, each `l` entry a chunk with text `c` and offset `o` (seconds from
// line start), and `x` the full line text.
use serde::Deserialize;

use crate::lyrics::{LyricLine, LyricWord, LyricsDoc, ParseError, SourceId};

#[derive(Debug, Deserialize)]
struct RichLine {
    ts: f64,
    te: f64,
    #[serde(default)]
    l: Vec<RichChunk>,
    #[serde(default)]
    x: String,
}

#[derive(Debug, Deserialize)]
struct RichChunk {
    c: String,
    o: f64,
}

fn secs_to_ms(s: f64) -> u64 {
    (s.max(0.0) * 1000.0).round() as u64
}

pub fn parse_richsync(body: &str, track_key: &str) -> Result<LyricsDoc, ParseError> {
    let raw: Vec<RichLine> =
        serde_json::from_str(body).map_err(|e| ParseError::Malformed(e.to_string()))?;
    if raw.is_empty() {
        return Err(ParseError::NoTimestamps);
    }

    let mut lines: Vec<LyricLine> = Vec::with_capacity(raw.len());
    for rl in raw {
        let line_start = secs_to_ms(rl.ts);
        let line_end = secs_to_ms(rl.te).max(line_start);

        let mut words: Vec<LyricWord> = Vec::with_capacity(rl.l.len());
        for (i, chunk) in rl.l.iter().enumerate() {
            let start = line_start + secs_to_ms(chunk.o);
            // End = next chunk's start, or the line end for the last chunk.
            let end = rl
                .l
                .get(i + 1)
                .map(|next| line_start + secs_to_ms(next.o))
                .unwrap_or(line_end)
                .max(start);
            words.push(LyricWord {
                start,
                end,
                text: chunk.c.clone(),
            });
        }

        let text = if rl.x.is_empty() {
            words.iter().map(|w| w.text.as_str()).collect::<String>()
        } else {
            rl.x.clone()
        };

        lines.push(LyricLine {
            start: line_start,
            end: line_end,
            text,
            words: if words.is_empty() { None } else { Some(words) },
            translation: None,
        });
    }

    lines.sort_by_key(|l| l.start);
    let has_word_timing = lines.iter().any(|l| l.words.is_some());

    Ok(LyricsDoc {
        source: SourceId::Musixmatch,
        track_key: track_key.to_string(),
        lines,
        plain: None,
        has_word_timing,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = r#"[{"ts":13.65,"te":17.88,"l":[{"c":"one","o":0},{"c":" two","o":0.32},{"c":" three","o":0.73}],"x":"one two three"}]"#;

    #[test]
    fn parses_word_level_timings() {
        let doc = parse_richsync(SAMPLE, "k").unwrap();
        assert!(doc.has_word_timing);
        assert_eq!(doc.lines.len(), 1);
        let l = &doc.lines[0];
        assert_eq!(l.start, 13_650);
        assert_eq!(l.end, 17_880);
        assert_eq!(l.text, "one two three");
        let w = l.words.as_ref().unwrap();
        assert_eq!(w.len(), 3);
        assert_eq!(w[0].start, 13_650);
        assert_eq!(w[0].end, 13_970); // next chunk start (0.32s later)
        assert_eq!(w[1].start, 13_970);
        assert_eq!(w[2].text, " three");
        assert_eq!(w[2].end, 17_880); // last chunk -> line end
    }

    #[test]
    fn empty_array_errors() {
        assert!(matches!(parse_richsync("[]", "k"), Err(ParseError::NoTimestamps)));
    }

    #[test]
    fn malformed_json_errors() {
        assert!(matches!(parse_richsync("not json", "k"), Err(ParseError::Malformed(_))));
    }
}
