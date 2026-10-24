# CoachBuild item-set merge experiment

One deterministic, stateless Rust function ports `ItemSetMergeService.Merge`.
No WPF source, UI, publish scripts or release feed is changed. This crate is not
wired into the shipping app, so removing this experiment is the rollback.

```rust
coachbuild_core::merge(&existing, &new_sets, replace_prefix)
```

The function returns an independent JSON document (or `None` for non-object
existing JSON). It removes sets with a `CoachBuild` title prefix or `coachbuild-`
uid prefix and preserves every foreign JSON value. It ignores `replace_prefix`,
as C# does. **The caller must validate new sets and control writes**. No validation,
connection state, I/O or mutation of the input is performed by the function.

CLI usage on a machine approved to run its native artifact:

```text
coachbuild-core merge-itemset < input.json
```

Input:

```json
{"existing":{"accountId":77,"itemSets":[{"title":"My build"},{"uid":"coachbuild-old"}]},"newSets":[{"title":"Galio Mid (Pro)","uid":"coachbuild-new"}],"replacePrefix":null}
```

Output:

```json
{"accountId":77,"itemSets":[{"title":"My build"},{"title":"Galio Mid (Pro)","uid":"coachbuild-new"}]}
```

For this laptop, the same CLI runs as WASI without native executable launch:

```text
node desktop/rust/run-wasi.cjs desktop/rust/coachbuild-core/target/wasm32-wasip1/debug/coachbuild-core.wasm merge-itemset < input.json
```

These are shell usage lines; PowerShell users can invoke redirection through
`cmd /c`. Invalid adapter input returns a JSON error and exit code 2; a valid
non-object `existing` returns JSON null and exit code 0, matching the C# overload.
`merge-runepage` and `lanescore` are deliberately absent.

Use `powershell -NoProfile -ExecutionPolicy Bypass -File desktop/rust/verify.ps1`
from the checkout to build native artifacts, verify the oracle, execute WASI tests
and exercise the CLI. It uses the required heavy-job wrapper and records evidence.
Prerequisites: the specified Rust stable toolchain with `wasm32-wasip1` target,
Node 24 with WASI, and the local .NET 8 SDK. Node currently labels WASI experimental;
portable tests do not replace native Windows execution on an approved runner.
Use `-NativeTests` there to execute native cargo tests instead of WASI checks.

To regenerate the differential fixture after an intentional source update, build
`oracle/MergeOracle.csproj`, then run `node desktop/rust/parity.cjs generate
<dotnet-host>`. Review changed reference results and source hashes before replacing
the fixture; `verify.ps1` only verifies it and will fail on a mismatch.

See [verification](VERIFICATION.md), [test mapping](coachbuild-core/tests/README.md),
and [migration decision and stop gates](MIGRATION.md).
