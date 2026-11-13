//! NEP-297 style events, logged as `EVENT_JSON:{...}`. The indexer and UI
//! can follow the exchange from these without reading contract state.

use near_sdk::env;
use near_sdk::serde_json::{json, Value};

pub const STANDARD: &str = "silica";
pub const VERSION: &str = "1.0.0";

pub fn emit(event: &str, data: Value) {
    let payload = json!({
        "standard": STANDARD,
        "version": VERSION,
        "event": event,
        "data": data,
    });
    env::log_str(&format!("EVENT_JSON:{}", payload));
}
