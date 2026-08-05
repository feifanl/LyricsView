// Cargo tests for the LRC / Enhanced-LRC parser against real-world fixtures.
use lyricsview_lib::lyrics::{ParseError, SourceId};
use lyricsview_lib::parse::{parse_lrc, serialize_lrc};

const STANDARD: &str = include_str!("fixtures/standard.lrc");
const ENHANCED: &str = include_str!("fixtures/enhanced.lrc");

#[test]
fn standard_lrc_expands_multi_stamps_applies_offset_and_sorts() {
    let doc = parse_lrc(STANDARD, SourceId::Lrclib, "k").unwrap();
    assert!(!doc.has_word_timing);

    // Starts, sorted, with the +120 ms file offset applied. Two stamps on the
    // repeated line expand into two lines (12.00 and 1:45.30).
    let starts: Vec<u64> = doc.lines.iter().map(|l| l.start).collect();
    assert_eq!(starts, vec![620, 12_120, 16_620, 19_320, 105_420]);

    // Out-of-order fixture line sorted to the front.
    assert_eq!(doc.lines[0].text, "first line of the fixture");
    // Malformed-timestamp line dropped.
    assert!(doc.lines.iter().all(|l| !l.text.contains("malformed")));

    // Line end = next line start.
    assert_eq!(doc.lines[0].end, 12_120);
}

#[test]
fn enhanced_lrc_parses_word_timings() {
    let doc = parse_lrc(ENHANCED, SourceId::Manual, "k").unwrap();
    assert!(doc.has_word_timing);
    assert_eq!(doc.lines.len(), 2);

    let l0 = &doc.lines[0];
    assert_eq!(l0.text, "first line with word timings");
    let words = l0.words.as_ref().unwrap();
    assert_eq!(words.len(), 5);
    assert_eq!(words[0].text, "first ");
    assert_eq!(words[0].start, 12_000);
    assert_eq!(words[0].end, 12_400); // next word start
    assert_eq!(words[1].start, 12_400);
    // Last word ends with the line (= next line start).
    assert_eq!(words[4].text, "timings");
    assert_eq!(words[4].end, l0.end);
    assert_eq!(l0.end, 16_500);
}

#[test]
fn empty_input_errors() {
    let err = parse_lrc("   \n  \n", SourceId::Lrclib, "k").unwrap_err();
    assert!(matches!(err, ParseError::NoTimestamps));
}

#[test]
fn plain_text_becomes_plain_doc() {
    let doc = parse_lrc("just some lyrics\nwith no timing", SourceId::Manual, "k").unwrap();
    assert!(doc.lines.is_empty());
    assert_eq!(doc.plain.as_deref(), Some("just some lyrics\nwith no timing"));
}

#[test]
fn duplicate_and_out_of_order_timestamps_are_sorted() {
    let src = "[00:30.00]third\n[00:10.00]first\n[00:10.00]first-dup\n[00:20.00]second";
    let doc = parse_lrc(src, SourceId::Lrclib, "k").unwrap();
    let starts: Vec<u64> = doc.lines.iter().map(|l| l.start).collect();
    assert_eq!(starts, vec![10_000, 10_000, 20_000, 30_000]);
}

#[test]
fn serialize_roundtrips_word_timing() {
    let doc = parse_lrc(ENHANCED, SourceId::Manual, "k").unwrap();
    let lrc = serialize_lrc(&doc);
    // Re-parse the serialized output; word timings survive as enhanced tags.
    let again = parse_lrc(&lrc, SourceId::Manual, "k").unwrap();
    assert!(again.has_word_timing);
    assert_eq!(again.lines.len(), doc.lines.len());
    assert_eq!(again.lines[0].text, doc.lines[0].text);
    assert_eq!(
        again.lines[0].words.as_ref().unwrap()[0].start,
        doc.lines[0].words.as_ref().unwrap()[0].start
    );
}

#[test]
fn line_with_no_words_after_tag_is_kept_empty() {
    let doc = parse_lrc("[00:05.00]", SourceId::Lrclib, "k").unwrap();
    assert_eq!(doc.lines.len(), 1);
    assert_eq!(doc.lines[0].text, "");
    assert_eq!(doc.lines[0].start, 5000);
}
