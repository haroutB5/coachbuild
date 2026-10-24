# Scope and parity proof

The production Rust library exports only `merge(existing, new_sets, replace_prefix)`.
No lifecycle, validation, transport, synchronization, credential, persistence or
rune behavior is claimed. A malformed or foreign *new* set can be appended by this
function, just as by C#. It is not a safe account-write API on its own.

The 12 Rust tests comprise 11 named behavioral tests and one differential test
that checks 1,024 independently generated C# reference cases. The C# oracle calls
the actual unchanged Core project via ProjectReference, not a translated C# model.
`parity.cjs verify` re-executes every case against the current source and checks
the source SHA-256 values. The fixture is deterministic and contains synthetic
JSON only. Runtime test results and native execution limitations are in
`../../evidence/` and `../../VERIFICATION.md`.

| C# test | Rust mirror |
| --- | --- |
| `ItemSetMergeTests.Merge_preserves_foreign_sets_and_top_level_fields_while_pruning_ours` | `preserves_foreign_sets_and_top_level_fields_while_pruning_ours` |
| `ItemSetOwnershipTests.Merge_replaces_uid_owned_and_legacy_titled_sets_and_keeps_everyone_elses` | `replaces_uid_owned_and_legacy_titled_sets_keeps_everyone_elses` |

Additional tests cover input immutability, clone independence, ignored replace
prefixes, exact ordinal ownership (case, soft hyphen, leading spaces), title-less
and scalar/null foreign sets, malformed/non-array itemSets, non-object existing
documents, new null omission, unknown nested fields, preservation of arbitrary
precision numbers, and unmodeled document fields. Differential input combines
these shapes, legacy/title/uid combinations, Unicode and extension fields with a
fixed PRNG seed, including more than three new sets (merge has no count gate).

Deliberately excluded source tests:

- Remaining `ItemSetMergeTests`: payload validation and `ItemSetApplyService`
  HTTP ordering, concurrency and cancellation. They test a stateful writer.
- Remaining `ItemSetOwnershipTests`: write-gate validation and SiteImportValidator
  title/UID generation. They are not ItemSetMergeService behavior.
- `ItemSetWireToleranceTests`: request deserialization and live apply/logging.
  Unknown document-field preservation is tested here, but that is not a port of
  the HTTP request deserializer or apply service.
- All rune/ledger, identity/directory, lane storage, credential discovery and
  wire/logging tests from the initial brief. These modules are not shipped.

Equality is **structural JSON equality**, including array order and values. Object
key ordering, escaping, whitespace and `SerializedUtf8Length` are not asserted.
serde_json is configured with `arbitrary_precision` to avoid rounding foreign
numeric values while cloning; raw lexical JSON bytes are not preserved by either
JSON tree merge. Duplicate property names and parsing invalid JSON are outside
the `&Value` merge API contract.
