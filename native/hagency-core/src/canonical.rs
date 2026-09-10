//! Bytes used by the existing AgentOps/outbound JS encoders, for integer DTOs.
//! JS sorts strings by UTF-16, then JSON.stringify reorders array-index keys.
use crate::{InvalidInput, JSON_SAFE_MAX};
use serde_json::Value;
use sha2::{Digest, Sha256};

pub fn encode(value: &Value) -> Result<String, InvalidInput> {
    let mut output = String::new();
    write(value, &mut output, 0)?;
    Ok(output)
}

pub fn digest(value: &Value) -> Result<String, InvalidInput> {
    Ok(format!("{:x}", Sha256::digest(encode(value)?)))
}

fn array_index(key: &str) -> Option<u32> {
    let n: u32 = key.parse().ok()?;
    (n < u32::MAX && n.to_string() == key).then_some(n)
}

fn write(value: &Value, output: &mut String, depth: usize) -> Result<(), InvalidInput> {
    if depth > 64 {
        return Err(InvalidInput("JSON nesting exceeds 64 levels"));
    }
    match value {
        Value::Null => output.push_str("null"),
        Value::Bool(b) => output.push_str(if *b { "true" } else { "false" }),
        Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                if i.unsigned_abs() > JSON_SAFE_MAX {
                    return Err(InvalidInput("integer exceeds JSON safe range"));
                }
                output.push_str(&i.to_string());
            } else if let Some(f) = n
                .as_f64()
                .filter(|f| f.fract() == 0.0 && f.abs() <= JSON_SAFE_MAX as f64)
            {
                output.push_str(&(f as i64).to_string()); // Includes 1.0 and negative zero.
            } else {
                return Err(InvalidInput("signed DTOs require JSON-safe integers"));
            }
        }
        Value::String(s) => output
            .push_str(&serde_json::to_string(s).map_err(|_| InvalidInput("invalid JSON string"))?),
        Value::Array(items) => {
            output.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    output.push(',');
                }
                write(item, output, depth + 1)?;
            }
            output.push(']');
        }
        Value::Object(items) => {
            if items.contains_key("__proto__") {
                return Err(InvalidInput("prototype property is not a signed DTO field"));
            }
            let mut keys: Vec<_> = items.keys().collect();
            keys.sort_by(|a, b| match (array_index(a), array_index(b)) {
                (Some(x), Some(y)) => x.cmp(&y),
                (Some(_), None) => std::cmp::Ordering::Less,
                (None, Some(_)) => std::cmp::Ordering::Greater,
                (None, None) => a.encode_utf16().cmp(b.encode_utf16()),
            });
            output.push('{');
            for (i, key) in keys.into_iter().enumerate() {
                if i > 0 {
                    output.push(',');
                }
                output.push_str(
                    &serde_json::to_string(key).map_err(|_| InvalidInput("invalid key"))?,
                );
                output.push(':');
                write(&items[key], output, depth + 1)?;
            }
            output.push('}');
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn canonical_vectors_match_javascript() {
        let vectors: Value =
            serde_json::from_str(include_str!("../../fixtures/canonical.json")).unwrap();
        for vector in vectors.as_array().unwrap() {
            let value = &vector["input"];
            assert_eq!(
                encode(value).unwrap(),
                vector["canonical"].as_str().unwrap()
            );
            assert_eq!(digest(value).unwrap(), vector["sha256"].as_str().unwrap());
        }
        for raw in [
            "9007199254740992",
            "-9007199254740992",
            "1.25",
            r#"{"__proto__":{}}"#,
        ] {
            assert!(encode(&serde_json::from_str(raw).unwrap()).is_err());
        }
    }
}
