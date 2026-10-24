# Verification, 24 October 2026

Scope: `ItemSetMergeService.Merge` only, C# base commit
`ea52debfb6d1f28b137bc7673afcd9aa1a8eff0a`. The WPF app was not launched or changed.
No live League process, credential, account, database or local user history was used.
All heavy builds/tests ran through the requested `heavy-job.ps1` wrapper.

| Check | Result | Evidence |
| --- | --- | --- |
| Unmodified C# core + oracle build | Pass, 0 warnings/errors | `evidence/oracle-build.txt` |
| Live C# differential reference verification | Pass, 1,024 cases and three source SHA-256 values match committed fixture | `evidence/oracle-verify.txt` |
| Native GNU Rust `cargo build --locked` | Pass, no Rust warnings | `evidence/native-build.txt` |
| Native `cargo test --locked --no-run` | Pass, library/CLI/integration test executables compile | `evidence/native-tests-compile.txt` |
| WASI `cargo test --locked --target wasm32-wasip1` | **12 passed, 0 failed**, including all 1,024 differential cases | `evidence/wasi-tests.txt` |
| WASI CLI build | Pass | `evidence/wasi-cli-build.txt` |
| Actual CLI processes via Node WASI | **6 passed**: merge preservation, null existing result, bad sets, malformed JSON, unsupported command, bad prefix type | `evidence/cli-check.txt` |
| Native Windows test execution | Not passed: OS Application Control blocked generated executable before launch, error 4551 on the initial build | See limitation below |

Rust: stable `1.99.1`, host `x86_64-pc-windows-gnu`. Portable target:
`wasm32-wasip1`. Node: `v24.22.1`. Pure Rust dependencies only (`serde_json` plus
its transitive dependencies); no C compiler dependency introduced by the crate.

Native execution limitation: the initial `cargo test` invocation compiled, then
failed to execute its test artifact: “An Application Control policy has blocked
this file. (os error 4551)”. This happened before tests ran. No security settings
were changed and no GUI executable was launched. WSL is not installed. The final
narrowed native build/test compilation passed; final behavior was executed through
Node WASI with no filesystem preopens or network host imports. The WASI runner
propagates guest exit codes, verified by failing CLI inputs. This proves the pure
merge on the portable target, **not native Windows runtime/installer compatibility**.
Run native tests on an approved Windows runner before integrating the crate.

Test count is 12 Rust harness tests, not 1,036 tests. The differential harness
loops over 1,024 synthetic C# reference cases. There are also six independent
CLI process checks. Two source C# merge tests are mirrored directly; remaining
source tests concern excluded services and are mapped explicitly in the test
README. No .NET test suite pass or shipping-app gate is claimed.

No speed gain, memory saving or production parity beyond this function is claimed.
The migration document contains prospective measurable benefit and stop criteria.
