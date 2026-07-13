// Lyrics format parsers. Each is a pure function returning
// `Result<LyricsDoc, ParseError>` and never panics. Additional parsers (yrc,
// richsync, ttml) are added in later milestones.
pub mod lrc;
pub mod richsync;
pub mod ttml;
pub mod yrc;

pub use lrc::{parse_lrc, serialize_lrc};
pub use richsync::parse_richsync;
pub use ttml::parse_ttml;
pub use yrc::parse_yrc;
