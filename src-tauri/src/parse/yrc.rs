// NetEase "yrc" word-level parser.
//
// Per line: `[lineStartMs,lineDurMs]` then repeated `(wordStartMs,wordDurMs,0)text`.
// Word starts are absolute (ms). Lines that are JSON metadata objects
// (`{"t":0,"c":[...]}`) or otherwise not timestamped are skipped.
use crate::lyrics::{LyricLine, LyricWord, LyricsDoc, ParseError, SourceId};

pub fn parse_yrc(text: &str, track_key: &str) -> Result<LyricsDoc, ParseError> {
    let mut lines: Vec<LyricLine> = Vec::new();

    for raw in text.lines() {
        let line = raw.trim();
        if !line.starts_with('[') {
            continue; // metadata / JSON / blank
        }
        if let Some(parsed) = parse_line(line) {
            lines.push(parsed);
        }
    }

    if lines.is_empty() {
        return Err(ParseError::NoTimestamps);
    }
    lines.sort_by_key(|l| l.start);
    let has_word_timing = lines.iter().any(|l| l.words.is_some());

    Ok(LyricsDoc {
        source: SourceId::Netease,
        track_key: track_key.to_string(),
        lines,
        plain: None,
        has_word_timing,
    })
}

fn parse_line(line: &str) -> Option<LyricLine> {
    let close = line.find(']')?;
    let header = &line[1..close];
    let (start_s, dur_s) = header.split_once(',')?;
    let line_start: u64 = start_s.trim().parse().ok()?;
    let line_dur: u64 = dur_s.trim().parse().ok()?;
    let line_end = line_start + line_dur;

    let mut words: Vec<LyricWord> = Vec::new();
    let mut rest = &line[close + 1..];
    while let Some(open) = rest.find('(') {
        let after = &rest[open + 1..];
        let Some(cparen) = after.find(')') else { break };
        let meta = &after[..cparen];
        let content = &after[cparen + 1..];
        // Text runs until the next '(' or end of line.
        let next = content.find('(').unwrap_or(content.len());
        let word_text = &content[..next];

        let mut parts = meta.split(',');
        let ws: Option<u64> = parts.next().and_then(|s| s.trim().parse().ok());
        let wd: Option<u64> = parts.next().and_then(|s| s.trim().parse().ok());
        if let (Some(ws), Some(wd)) = (ws, wd) {
            words.push(LyricWord {
                start: ws,
                end: ws + wd,
                text: word_text.to_string(),
            });
        }
        rest = &content[next..];
    }

    let text = words.iter().map(|w| w.text.as_str()).collect::<String>();
    Some(LyricLine {
        start: line_start,
        end: line_end.max(line_start),
        text,
        words: if words.is_empty() { None } else { Some(words) },
        translation: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_yrc_word_timings() {
        let src = "[13650,4230](13650,320,0)Never(13970,410,0) gonna(14380,350,0) give";
        let doc = parse_yrc(src, "k").unwrap();
        assert!(doc.has_word_timing);
        let l = &doc.lines[0];
        assert_eq!(l.start, 13_650);
        assert_eq!(l.end, 17_880);
        assert_eq!(l.text, "Never gonna give");
        let w = l.words.as_ref().unwrap();
        assert_eq!(w.len(), 3);
        assert_eq!(w[0].start, 13_650);
        assert_eq!(w[0].end, 13_970);
        assert_eq!(w[1].text, " gonna");
        assert_eq!(w[2].end, 14_730);
    }

    #[test]
    fn skips_json_metadata_lines() {
        let src = "{\"t\":0,\"c\":[{\"tx\":\"Producer: X\"}]}\n[1000,500](1000,500,0)Hi";
        let doc = parse_yrc(src, "k").unwrap();
        assert_eq!(doc.lines.len(), 1);
        assert_eq!(doc.lines[0].text, "Hi");
    }

    #[test]
    fn empty_errors() {
        assert!(matches!(parse_yrc("\n\n", "k"), Err(ParseError::NoTimestamps)));
    }
}
