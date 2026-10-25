// Fehler, übersetzbare Texte und kleine Helfer, die JavaScript-Semantik nachbilden.
//
// Übersetzt wird nicht in Rust, sondern im Frontend mit src/shared/i18n.js: Texte werden als
// { "$t": key, "p": params } verschickt und von bridge.js in die aktuelle Sprache übersetzt.
use serde::Serialize;
use serde_json::{json, Value};

/// Übersetzbarer Text (Schlüssel aus shared/i18n.js).
pub fn t(key: &str) -> Value {
    json!({ "$t": key })
}

pub fn tp(key: &str, params: Value) -> Value {
    json!({ "$t": key, "p": params })
}

/// Fehler, wie er beim Frontend ankommt: Text oder übersetzbarer Text.
#[derive(Debug, Clone, Serialize)]
#[serde(transparent)]
pub struct AppError(pub Value);

pub type Res<T> = Result<T, AppError>;

impl AppError {
    pub fn tr(key: &str) -> Self {
        AppError(t(key))
    }
    pub fn trp(key: &str, params: Value) -> Self {
        AppError(tp(key, params))
    }
    pub fn msg(text: impl Into<String>) -> Self {
        AppError(Value::String(text.into()))
    }
}

macro_rules! from_error {
    ($($t:ty),*) => {$(
        impl From<$t> for AppError {
            fn from(e: $t) -> Self {
                AppError::msg(e.to_string())
            }
        }
    )*};
}
from_error!(std::io::Error, reqwest::Error, serde_json::Error, tauri::Error, String, &str);

/// Wahrheitswert wie in JavaScript (`if (value)`).
pub fn truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().map_or(false, |f| f != 0.0 && !f.is_nan()),
        Value::String(s) => !s.is_empty(),
        _ => true,
    }
}

/// `String(value)` für JSON-Werte.
pub fn js_string(v: &Value) -> String {
    match v {
        Value::Null => String::new(),
        Value::String(s) => s.clone(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => number_string(n.as_f64().unwrap_or(0.0)),
        Value::Array(a) => a.iter().map(js_string).collect::<Vec<_>>().join(","),
        Value::Object(_) => "[object Object]".into(),
    }
}

fn number_string(f: f64) -> String {
    if f.fract() == 0.0 && f.abs() < 1e15 {
        format!("{}", f as i64)
    } else {
        format!("{f}")
    }
}

/// `Number(value)` als JSON-Zahl (ganzzahlig, wenn möglich).
pub fn js_number(v: &Value) -> Value {
    let f = match v {
        Value::Number(n) => n.as_f64().unwrap_or(0.0),
        Value::String(s) if s.trim().is_empty() => 0.0,
        Value::String(s) => s.trim().parse::<f64>().unwrap_or(f64::NAN),
        Value::Bool(b) => *b as i32 as f64,
        Value::Null => 0.0,
        _ => f64::NAN,
    };
    num(f)
}

pub fn num(f: f64) -> Value {
    if f.is_nan() {
        Value::Null
    } else if f.fract() == 0.0 && f.abs() < 9e15 {
        json!(f as i64)
    } else {
        json!(f)
    }
}

pub fn as_f64(v: &Value) -> f64 {
    v.as_f64().unwrap_or(0.0)
}

/// `{ ...a, ...b }` für JSON-Objekte.
pub fn merge(a: &Value, b: &Value) -> Value {
    let mut out = a.as_object().cloned().unwrap_or_default();
    if let Some(b) = b.as_object() {
        for (k, v) in b {
            out.insert(k.clone(), v.clone());
        }
    }
    Value::Object(out)
}

/// Reihenfolge erhalten, Duplikate entfernen (`[...new Set(list)]`).
pub fn unique(list: impl IntoIterator<Item = String>) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    list.into_iter().filter(|x| seen.insert(x.clone())).collect()
}

/// `encodeURIComponent`.
pub fn encode_uri_component(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}
