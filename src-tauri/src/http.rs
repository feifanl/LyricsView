// Shared reqwest client factory. A cookie jar is enabled for providers (e.g.
// Musixmatch) that set and expect session cookies to be replayed.
use std::time::Duration;

use reqwest::Client;

pub const APP_UA: &str = "LyricifyOSS/0.1.0 (private use)";

pub fn client(user_agent: &str) -> Client {
    Client::builder()
        .user_agent(user_agent)
        .cookie_store(true)
        .gzip(true)
        .timeout(Duration::from_secs(12))
        .build()
        .expect("failed to build reqwest client")
}
