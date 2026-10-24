//! The deterministic ItemSetMergeService.Merge port, isolated from the shipping app.
//!
//! Mirrors the merge cases in ItemSetMergeTests.cs and ItemSetOwnershipTests.cs.
//! ItemSetWireToleranceTests.cs tests request/apply behavior, deliberately outside
//! this stateless merge function. See ../MIGRATION.md and tests/README.md.
use serde_json::Value;

/// Clone an existing document, remove app-owned sets, append non-null new sets.
///
/// Returns None for a non-object existing value, matching the C# JsonElement
/// overload. `replace_prefix` is intentionally ignored by the C# implementation.
/// Foreign values, including title-less, scalar and null entries, are preserved.
/// This is a structural JSON merge; serialized byte size/escaping is not ported.
/// No input validation or account write occurs here: the host owns those gates.
pub fn merge(existing: &Value, new_sets: &[Value], _replace_prefix: Option<&str>) -> Option<Value> {
    let mut result = existing.as_object()?.clone();
    let mut kept: Vec<Value> = existing
        .get("itemSets")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|set| {
            let legacy = set
                .get("title")
                .and_then(Value::as_str)
                .is_some_and(|s| s.starts_with("CoachBuild"));
            let uid = set
                .get("uid")
                .and_then(Value::as_str)
                .is_some_and(|s| s.starts_with("coachbuild-"));
            !legacy && !uid
        })
        .cloned()
        .collect();
    kept.extend(new_sets.iter().filter(|set| !set.is_null()).cloned());
    result.insert("itemSets".into(), Value::Array(kept));
    Some(Value::Object(result))
}
