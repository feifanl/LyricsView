// Lyrics format parsers. Each is a pure function returning
// `Result<LyricsDoc, ParseError>` and never panics. Additional parsers (yrc,
// richsync, ttml) are added in later milestones.
pub mod lrc;

pub use lrc::parse_lrc;
