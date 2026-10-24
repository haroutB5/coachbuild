//! Offline JSON adapter for the one exported merge function. No account writes.
use serde_json::{Value, json};
use std::io::{self, Read};
fn main() {
    let result = (|| -> Result<Value, &'static str> {
        if std::env::args().nth(1).as_deref() != Some("merge-itemset") {
            return Err("usage: coachbuild-core merge-itemset < input.json");
        }
        let mut raw = String::new();
        io::stdin()
            .read_to_string(&mut raw)
            .map_err(|_| "cannot read input")?;
        let input: Value = serde_json::from_str(&raw).map_err(|_| "invalid JSON input")?;
        let existing = input.get("existing").ok_or("missing existing")?;
        let new_sets = input
            .get("newSets")
            .and_then(Value::as_array)
            .ok_or("newSets must be an array")?;
        let prefix = match input.get("replacePrefix") {
            None | Some(Value::Null) => None,
            Some(Value::String(s)) => Some(s.as_str()),
            _ => return Err("replacePrefix must be a string or null"),
        };
        Ok(coachbuild_core::merge(existing, new_sets, prefix).unwrap_or(Value::Null))
    })();
    match result {
        Ok(value) => println!("{value}"),
        Err(error) => {
            println!("{}", json!({"ok":false,"error":error}));
            std::process::exit(2);
        }
    }
}
