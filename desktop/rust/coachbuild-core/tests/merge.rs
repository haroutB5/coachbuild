use coachbuild_core::merge;
use serde_json::{Value, json};

// ItemSetMergeTests.Merge_preserves_foreign_sets_and_top_level_fields_while_pruning_ours
#[test]
fn preserves_foreign_sets_and_top_level_fields_while_pruning_ours() {
    let old = json!({"accountId":77,"timestamp":123,"customTopLevel":{"keep":true},"itemSets":[
        {"title":"My hand-made page","type":"custom","blocks":[{"type":"Item","items":[]}]},
        {"title":"CoachBuild Old Champion","blocks":[]},{"blocks":[],"unknown":"keep"}]});
    let fresh = json!({"title":"CoachBuild Current Top","blocks":[{"type":"Item","items":[{"id":"1001","count":1}]}]});
    let result = merge(&old, &[fresh.clone()], None).unwrap();
    assert_eq!(result["accountId"], 77);
    assert_eq!(result["timestamp"], 123);
    assert_eq!(result["customTopLevel"], old["customTopLevel"]);
    assert_eq!(
        result["itemSets"],
        json!([old["itemSets"][0], old["itemSets"][2], fresh])
    );
}
// ItemSetOwnershipTests.Merge_replaces_uid_owned_and_legacy_titled_sets_and_keeps_everyone_elses
#[test]
fn replaces_uid_owned_and_legacy_titled_sets_keeps_everyone_elses() {
    let old = json!({"accountId":7,"itemSets":[
        {"title":"Galio Mid (Pro)","uid":"coachbuild-import-galio-mid-pro"},
        {"title":"CoachBuild import: Galio Mid (u.gg)","uid":"coachbuild-import-galio-mid"},
        {"title":"My Galio build","uid":"user-1"},{"title":"U.GG - Galio","uid":"other"},{"uid":"no-title"}]});
    let fresh =
        json!({"title":"Galio Mid (Coachless)","uid":"coachbuild-import-galio-mid-coachless"});
    let result = merge(&old, &[fresh.clone()], None).unwrap();
    assert_eq!(
        result["itemSets"],
        json!([
            old["itemSets"][2],
            old["itemSets"][3],
            old["itemSets"][4],
            fresh
        ])
    );
}
#[test]
fn foreign_null_scalars_arrays_unknown_nested_values_are_untouched() {
    let foreign = json!([null,42,true,"foreign",[],{"title":null},{"title":42,"uid":[]},{"title":"Foreign","extra":{"arbitrary":[null,3]}}]);
    let old = json!({"itemSets":foreign,"opaque":{"preserve":[1,2,3]}});
    assert_eq!(merge(&old, &[], None), Some(old));
}
#[test]
fn new_nulls_skipped_other_new_values_kept_without_validation() {
    assert_eq!(
        merge(
            &json!({}),
            &[
                Value::Null,
                json!(42),
                json!({"title":"foreign"}),
                json!([])
            ],
            None
        ),
        Some(json!({"itemSets":[42,{"title":"foreign"},[]]}))
    );
}
#[test]
fn all_non_object_existing_shapes_return_none() {
    for v in [Value::Null, json!(false), json!(42), json!("x"), json!([])] {
        assert_eq!(merge(&v, &[], None), None);
    }
}
#[test]
fn missing_or_non_array_item_sets_are_replaced_with_new_array() {
    for v in [
        json!({}),
        json!({"itemSets":null}),
        json!({"itemSets":{}}),
        json!({"itemSets":"bad"}),
        json!({"itemSets":42}),
    ] {
        assert_eq!(merge(&v, &[], None), Some(json!({"itemSets":[]})));
    }
}
#[test]
fn ownership_prefixes_are_ordinal_not_unicode_or_case_folded() {
    let foreign = json!([{"title":"coachbuild x"},{"title":"Coach\u{ad}Build"},{"title":"ＣoachBuild"},{"uid":"Coachbuild-x"},{"uid":"coachbuild"},{"title":" CoachBuild"}]);
    let old = json!({"itemSets":foreign});
    assert_eq!(merge(&old, &[], None), Some(old));
    let owned = json!({"itemSets":[{"title":"CoachBuild"},{"title":"CoachBuilder"},{"uid":"coachbuild-"},{"title":null,"uid":"coachbuild-x"}]});
    assert_eq!(merge(&owned, &[], None), Some(json!({"itemSets":[]})));
}
#[test]
fn replace_prefix_is_ignored_even_when_unrelated_or_empty() {
    let old =
        json!({"itemSets":[{"title":"CoachBuild A"},{"uid":"coachbuild-B"},{"title":"Foreign"}]});
    for prefix in [None, Some(""), Some("CoachBuild A"), Some("Foreign")] {
        assert_eq!(
            merge(&old, &[], prefix),
            Some(json!({"itemSets":[{"title":"Foreign"}]}))
        );
    }
}
#[test]
fn inputs_are_never_mutated_and_returned_documents_are_independent() {
    let old = json!({"itemSets":[{"title":"Foreign","nested":{"keep":true}}]});
    let fresh = vec![json!({"title":"CoachBuild New","nested":[1]})];
    let snapshot = (old.clone(), fresh.clone());
    let mut result = merge(&old, &fresh, None).unwrap();
    result["itemSets"][0]["nested"]["keep"] = json!(false);
    result["itemSets"][1]["nested"][0] = json!(9);
    assert_eq!((old, fresh), snapshot);
}
#[test]
fn arbitrary_precision_numbers_survive_without_rounding() {
    let old:Value=serde_json::from_str(r#"{"big":1844674407370955161600001,"itemSets":[{"number":0.12345678901234567890123456789}]}"#).unwrap();
    assert_eq!(merge(&old, &[], None), Some(old));
}
#[test]
fn unknown_situational_and_diagnostic_document_fields_do_not_affect_merge() {
    let old = json!({"situational":[{"id":null}],"diagnostics":42,"newFutureField":{"nested":[1,2]},"itemSets":[{"title":"Foreign"}]});
    let result = merge(
        &old,
        &[json!({"title":"CoachBuild New","situational":"nonsense"})],
        None,
    )
    .unwrap();
    for key in ["situational", "diagnostics", "newFutureField"] {
        assert_eq!(result[key], old[key]);
    }
}
#[test]
fn differential_against_current_csharp_oracle_corpus() {
    let corpus: Value = serde_json::from_str(include_str!("fixtures/parity.json")).unwrap();
    let cases = corpus["cases"].as_array().unwrap();
    assert_eq!(cases.len(), 1024);
    for (index, case) in cases.iter().enumerate() {
        let actual = merge(
            &case["existing"],
            case["newSets"].as_array().unwrap(),
            case["replacePrefix"].as_str(),
        )
        .unwrap_or(Value::Null);
        assert_eq!(actual, case["expected"], "C# differential case {index}");
    }
}
