# Benchmarks

`pnpm benchmark` runs the no-provider local control-plane baseline. It writes private, redacted
JSONL samples, a SHA-256 manifest, and a Markdown report under `benchmarks/results/`. The report
shows p50, p95, p99, host metadata, connection boundary, all failures/timeouts, and separates any
human approval or review time from automated latency.

Provider-backed comparisons are intentionally not part of the default command. Before one runs,
add a committed comparator definition that fixes the provider/CLI/model/account mode, prompt,
initial commit, sandbox, cache policy, common observable start/end clocks, acceptance evaluator,
and declared cost ceiling. Run bare and Fluent arms in randomized paired order on reset fixtures.
Set the declared budget through an explicit approval record; never treat a successful local control
plane sample as evidence of provider or end-to-end speed.

The fixture manifests name the five required task shapes. They become executable fixture
repositories only when their runtime, lockfile, browser/version, and acceptance evidence are all
committed; until then they are registrations, not performance results. Results remain local unless
the user explicitly approves a separately documented redacted publication policy.
