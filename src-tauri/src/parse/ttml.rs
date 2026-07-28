// Apple Music syllable TTML parser (quick-xml).
//
// `<p begin end>` lines contain `<span begin end>syllable</span>` word timings.
// `begin`/`end` are `SS.mmm` or `MM:SS.mmm` (also `HH:MM:SS.mmm`).
use quick_xml::events::Event;
use quick_xml::Reader;

use crate::lyrics::{LyricLine, LyricWord, LyricsDoc, ParseError, SourceId};

pub fn parse_ttml(xml: &str, track_key: &str) -> Result<LyricsDoc, ParseError> {
    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(false);

    let mut lines: Vec<LyricLine> = Vec::new();
    let mut cur: Option<PLine> = None;
    let mut buf = Vec::new();

    loop {
        match reader.read_event_into(&mut buf) {
            Err(e) => return Err(ParseError::Malformed(e.to_string())),
            Ok(Event::Eof) => break,
            Ok(Event::Start(e)) => {
                let name = e.local_name();
                match name.as_ref() {
                    b"p" => {
                        let (begin, end) = read_times(&reader, &e);
                        cur = Some(PLine {
                            start: begin.unwrap_or(0),
                            end: end.unwrap_or(0),
                            words: Vec::new(),
                            text: String::new(),
                            in_span: false,
                            span_start: 0,
                            span_end: 0,
                        });
                    }
                    b"span" => {
                        if let Some(p) = cur.as_mut() {
                            let (begin, end) = read_times(&reader, &e);
                            p.in_span = true;
                            p.span_start = begin.unwrap_or(p.end);
                            p.span_end = end.unwrap_or(p.span_start);
                        }
                    }
                    _ => {}
                }
            }
            Ok(Event::Text(t)) => {
                if let Some(p) = cur.as_mut() {
                    let text = t.unescape().unwrap_or_default().to_string();
                    p.text.push_str(&text);
                    if p.in_span {
                        p.words.push(LyricWord {
                            start: p.span_start,
                            end: p.span_end.max(p.span_start),
                            text,
                        });
                    }
                }
            }
            Ok(Event::End(e)) => match e.local_name().as_ref() {
                b"span" => {
                    if let Some(p) = cur.as_mut() {
                        p.in_span = false;
                    }
                }
                b"p" => {
                    if let Some(p) = cur.take() {
                        lines.push(p.into_line());
                    }
                }
                _ => {}
            },
            _ => {}
        }
        buf.clear();
    }

    if lines.is_empty() {
        return Err(ParseError::NoTimestamps);
    }
    lines.sort_by_key(|l| l.start);
    let has_word_timing = lines.iter().any(|l| l.words.is_some());

    Ok(LyricsDoc {
        source: SourceId::Applemusic,
        track_key: track_key.to_string(),
        lines,
        plain: None,
        has_word_timing,
        source_duration_ms: None,
    })
}

struct PLine {
    start: u64,
    end: u64,
    words: Vec<LyricWord>,
    text: String,
    in_span: bool,
    span_start: u64,
    span_end: u64,
}

impl PLine {
    fn into_line(self) -> LyricLine {
        let end = if self.end > self.start {
            self.end
        } else {
            self.words.last().map(|w| w.end).unwrap_or(self.start)
        };
        LyricLine {
            start: self.start,
            end,
            text: self.text.trim().to_string(),
            words: if self.words.is_empty() {
                None
            } else {
                Some(self.words)
            },
            translation: None,
        }
    }
}

fn read_times<B>(reader: &Reader<B>, e: &quick_xml::events::BytesStart) -> (Option<u64>, Option<u64>) {
    let mut begin = None;
    let mut end = None;
    for attr in e.attributes().flatten() {
        let key = attr.key.local_name();
        let val = attr.decode_and_unescape_value(reader.decoder()).ok();
        match key.as_ref() {
            b"begin" => begin = val.as_deref().and_then(parse_ttml_time),
            b"end" => end = val.as_deref().and_then(parse_ttml_time),
            _ => {}
        }
    }
    (begin, end)
}

/// Parse `SS.mmm`, `MM:SS.mmm` or `HH:MM:SS.mmm` into milliseconds.
fn parse_ttml_time(s: &str) -> Option<u64> {
    let s = s.trim().trim_end_matches('s');
    let (whole, frac) = match s.split_once('.') {
        Some((w, f)) => (w, Some(f)),
        None => (s, None),
    };
    let parts: Vec<&str> = whole.split(':').collect();
    let mut secs: u64 = 0;
    for p in &parts {
        secs = secs * 60 + p.parse::<u64>().ok()?;
    }
    let frac_ms = match frac {
        None => 0,
        Some(f) => {
            let digits: String = f.chars().take(3).collect();
            let val: u64 = digits.parse().ok()?;
            val * 10u64.pow(3 - digits.len() as u32)
        }
    };
    Some(secs * 1000 + frac_ms)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = r#"<tt><body><div>
      <p begin="13.650" end="17.880" itunes:key="L1">
        <span begin="13.650" end="13.970">Never</span>
        <span begin="13.970" end="14.380"> gonna</span>
      </p>
      <p begin="00:16.500" end="00:20.000">
        <span begin="16.500" end="16.900">Never</span>
      </p>
    </div></body></tt>"#;

    #[test]
    fn parses_syllable_ttml() {
        let doc = parse_ttml(SAMPLE, "k").unwrap();
        assert!(doc.has_word_timing);
        assert_eq!(doc.lines.len(), 2);
        let l = &doc.lines[0];
        assert_eq!(l.start, 13_650);
        assert_eq!(l.end, 17_880);
        let w = l.words.as_ref().unwrap();
        assert_eq!(w.len(), 2);
        assert_eq!(w[0].text, "Never");
        assert_eq!(w[0].start, 13_650);
        assert_eq!(w[0].end, 13_970);
        assert_eq!(w[1].text, " gonna");
    }

    #[test]
    fn parses_mmss_times() {
        let doc = parse_ttml(SAMPLE, "k").unwrap();
        assert_eq!(doc.lines[1].start, 16_500);
        assert_eq!(doc.lines[1].end, 20_000);
    }

    #[test]
    fn empty_errors() {
        assert!(matches!(parse_ttml("<tt></tt>", "k"), Err(ParseError::NoTimestamps)));
    }
}
