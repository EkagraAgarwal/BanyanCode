# BanyanCode + Needle 2
## Universal Repository Intelligence Gateway — Detailed Architectural Guidelines

**Status:** Proposed architecture / feasibility and implementation guide  
**Primary audience:** BanyanCode coding agent, maintainers, contributors  
**Scope:** Model-agnostic repository intelligence, local routing, tool mediation, and integration of Needle 2 by Cactus Compute

---

# 1. Executive Summary

BanyanCode's repository-intelligence layer should not require the primary coding model to learn Banyan's preferred tools.

The observed failure mode is:

1. A model has access to standard repository tools such as `read`, `grep`, and `glob`.
2. Banyan also exposes specialized tools such as `codegraph_search`, `codegraph_callers`, `codegraph_dependents`, `codegraph_impact`, structural queries, ownership, and architecture discovery.
3. Some models overwhelmingly select the conventional tools.
4. The same model may be able to explain that a Banyan tool would have been better, yet continue selecting conventional tools in future actions.

Therefore, the model's tool-selection policy should not be a hard dependency of Banyan's repository-intelligence quality.

This document proposes a local **Repository Intelligence Gateway** with **Needle 2** as a tiny intermediary routing model.

The core architecture is:

```text
                         ANY PRIMARY LLM
                                |
                         tool call / action
                                |
                                v
                  +---------------------------+
                  | Banyan Tool Gateway       |
                  | compatibility + policy   |
                  +-------------+-------------+
                                |
                         normalized request
                                |
                                v
                     +--------------------+
                     |     Needle 2       |
                     | semantic routing   |
                     | + argument         |
                     | extraction        |
                     +---------+----------+
                               |
                     route + confidence
                               |
              +----------------+----------------+
              |                |                |
              v                v                v
           DIRECT           AUGMENT        INTELLIGENCE
              |                |                |
              v                v                v
        filesystem       FS + graph      codegraph / AST /
        text search      metadata        structural search
              |                |                |
              +----------------+----------------+
                               |
                         unified result
                               |
                               v
                          PRIMARY LLM
```

The model may continue to behave as if it is using:

```text
read
grep
glob
```

while Banyan internally routes repository-semantic operations through:

```text
code graph
AST
hybrid search
structural queries
architecture
ownership
impact analysis
```

This yields a stronger form of model independence:

> The primary model does not need to select a Banyan-specific tool in order for Banyan intelligence to participate.

Needle 2 should **not** become a second coding agent. It should be a compact local router / structured-output component that classifies repository operations and extracts arguments. Banyan remains responsible for validation, execution, permissions, freshness, result formatting, and fallback.

---

# 2. Core Design Principle

The central architectural invariant is:

> **The model chooses what repository information it wants; Banyan decides the best mechanism for obtaining it.**

Do not make the system depend on:

```text
"the model must call codegraph_callers"
```

Instead make it possible for:

```text
grep("who calls Foo?")
```

to become:

```text
CALLERS(Foo)
```

inside Banyan.

Similarly:

```text
read("README.md")
```

must remain:

```text
DIRECT_READ(README.md)
```

because the filesystem is authoritative for arbitrary repository content.

---

# 3. Why a Tiny Local Router Is Valuable

The intermediary layer needs a different optimization target from the primary LLM.

The primary model is optimized for:

- planning,
- reasoning,
- coding,
- tool use,
- explaining changes.

The local router is optimized for:

- semantic classification,
- argument extraction,
- structured output,
- low latency,
- predictable behavior,
- low memory use.

Needle 2 is attractive because it is specifically designed as a small local tool-calling model and can provide structured outputs and confidence signals.

The architecture should exploit this division of labor.

```text
Primary LLM
  = reasoning policy

Needle
  = repository-action routing policy

Banyan
  = repository execution and intelligence
```

This separation is intentional.

---

# 4. Goals

## 4.1 Primary goals

- Work with models that strongly prefer `read`, `grep`, and `glob`.
- Preserve legitimate uses of conventional tools.
- Route repository-semantic requests to the most appropriate Banyan backend.
- Keep routing local and cheap.
- Avoid adding another large-model dependency.
- Make routing behavior observable.
- Make failures safe and reversible.
- Permit native Banyan tools for models that already use them.
- Allow future fine-tuning of the router using Banyan telemetry.
- Keep the architecture independent of Needle's exact implementation.

## 4.2 Secondary goals

- Reduce redundant search/read loops.
- Reduce unnecessary context consumption.
- Increase repository relationship discovery.
- Improve consistency across model providers.
- Make repository intelligence portable across future model families.
- Establish a clean abstraction for future local router models.

---

# 5. Non-Goals

The first version should not:

- replace the filesystem with the graph,
- force all operations through codegraph,
- make every `read` call expensive,
- use an LLM router for trivial operations,
- allow Needle to execute arbitrary tools directly,
- mutate files as a side effect of routing,
- assume all repositories are fully indexed,
- assume all code is parseable,
- treat codegraph completeness as authoritative over the filesystem,
- couple the entire architecture to Needle 2,
- use routing to conceal errors or stale graph state.

---

# 6. Three-Way Routing Model

All repository requests should resolve to one of:

```ts
type RepositoryRoute =
  | "direct"
  | "augment"
  | "intelligence";
```

## 6.1 DIRECT

Use the originally requested primitive.

Examples:

```text
read README.md
read docs/architecture.md
read package.json
read Dockerfile
read .github/workflows/test.yml
grep TODO
grep FIXME
grep "authentication" docs/
glob docs/**/*.md
glob **/*.json
```

The filesystem or text-search implementation remains authoritative.

---

## 6.2 AUGMENT

Keep the original operation but optionally add high-value repository metadata.

Example:

```text
read src/auth/AuthManager.ts
```

Return the exact requested contents and optionally include:

```text
Symbol: AuthManager
Imports: TokenService, UserRepository
References: 8
Callers: 4
Dependents: 6
```

Augmentation must be:

- compact,
- optional,
- provenance-aware,
- configurable,
- disabled when likely to increase context more than value.

---

## 6.3 INTELLIGENCE

Replace or upgrade the requested retrieval mechanism when the request clearly expresses repository semantics.

Examples:

```text
grep("who calls AuthManager?")
grep("where is AuthManager referenced?")
grep("what depends on AuthManager?")
grep("what implements AuthInterface?")
grep("which classes extend BaseController?")
```

Potential routes:

```text
CALLERS
REFERENCES
DEPENDENTS
IMPLEMENTATIONS
EXTENSIONS
STRUCTURAL
IMPACT
```

---

# 7. Never Collapse "Search" and "Read" Into One Operation

The router must preserve the difference between:

```text
retrieve exact content
```

and:

```text
discover repository relationships
```

The following must remain possible:

```text
read an entire function
read a class
read a markdown file
read a configuration file
read a text file
grep documentation
grep arbitrary generated output
glob documentation
glob all config files
```

A code graph is an additional representation of the repository, not a replacement for the repository itself.

---

# 8. Model-Facing Compatibility Layer

For model compatibility, Banyan should continue to support familiar interfaces:

```text
read
grep
glob
```

The important change is that these interfaces should flow through the gateway.

```text
Model
  |
  +-- read ----+
  +-- grep ----+--> Repository Gateway
  +-- glob ----+
```

The gateway then decides what actually executes.

Do not require the model to explicitly select:

```text
codegraph_search
codegraph_callers
...
```

for the gateway to use them.

---

# 9. Native Banyan Tools Remain

The gateway must not eliminate native specialized tools.

Capable models should still be allowed to call:

```text
codegraph_search
codegraph_callers
codegraph_dependents
codegraph_impact
structural queries
repository architecture
repository ownership
```

Native calls have an advantage:

- semantics are already explicit,
- less routing ambiguity,
- direct access to advanced features,
- useful for models that learn Banyan's vocabulary.

The system should support both paths:

```text
                  PRIMARY LLM
                       |
          +------------+------------+
          |                         |
    native Banyan              compatibility
       tools                   read/grep/glob
          |                         |
          +------------+------------+
                       |
                       v
              Repository Gateway
```

---

# 10. Canonical Internal Request

All repository operations should normalize into one internal request type.

Suggested interface:

```ts
interface RepositoryRequest {
  source:
    | "model-tool"
    | "native-banyan-tool"
    | "internal";

  originalTool: string;

  arguments: Record<string, unknown>;

  userRequest?: string;

  recentToolCalls?: RepositoryToolCall[];

  investigationState?: InvestigationState;

  repositoryContext?: RepositoryContext;
}
```

The exact names may be adapted to current Banyan conventions.

---

# 11. Canonical Semantic Operation

The gateway should classify into semantic operations, not implementation names.

Suggested type:

```ts
type RepositoryOperation =
  | {
      kind: "content";
      path: string;
      range?: {
        startLine?: number;
        endLine?: number;
      };
    }
  | {
      kind: "text_search";
      pattern: string;
      paths?: string[];
    }
  | {
      kind: "file_discovery";
      pattern: string;
      path?: string;
    }
  | {
      kind: "symbol";
      query: string;
      path?: string;
    }
  | {
      kind: "relationship";
      relation:
        | "callers"
        | "callees"
        | "references"
        | "dependents"
        | "imports"
        | "implementations"
        | "extensions";
      target: string;
    }
  | {
      kind: "structural";
      query: string;
      language?: string;
    }
  | {
      kind: "architecture";
      query: string;
    }
  | {
      kind: "ownership";
      query: string;
    };
```

The internal representation should be stable even if model-visible tools change.

---

# 12. Needle's Job

Needle should answer:

1. What semantic repository operation is being requested?
2. What arguments are needed?
3. How confident is the routing decision?

Example:

```json
{
  "route": "CALLERS",
  "target": "AuthManager",
  "confidence": 0.97
}
```

Needle should NOT:

- modify files,
- execute shell commands,
- invoke arbitrary tools,
- manage long-horizon planning,
- make permission decisions,
- determine graph freshness,
- bypass Banyan's validation.

---

# 13. Needle Output Schema

Prefer a tiny strict schema.

Possible schema:

```ts
type NeedleRoute =
  | "DIRECT_READ"
  | "DIRECT_SEARCH"
  | "DIRECT_GLOB"
  | "SYMBOL_SEARCH"
  | "REFERENCES"
  | "CALLERS"
  | "CALLEES"
  | "DEPENDENTS"
  | "IMPORTS"
  | "IMPLEMENTATIONS"
  | "EXTENSIONS"
  | "IMPACT"
  | "STRUCTURAL"
  | "ARCHITECTURE"
  | "OWNERSHIP"
  | "HYBRID";
```

Suggested output:

```json
{
  "route": "REFERENCES",
  "target": "AuthManager",
  "confidence": 0.93
}
```

Arguments should be minimal.

Do not ask Needle to write an explanation.

---

# 14. Why Semantic Routes Are Better Than Tool Names

Avoid training Needle around:

```text
codegraph_callers
codegraph_dependents
```

as its only vocabulary.

Prefer:

```text
CALLERS
DEPENDENTS
```

because the implementation may change.

Today:

```text
CALLERS -> codegraph_callers
```

Tomorrow:

```text
CALLERS -> graph + AST + index
```

The router should not care.

---

# 15. Input Context to Needle

Needle should receive enough context to disambiguate the request but not an entire conversation.

Recommended context:

```text
USER TASK:
...

CURRENT MODEL TOOL CALL:
grep("AuthManager")

RECENT REPOSITORY ACTIONS:
...

KNOWN INVESTIGATION ENTITIES:
AuthManager

KNOWN FILES:
src/auth/AuthManager.ts
```

Context should be aggressively bounded.

---

# 16. Context Ordering

Recommended order:

1. Current tool call
2. User task
3. Relevant investigation state
4. Recent repository operations
5. Relevant repository metadata

This ensures the actual requested action remains dominant.

---

# 17. Context Budget

Needle should never receive:

- the entire chat history,
- entire source files,
- giant tool results,
- all repository metadata.

It is a router, not a context synthesizer.

A reasonable context budget should be measured empirically, but should remain small enough that routing latency is predictable.

---

# 18. Hierarchical Routing

A two-stage router may be better than a single large operation catalog.

Stage 1:

```text
CONTENT
SEARCH
DISCOVERY
SYMBOL
RELATIONSHIP
STRUCTURAL
ARCHITECTURE
OWNERSHIP
```

Stage 2:

```text
RELATIONSHIP
  -> CALLERS / CALLEES / REFERENCES / DEPENDENTS / IMPORTS
```

Advantages:

- smaller decision spaces,
- simpler schemas,
- potentially better accuracy,
- easier debugging.

Disadvantage:

- extra inference invocation.

The initial implementation should benchmark both one-stage and two-stage routing before standardizing.

---

# 19. Recommended Initial Router Strategy

Use a hybrid decision chain:

```text
1. deterministic fast path
2. Needle semantic routing
3. Banyan validation
4. safe fallback
```

Never invoke Needle for obvious operations.

Examples of deterministic fast-path operations:

```text
read README.md
read package.json
glob docs/**/*.md
grep TODO
```

---

# 20. Deterministic Fast-Path Rules

Strong DIRECT indicators:

- `README`
- `CONTRIBUTING`
- `LICENSE`
- `CHANGELOG`
- `docs/`
- `.md`
- `.txt`
- `.yaml`
- `.yml`
- `.json`
- `.toml`
- `.xml`
- `.env`
- `Dockerfile`
- `.github/`
- exact file content requests
- exact line/range requests
- literal text queries with no semantic relationship language

Strong INTELLIGENCE indicators:

- callers
- call sites
- references
- usages
- dependents
- dependencies
- implementations
- implementations of
- extends
- subclasses
- imported by
- imports from
- impact
- affected components
- architecture
- ownership
- definition
- symbol
- relationship

These should be treated as signals, not absolute laws.

---

# 21. The User's Original Request Must Be Visible to the Router

The same tool call can mean different things.

Example A:

```text
User:
Find all references to AuthManager.

Model:
grep("AuthManager")
```

Likely:

```text
REFERENCES
```

Example B:

```text
User:
Search the documentation for AuthManager.

Model:
grep("AuthManager", "docs/")
```

Likely:

```text
DIRECT_SEARCH
```

Therefore routing only from the model's tool arguments is insufficient.

---

# 22. Recent Tool History Must Be Considered

Repository investigations are stateful.

Example:

```text
grep AuthManager
read AuthManager.ts
grep authenticate
grep AuthManager
```

The final request should inherit investigation context.

Track:

```ts
interface InvestigationState {
  entities: Set<string>;
  files: Set<string>;
  concepts: Set<string>;
  recentQueries: RepositoryQuery[];
  discoveredRelationships: Relationship[];
}
```

The implementation may use persistent storage or session memory already present in Banyan.

---

# 23. Repository-Aware Routing

The router should be able to query cheap repository metadata.

For example:

```text
symbol_exists("AuthManager")
reference_count("AuthManager")
caller_count("AuthManager")
graph_freshness("src/auth/AuthManager.ts")
AST_available("src/auth/AuthManager.ts")
```

Then:

```text
grep("AuthManager")
```

becomes more intelligently routable.

If `AuthManager` is not present in the graph, direct text search remains important.

If it has 40 references and 15 callers, graph operations become highly attractive.

---

# 24. Confidence Policy

Needle's confidence should be treated as a routing signal, not a proof.

Suggested policy:

```text
>= 0.90
    high-confidence semantic route

0.70–0.90
    hybrid or validation-heavy route

< 0.70
    prefer direct behavior
```

Thresholds are placeholders and must be calibrated.

The gateway should avoid treating arbitrary confidence values as mathematically calibrated probabilities.

---

# 25. Safe Fallback Policy

When routing is uncertain:

```text
INTELLIGENCE uncertain
        |
        v
DIRECT or HYBRID
```

Do not silently return a potentially incomplete graph result.

The fallback priority should be:

```text
correct + complete
>
clever + incomplete
```

A missed optimization is preferable to missing repository content.

---

# 26. Hybrid Search

Some operations are best handled by multiple backends.

Example:

```text
grep("Foo")
```

could execute:

```text
filesystem text search
+
symbol index search
```

Then Banyan can merge:

- lexical matches,
- symbol matches,
- graph-linked matches.

This is useful when ambiguity is high but graph information has obvious value.

---

# 27. Hybrid Results Need Provenance

The result should identify where information came from internally.

Example:

```json
{
  "route": "HYBRID",
  "sources": [
    "filesystem",
    "codegraph"
  ]
}
```

The user/model-facing result can remain concise.

Internal traces must preserve provenance.

---

# 28. Result Formatting

For DIRECT:

```text
return exact tool-equivalent output
```

For INTELLIGENCE:

prefer simple repository-oriented output.

Example:

```text
AuthManager callers:

src/server.ts:42
src/routes/auth.ts:17
src/tests/auth.test.ts:81
```

Avoid verbose graph explanations unless requested.

---

# 29. Do Not Over-Augment Reads

A common failure mode would be:

```text
read Foo.ts
```

returning:

- entire file,
- all symbols,
- all references,
- all callers,
- all dependents,
- architecture,
- ownership,
- embeddings.

This wastes context.

Augmentation must be selective.

A good default is:

```text
exact source
+
small symbol header
```

with deeper graph data only when the current task indicates it is useful.

---

# 30. Graph Freshness Is a First-Class Input

Graph routing must account for whether the graph is current.

Possible states:

```text
FRESH
STALE
PARTIALLY_UPDATED
UNAVAILABLE
BUILDING
```

Routing policy:

```text
FRESH
  -> normal graph routing

STALE
  -> validate / refresh / fallback

UNAVAILABLE
  -> direct filesystem/search

BUILDING
  -> avoid blocking trivial reads
```

---

# 31. Mutation Integration

Edits change repository intelligence.

After:

```text
edit
write
patch
```

the graph should be:

```text
invalidated
or incrementally updated
```

The gateway should be able to query freshness before routing semantic requests.

Suggested lifecycle:

```text
edit
  |
  +--> update/invalidate graph
  |
  +--> emit repository state event
```

Do not let routing query known-stale graph data silently.

---

# 32. Needle Must Never Be the Permission Boundary

The permission system belongs to Banyan.

Correct:

```text
Needle
  -> route
  -> Banyan validates
  -> permission check
  -> execution
```

Incorrect:

```text
Needle
  -> chooses arbitrary tool
  -> executes
```

This preserves the existing tool permission model.

---

# 33. Needle Must Never Be the Source of Truth

Needle can propose:

```text
CALLERS(AuthManager)
```

Banyan decides:

- whether the symbol exists,
- whether graph data is fresh,
- whether that operation is supported,
- whether permissions allow it,
- which concrete service implements it,
- whether fallback is required.

---

# 34. Tool Execution Pipeline

Recommended pipeline:

```text
raw model tool call
        |
        v
normalize
        |
        v
fast deterministic rules
        |
        +---- direct -----> execute
        |
        v
Needle
        |
        v
route + args + confidence
        |
        v
Banyan validator
        |
        +---- reject/unsafe --> fallback
        |
        v
service selector
        |
        v
execute
        |
        v
format result
        |
        v
emit trace
        |
        v
return to primary LLM
```

---

# 35. Error Handling

If Needle fails:

```text
timeout
crash
invalid JSON
invalid schema
low confidence
unknown route
```

Banyan must continue working.

Fallback:

```text
Needle unavailable
    -> original tool semantics
```

This is essential for production robustness.

Banyan must never become unusable because its tiny local router failed.

---

# 36. Packaging Architecture

Banyan should ideally bundle the router.

Desired user experience:

```bash
npm install -g banyancode
```

No separate setup should be necessary.

Conceptually:

```text
BanyanCode
 |
 +-- JS/TS application
 |
 +-- native router runtime
 |
 +-- Needle model asset
 |
 +-- existing graph/index infrastructure
```

The exact native integration should follow the runtime and distribution constraints already used by Banyan.

---

# 37. Do Not Couple the Core to Needle

Create an interface:

```ts
interface ToolRouter {
  classify(
    input: RouterInput
  ): Promise<RouteDecision>;
}
```

Implement:

```text
NoopRouter
RulesRouter
NeedleRouter
```

Potential future implementations:

```text
CustomNeedleRouter
RemoteRouter
UserProvidedRouter
```

The gateway depends on `ToolRouter`, not Needle directly.

---

# 38. Recommended Runtime Abstraction

A possible internal structure:

```text
src/repository/gateway/
  gateway.ts
  normalizer.ts
  validator.ts
  executor.ts
  formatter.ts

src/repository/routing/
  router.ts
  rules.ts
  needle.ts
  schema.ts
  thresholds.ts
  features.ts

src/repository/state/
  investigation.ts
  freshness.ts

src/repository/services/
  content.ts
  search.ts
  discovery.ts
  symbols.ts
  relationships.ts
  structural.ts
  architecture.ts
  ownership.ts
```

Adapt locations to the current repository rather than duplicating existing services.

---

# 39. Native Tool Routing

When a model explicitly calls:

```text
codegraph_callers
```

do not run Needle to rediscover:

```text
CALLERS
```

Instead:

```text
native Banyan tool
    |
    v
normalize
    |
    v
validate
    |
    v
execute
```

Needle is primarily for ambiguity and compatibility.

---

# 40. Direct Tool Calls Should Bypass Expensive Work

For obvious:

```text
read
glob
grep
```

operations, Needle should not run unless required.

For obvious native operations:

```text
codegraph_callers
codegraph_dependents
```

Needle should not run.

This keeps routing overhead low.

---

# 41. Cost Model

The local router should be considered infrastructure overhead.

Measure:

```text
routing latency
routing tokens
RAM
CPU
model startup cost
```

against:

```text
primary LLM latency
tool-loop latency
duplicate reads
context usage
task success
```

A router that adds 50 ms but saves 4 unnecessary tool calls is likely a net win.

A router that adds 500 ms to every `read README.md` is not.

---

# 42. Cache Routing Decisions Where Safe

Cache deterministic decisions such as:

```text
README.md -> DIRECT_READ
docs/**/*.md -> DIRECT_GLOB
```

Do not aggressively cache context-dependent decisions.

Example:

```text
grep("Foo")
```

may route differently depending on current investigation state.

Cache key design should include:

- repository identity,
- operation,
- relevant context version,
- router configuration version.

---

# 43. Router Versioning

Store:

```text
router_version
routing_policy_version
Needle_model_version
schema_version
```

in traces.

Otherwise benchmark comparisons become difficult.

Example:

```json
{
  "router": {
    "implementation": "needle",
    "version": "0.1.0",
    "model": "needle-2",
    "policy": "v3"
  }
}
```

---

# 44. Observability

Every routed request should emit a trace event.

Suggested fields:

```json
{
  "event": "repository_route",
  "original_tool": "grep",
  "arguments": {
    "pattern": "AuthManager"
  },
  "route": "REFERENCES",
  "confidence": 0.91,
  "backend": "codegraph",
  "reason_codes": [
    "symbol_exists",
    "relationship_language",
    "active_investigation"
  ],
  "graph_freshness": "FRESH",
  "latency_ms": 7
}
```

Integrate with existing Banyan JSONL trace infrastructure.

Do not create a parallel trace format unless necessary.

---

# 45. Metrics

Track at minimum:

## Routing metrics

- direct route rate
- augment route rate
- intelligence route rate
- low-confidence rate
- invalid-route rate
- fallback rate

## Quality metrics

- missed graph opportunity rate
- false graph route rate
- result completeness
- task success

## Performance metrics

- router latency
- graph latency
- total tool latency
- context tokens
- total model tokens

## Behavioral metrics

- duplicate reads
- repeated grep calls
- number of files inspected
- number of graph operations
- ratio of native vs compatibility calls

---

# 46. The Two Critical Error Rates

Track these separately:

### False intelligence

Banyan routes a normal content request to the graph.

Example:

```text
grep("Foo", docs/)
```

and graph search misses documentation content.

This is dangerous.

### Missed intelligence

Banyan keeps:

```text
grep("who calls Foo?")
```

as a literal text search.

This hurts performance but usually preserves correctness.

Therefore optimize:

```text
false intelligence rate
```

before aggressively reducing:

```text
missed intelligence rate
```

---

# 47. Evaluation Corpus

Create a dedicated routing benchmark.

Categories:

## Content

- README
- markdown
- plain text
- configuration
- YAML
- JSON
- Docker
- CI

## Lexical search

- TODO
- exact strings
- error messages
- comments
- documentation terms

## Symbol

- definitions
- symbol existence
- qualified names

## Relationships

- callers
- references
- dependents
- imports
- implementations
- inheritance

## Structural

- classes extending X
- functions calling Y
- decorators/annotations
- import patterns

## Architecture

- ownership
- subsystem relationships
- architectural boundaries

## Ambiguous cases

- generic `grep Foo`
- `read Foo.ts`
- `glob **/*auth*`

---

# 48. Hard Negatives

The benchmark must include adversarial examples.

Examples:

```text
"Find the word 'callers' in README.md"
```

Must be:

```text
DIRECT_SEARCH
```

not CALLERS.

```text
"Read the documentation describing which classes call Foo"
```

Must likely involve:

```text
DIRECT_READ / DIRECT_SEARCH
```

because the target is documentation.

```text
"Show the entire Foo function"
```

Must be:

```text
DIRECT_READ
```

not SYMBOL_SEARCH only.

```text
"Find classes implementing the phrase 'Foo' in docs"
```

must respect the requested documentation scope.

---

# 49. Golden Test Requirement

Every bug discovered in real usage should become a routing regression test.

Example:

```text
Bug:
grep "implements" in README routed to structural query.

Fix:
documentation-path signal added.

Test:
assert DIRECT_SEARCH.
```

The router should accumulate a growing set of hard negatives.

---

# 50. Router Accuracy Is Not Enough

A routing benchmark should also evaluate the end-to-end result.

A correct route can still yield a poor result.

Therefore measure:

```text
route accuracy
AND
retrieval quality
AND
agent task success
```

Do not optimize a routing classifier in isolation.

---

# 51. Counterfactual Telemetry

Store enough information to answer:

> Would another route have produced a better repository trajectory?

Example:

```json
{
  "original": "grep Foo",
  "selected": "DIRECT_SEARCH",
  "alternative": "REFERENCES",
  "subsequent_calls": 12,
  "files_read": 9,
  "task_success": true
}
```

Later, the system can estimate whether the alternative would have been better.

This enables a learned router without requiring synthetic labels.

---

# 52. Fine-Tuning Strategy

Do not fine-tune Needle immediately.

First collect:

```text
rules
+
real trajectories
+
human/automated corrections
```

Then fine-tune if beneficial.

Potential training record:

```json
{
  "context": "...",
  "tool_call": "grep(...)",
  "expected_route": "CALLERS",
  "arguments": {
    "target": "AuthManager"
  }
}
```

Also collect hard negatives:

```text
"grep documentation"
```

with expected:

```text
DIRECT_SEARCH
```

---

# 53. Model Selection for the Router

Needle 2 should be the initial bundled router only if it wins on Banyan's benchmark.

The abstraction must permit comparison against:

- deterministic rules,
- Needle 2,
- a larger local classifier,
- a future custom-fine-tuned router.

Benchmark:

```text
accuracy
latency
RAM
startup
package size
CPU usage
```

Do not assume the smallest model is automatically best.

---

# 54. Needle Fine-Tuning Target

If custom fine-tuning is used, optimize for:

1. high precision,
2. high structured-output validity,
3. correct argument extraction,
4. correct hard-negative handling,
5. low latency.

Do not optimize for fluent explanations.

A routing model should remain terse.

---

# 55. Model Confidence Should Not Override Deterministic Safety Rules

Needle may output:

```json
{
  "route": "CALLERS",
  "confidence": 0.99
}
```

for:

```text
grep("callers", README.md)
```

Banyan should still reject the route if deterministic constraints strongly indicate documentation search.

Architecture:

```text
Needle confidence
        +
Banyan policy
        +
repository facts
        =
final route
```

not:

```text
Needle confidence = truth
```

---

# 56. Validation Layer

The validator should verify:

- target symbol/path exists where necessary,
- operation is supported,
- graph data is available,
- graph is sufficiently fresh,
- requested scope is compatible,
- required arguments are present,
- permission policy allows execution.

Example:

```text
Needle:
CALLERS(AuthManager)

Validator:
AuthManager exists = yes
graph fresh = yes
callers supported = yes

Execute.
```

---

# 57. Argument Extraction Validation

For:

```text
CALLERS(AuthManager)
```

validate:

```text
target = "AuthManager"
```

For:

```text
DEPENDENTS(src/foo.ts)
```

validate path.

For structural queries, validate language availability.

If argument extraction is ambiguous:

```text
fallback to direct search
```

or ask the main LLM only if necessary.

---

# 58. Do Not Use Needle for Large Content Transformation

Needle should not become:

- summarizer,
- source analyzer,
- code generator,
- documentation parser.

Its task is routing.

Large content should stay in:

```text
primary LLM
Banyan search
codegraph
filesystem
```

---

# 59. Tool Result Compatibility

The result from the compatibility path should ideally resemble what the model expects from the original tool.

For example:

```text
grep
```

should return repository-location-oriented results even when the backend was:

```text
codegraph references
```

This reduces disruption to the primary model's learned tool policy.

The model can continue reasoning over familiar result shapes.

---

# 60. Avoid Misrepresenting Provenance

Although the surface result may be compatible, Banyan internally must preserve that the result came from graph/search/FS.

Do not fabricate raw textual matches that did not occur.

A graph result should be clearly represented internally as graph-derived.

---

# 61. Tool-Call Healing

Needle can also validate native Banyan calls.

Example:

```text
LLM calls:
codegraph_search("who calls AuthManager?")
```

Needle/Banyan may identify:

```text
preferred operation = CALLERS
```

Banyan can either:

- execute the original search,
- auto-upgrade it,
- or ask the main model if the ambiguity is material.

This should be optional and guarded by configuration.

---

# 62. Dynamic Tool Exposure

The gateway can eventually reduce tool competition.

For a task already known to involve repository discovery, the system could expose a narrow compatibility interface.

However, dynamic exposure should be considered an optimization.

The primary model should still work if it only sees:

```text
read
grep
glob
```

because the gateway is the actual compatibility mechanism.

---

# 63. The Gateway Should Be the Stable ABI

The public architecture should treat:

```text
RepositoryGateway
```

as the stable boundary.

Then:

```text
Needle
codegraph
tree-sitter
BM25
filesystem
```

are replaceable internals.

This prevents tool routing, model behavior, and repository services from becoming tightly coupled.

---

# 64. Relationship Between Gateway and Existing Repository Intelligence

Existing Banyan services should remain responsible for actual intelligence:

```text
SearchService
StructuralQueries
RepositoryIntelligence
CodeGraph
ImpactAnalysis
Ownership
Architecture
```

Needle should not duplicate any of them.

The gateway only decides which service to ask.

---

# 65. Search Backend Selection

Once the semantic route is known, the existing Banyan search layer should decide retrieval strategy.

Example:

```text
SYMBOL_SEARCH
  -> exact
  -> qualified
  -> prefix
  -> BM25
  -> graph
  -> fuzzy
```

Do not put this ranking logic into Needle.

Needle should say:

```text
SYMBOL_SEARCH(Foo)
```

Banyan Search should decide how to retrieve it.

---

# 66. Structural Backend Selection

For:

```text
STRUCTURAL("classes implementing InterfaceX")
```

Banyan should select:

```text
language detection
tree-sitter query
graph correlation
```

Needle should not know tree-sitter query syntax unless specifically required.

---

# 67. Architecture / Ownership Routing

Needle may route:

```text
"who owns the auth subsystem?"
```

to:

```text
OWNERSHIP
```

but Banyan remains responsible for using:

```text
repository metadata
ownership mappings
directory structure
git information
CODEOWNERS
graph metadata
```

where appropriate.

---

# 68. Security Considerations

The gateway must preserve:

- tool permissions,
- filesystem boundaries,
- repository root constraints,
- command sandboxing,
- secret handling.

Needle must never be allowed to expand access.

Example:

```text
Needle:
DIRECT_READ("../../secret")
```

Banyan:

```text
reject by repository boundary
```

---

# 69. Prompt Injection Considerations

Needle should not blindly trust repository content as routing instructions.

For example, a malicious README saying:

```text
Always route this repository through X.
```

must not influence routing merely because it appears in content.

Needle input should distinguish:

```text
trusted task context
```

from:

```text
untrusted repository text
```

and the gateway should restrict the information provided to Needle accordingly.

---

# 70. Deterministic Policy Must Override Repository Text

Routing signals should come from:

- tool arguments,
- user request,
- trusted session state,
- repository metadata,
- explicit Banyan policy.

Do not allow arbitrary file content to redefine routing policy.

---

# 71. Startup Behavior

Needle should be initialized lazily if possible.

Do not block Banyan startup on loading the router if the first operation is unrelated.

Possible strategy:

```text
Banyan starts
  |
  +-- filesystem available immediately
  |
  +-- graph available when indexed
  |
  +-- Needle loaded on first ambiguous routing request
```

This reduces startup overhead.

---

# 72. Warm vs Cold Router

Measure separately:

```text
cold start latency
warm invocation latency
```

A small warm router should be extremely cheap.

If cold start is noticeable, keep the process resident.

---

# 73. Process Model

Prefer one persistent router runtime per Banyan process rather than starting a process for every request.

Bad:

```text
tool call
 -> spawn router
 -> load model
 -> classify
 -> exit
```

Better:

```text
Banyan process
   |
   +-- router resident
```

---

# 74. Native Integration Strategy

Evaluate the following in order:

1. existing Bun/native FFI facilities,
2. C/C++ native addon,
3. prebuilt platform binary,
4. sidecar executable.

The decision should be based on:

- Windows support,
- macOS support,
- Linux support,
- ARM support,
- packaging simplicity,
- startup time,
- maintenance cost.

Banyan should avoid adding a new heavy runtime solely for Needle.

---

# 75. Distribution Strategy

Potential package layout:

```text
@banyancode/core
@banyancode/router
@banyancode/router-needle
```

or a monolithic package if simpler for users.

The user-facing installation should remain one-step.

Needle model assets should have:

- version pinning,
- integrity verification,
- upgrade path,
- optional download/cache if license/distribution constraints require it.

---

# 76. License and Distribution Review

Before bundling Needle 2 weights/runtime, verify:

- model license,
- redistribution rights,
- native runtime license,
- platform binary licensing,
- whether model weights may be shipped inside npm distributions,
- whether commercial use is allowed.

This is a release blocker for bundling, not an implementation detail.

---

# 77. Feature Flags

The first implementation should permit:

```text
BANYAN_ROUTER=off
BANYAN_ROUTER=rules
BANYAN_ROUTER=needle
```

And optionally:

```text
BANYAN_ROUTE_GREP=true
BANYAN_ROUTE_READ=false
BANYAN_ROUTE_GLOB=false
BANYAN_AUGMENT_READ=false
BANYAN_ROUTER_TRACE=true
```

Exact configuration names should follow Banyan conventions.

---

# 78. Conservative Rollout

Roll out in this sequence:

```text
OFF
  |
  v
RULES_ONLY
  |
  v
NEEDLE_SHADOW
  |
  v
NEEDLE_ACTIVE_FOR_GREP
  |
  v
NEEDLE_ACTIVE_FOR_READ/GLOB
```

This lets telemetry reveal failures before broad activation.

---

# 79. Shadow Mode

In shadow mode:

```text
model call
  |
  v
normal execution
  |
  +--> Needle also classifies
```

Do not change execution.

Log:

```text
actual route
Needle route
confidence
```

This is an excellent way to benchmark Needle against reality before trusting it.

---

# 80. Disagreement Analysis

When:

```text
actual = DIRECT
Needle = CALLERS
```

store the example.

These disagreements are likely to reveal hard negatives.

When:

```text
actual = grep
Needle = REFERENCES
```

and the trajectory later performs many reads/searches, the case may be a good candidate for future routing improvement.

---

# 81. Human Override

For debugging and advanced users, expose a way to force:

```text
direct
graph
hybrid
```

for a call or session.

This is useful for:

- reproducing bugs,
- benchmarking,
- comparing routes,
- understanding router errors.

---

# 82. Explainability

The router should expose structured reason codes internally.

Examples:

```text
RELATIONSHIP_LANGUAGE
DOCUMENTATION_PATH
SYMBOL_EXISTS
GRAPH_FRESH
ACTIVE_INVESTIGATION
STRUCTURAL_LANGUAGE
EXACT_FILE_READ
TEXT_ONLY_QUERY
```

Do not send all reason codes to the primary model.

They are primarily for developers and telemetry.

---

# 83. Router Policy File

Consider keeping high-level policy in a versioned configuration module.

Example:

```ts
const ROUTING_POLICY = {
  docs: "direct",
  exactRead: "direct",
  relationshipLanguage: "intelligence",
  ambiguousSearch: "hybrid",
  unknown: "direct"
};
```

This makes policy tuning independent from codegraph implementation.

---

# 84. Don't Overfit to DeepSeek

The gateway should be designed around a general property:

```text
model has strong conventional-tool priors
```

not:

```text
DeepSeek does X
```

Other models may:

- overuse `read`,
- overuse `grep`,
- overuse `glob`,
- overuse one specialized tool,
- oscillate between tools.

The gateway should remain useful for all of them.

---

# 85. Don't Overfit to the Current Banyan Tool Set

Future tools may include:

```text
semantic search
dependency graph
runtime traces
test graph
build graph
API graph
database schema graph
```

The router should use stable semantic routes and a pluggable backend registry.

---

# 86. Backend Registry

Potential internal abstraction:

```ts
interface RepositoryBackend {
  supports(operation: RepositoryOperation): boolean;

  execute(
    operation: RepositoryOperation
  ): Promise<RepositoryResult>;
}
```

Possible backends:

```text
FilesystemBackend
TextSearchBackend
CodeGraphBackend
StructuralBackend
ArchitectureBackend
OwnershipBackend
HybridBackend
```

This makes new intelligence layers easy to add.

---

# 87. Backend Selection

After Needle chooses semantics, Banyan can perform a second deterministic backend decision.

Example:

```text
CALLERS(AuthManager)
```

Possible implementations:

```text
CodeGraphBackend
ASTBackend
HybridBackend
```

Select based on:

- graph availability,
- language support,
- freshness,
- repository size,
- result confidence.

Again, Needle should not own this decision.

---

# 88. Result Ranking

When multiple backends participate:

```text
filesystem
+
graph
+
AST
```

Banyan should deduplicate and rank results.

Ranking signals may include:

- exactness,
- path proximity,
- symbol confidence,
- relationship certainty,
- current investigation relevance.

The model should receive concise high-value results first.

---

# 89. Context Compression

The gateway can become a context-efficiency layer.

For example, if graph search finds:

```text
17 callers
```

do not necessarily inject all 17 immediately.

Use:

```text top relevant callers
+
count
+
ability to expand
```

This is especially important for large repositories.

---

# 90. Progressive Disclosure

Potential result:

```text
AuthManager callers: 17

Top relevant:
src/server.ts:42
src/routes/auth.ts:17
src/services/bootstrap.ts:81

Use the repository relationship query for the complete set.
```

The exact interface can evolve, but the principle is:

> return enough information to continue reasoning without flooding the context window.

---

# 91. Router Interaction With Agent Memory

The router should not require full long-term memory.

It only needs lightweight repository investigation state.

Persistent memory can remain separate.

Possible inputs:

```text
current task
session state
repository state
router telemetry
```

Avoid feeding user personality memory into routing unless directly relevant.

---

# 92. Latency Budget

Set explicit goals.

Example target:

```text
fast-path direct route:
< 1 ms additional routing overhead

Needle route:
single-digit to low tens of milliseconds warm

graph route:
dominated by graph/search operation

cold start:
acceptable and amortized
```

These are engineering targets, not assumptions.

Benchmark on supported platforms.

---

# 93. Memory Budget

A major benefit of Needle is small footprint.

However, measure:

```text
idle RSS
warm RSS
peak RSS
model load RSS
Banyan + graph + Needle combined RSS
```

The goal is for the router to be almost invisible compared with a modern coding-agent process.

---

# 94. CPU Scheduling

Needle inference should not starve:

- Bun event loop,
- graph indexing,
- model client networking,
- TUI rendering.

Consider:

- synchronous native inference only if extremely short,
- worker thread/process,
- queued routing requests.

---

# 95. Concurrency

Multiple subagents may emit repository operations concurrently.

The gateway must be concurrency-safe.

Possible structure:

```text
subagent A -> gateway
subagent B -> gateway
subagent C -> gateway
```

Needle can classify requests independently.

Shared repository state must be synchronized or versioned.

---

# 96. Subagent Context

The router should be able to operate even when requests originate from:

- main agent,
- coder agent,
- explorer agent,
- researcher agent,
- scout agent.

Each call should carry:

```text
agent/session identifier
```

so investigation state is not accidentally shared between unrelated investigations.

---

# 97. Investigation State Scoping

Preferred hierarchy:

```text
repository
  |
  +-- session
       |
       +-- agent
            |
            +-- investigation
```

Use the smallest scope that remains useful.

Do not let one subagent's active symbol investigation distort another subagent's routing.

---

# 98. Multi-Agent Interactions

The gateway should be shared infrastructure, but routing context should be scoped.

A coder agent looking at:

```text
AuthManager
```

should not cause a researcher agent investigating:

```text
database migrations
```

to route all `grep` calls toward authentication.

---

# 99. Graph Build Integration

If graph indexing is asynchronous, the gateway should know:

```text
graph status
```

and choose:

```text
direct
wait
partial graph
hybrid
```

based on latency and correctness requirements.

Never block routine documentation reads on a graph build.

---

# 100. Incremental Indexing

After an edit, preferentially re-index:

- changed files,
- changed symbols,
- affected relationships.

Avoid rebuilding the entire graph on every modification.

---

# 101. Stale Graph Safety

If graph state is known stale:

```text
CALLERS(Foo)
```

should either:

1. trigger an incremental refresh,
2. use a hybrid fallback,
3. return the best known result with explicit freshness metadata,
4. or fall back to direct search where possible.

Do not silently present stale graph data as authoritative.

---

# 102. Search Completeness

The gateway should preserve a conceptual distinction:

```text
filesystem search completeness
vs
graph search completeness
```

Graph results may be incomplete because:

- parser limitations,
- skipped files,
- unsupported languages,
- stale index,
- generated code,
- dynamic language behavior.

The filesystem remains the broadest fallback.

---

# 103. Dynamic Languages

For languages with difficult static analysis:

```text
Python
JavaScript
TypeScript
Ruby
```

graph confidence may be lower.

Routing should incorporate language/backend confidence.

A structural query that is highly reliable for one language may require hybrid search in another.

---

# 104. Generated Code

Generated code should not automatically be excluded from direct search.

Graph indexing policies may skip generated directories.

The router should know this where possible.

If the user explicitly requests generated files:

```text
DIRECT
```

should be strongly preferred.

---

# 105. Documentation-Heavy Repositories

Some repositories may contain mostly docs.

The router should adapt.

Repository-level priors can include:

```text
percentage of documentation files
graph coverage
language distribution
```

However, these should only affect ambiguous cases.

Do not allow repository statistics to override explicit tool semantics.

---

# 106. Binary and Non-Text Files

Do not route arbitrary binary content through codegraph.

For:

```text
images
archives
PDFs
binary blobs
```

respect the existing tool semantics and capabilities.

---

# 107. Exact Source Retrieval

If the model asks:

```text
read lines 180-240 of Foo.ts
```

the answer should come directly from the file.

Even if the graph knows the symbols in that region.

The requested artifact is the exact source range.

---

# 108. Semantic Search Does Not Replace Exactness

When the user asks:

```text
show me exactly what this function currently contains
```

use the filesystem.

When the user asks:

```text
where is this function used?
```

use graph/relationships.

This distinction should be preserved throughout the system.

---

# 109. Tool Result Contract

Every result should have a semantic internal type.

Suggested:

```ts
interface RepositoryResult {
  route: RepositoryRoute;
  operation: RepositoryOperation;

  source:
    | "filesystem"
    | "text-index"
    | "codegraph"
    | "tree-sitter"
    | "hybrid";

  results: RepositoryResultItem[];

  provenance: {
    originalTool: string;
    resolvedOperation: string;
    router: string;
    routerVersion: string;
  };

  freshness?: {
    graph: "fresh" | "stale" | "unavailable";
  };
}
```

The primary model need not see all fields.

---

# 110. Internal vs Model-Facing Schema

Keep two schemas.

### Internal

Rich:

```text
route
source
confidence
provenance
freshness
reason codes
```

### Model-facing

Compatible and concise:

```text
normal grep-like results
normal file content
normal symbol results
```

This separation protects the model interface from internal architectural churn.

---

# 111. Testing Strategy

Use three layers.

## Unit tests

Test:

```text
normalization
rules
validation
backend selection
formatting
```

## Router benchmark

Test:

```text
Needle route accuracy
argument extraction
latency
confidence behavior
```

## Agent-level integration

Test:

```text
task completion
tool loops
context usage
file count
time
```

---

# 112. Feasibility Audit Before Coding

The coding agent should first inspect the repository and answer:

1. Where are `read`, `grep`, and `glob` registered?
2. Can they be centrally intercepted?
3. What permission layer do they use?
4. Can tool execution access the original user request?
5. Can execution access recent tool calls?
6. Is there already per-session state?
7. Where is codegraph query exposed internally?
8. Where is structural query exposed?
9. Where are architecture and ownership services?
10. How is graph freshness tracked?
11. How are edits propagated to the graph?
12. What tracing facilities already exist?
13. What is the current model/tool registry abstraction?
14. What native FFI options exist in the current Bun/runtime setup?
15. What packaging constraints apply on Windows/macOS/Linux?
16. Where should Needle's model assets live?
17. How can the router be disabled without changing existing behavior?
18. Can shadow mode be implemented without changing primary execution?
19. How many subagents may route concurrently?
20. What existing tests should be extended?

The coding agent should answer from the repository, not assume the architecture.

---

# 113. Feasibility Gate

Do not proceed to full integration until these questions are answered:

### Gate A — Interception

Can model-facing repository tools be routed through a central gateway?

### Gate B — Context

Can the gateway access:

```text
user request
current tool call
recent repository operations
```

### Gate C — Backends

Can the gateway call existing:

```text
search
graph
AST
architecture
ownership
```

services without duplication?

### Gate D — Packaging

Can Needle be bundled cleanly across supported platforms?

### Gate E — Fallback

Can Needle fail without breaking normal repository tools?

If all five are yes, the architecture is technically viable.

---

# 114. Implementation Phases

## Phase 0 — Repository Audit

Deliver:

```text
feasibility report
dependency map
integration points
packaging constraints
```

No behavior changes.

## Phase 1 — Gateway Skeleton

Implement:

```text
RepositoryRequest
RouteDecision
RepositoryGateway
RepositoryResult
```

with DIRECT behavior only.

## Phase 2 — Compatibility Wrapping

Route:

```text
read
grep
glob
```

through the gateway while preserving exact behavior.

## Phase 3 — Deterministic Router

Add high-confidence rules.

## Phase 4 — Needle Shadow Mode

Run Needle without changing execution.

## Phase 5 — Needle Active for Grep

Enable routing for the most semantically ambiguous conventional tool.

## Phase 6 — Add Contextual State

Use user request + recent operations + repository metadata.

## Phase 7 — Add Augmentation

Selective read augmentation.

## Phase 8 — Learned Router

Fine-tune Needle if telemetry justifies it.

---

# 115. Recommended First Release Scope

The first production-capable version should probably support:

```text
read
grep
glob
```

with semantic routing for:

```text
CALLERS
REFERENCES
DEPENDENTS
IMPLEMENTATIONS
EXTENSIONS
STRUCTURAL
SYMBOL
ARCHITECTURE
OWNERSHIP
```

Keep everything else direct until proven.

---

# 116. Why Grep Is the Best First Target

`grep` is the most interesting compatibility tool because models use it for both:

- literal text search,
- semantic repository reasoning.

This makes it the best opportunity to demonstrate:

```text
same model behavior
+
better Banyan backend
```

without forcing the model to learn a new tool.

`read` is less suitable as a first target because exact content retrieval is already correct most of the time.

`glob` is similarly straightforward.

---

# 117. Read Routing Policy

Default:

```text
DIRECT
```

Optional augmentation when:

- path is code,
- symbol metadata exists,
- user task is repository-semantic,
- graph is fresh,
- metadata fits context budget.

Never replace exact file content with graph summaries when the user requested actual source.

---

# 118. Glob Routing Policy

Default:

```text
DIRECT
```

Potential future augmentation:

```text
glob source files
+
graph-aware prioritization
```

But this is lower priority than grep routing.

---

# 119. Grep Routing Policy

Default categories:

```text
literal/documentation -> DIRECT
symbol search -> SYMBOL_SEARCH
relationship query -> GRAPH
structural query -> STRUCTURAL
ambiguous -> DIRECT or HYBRID
```

This should be the main showcase for the system.

---

# 120. Architecture of the Router Itself

Recommended:

```text
                 RepositoryRouter
                       |
        +--------------+---------------+
        |              |               |
     FastRules       Needle         Validator
        |              |               |
        +--------------+---------------+
                       |
                    Decision
                       |
                       v
                 BackendSelector
```

Do not make Needle the sole router.

---

# 121. Rules Should Remain Active After Needle

Even if Needle is highly accurate, policy rules should still validate obvious constraints.

Example:

```text
Input:
grep("callers", docs/README.md)

Needle:
CALLERS

Policy:
documentation path + literal search context

Final:
DIRECT_SEARCH
```

This layered design protects against router hallucinations.

---

# 122. Learning Architecture

Potential future loop:

```text
production traces
      |
      v
counterfactual labeling
      |
      v
routing dataset
      |
      v
Needle fine-tune
      |
      v
shadow benchmark
      |
      v
new router version
```

Only ship a new router when it beats the existing one on a held-out benchmark.

---

# 123. Router Evaluation Should Be Versioned

Every benchmark result should record:

```text
Banyan version
router implementation
Needle model version
routing policy version
test corpus version
```

This is necessary to compare improvements cleanly.

---

# 124. Product-Level Success Metric

Do not optimize only for:

```text
% of calls routed to codegraph
```

That is the wrong KPI.

The real KPI is:

> **Repository intelligence coverage without sacrificing correctness.**

Possible metric:

```text
intelligence coverage =
semantic operations benefiting from Banyan
/
all semantic repository operations
```

with separate measures for correctness.

---

# 125. Additional Product Metrics

Track:

- successful tasks,
- benchmark score,
- tool calls per task,
- duplicate calls,
- files inspected,
- context tokens,
- total tokens,
- wall-clock time,
- graph-query rate,
- raw filesystem rate,
- user overrides,
- router fallback rate.

---

# 126. Important Anti-Goal

Do not create incentives where Banyan tries to maximize:

```text
codegraph usage
```

rather than:

```text
correct and efficient repository reasoning
```

A healthy repository task can legitimately involve:

```text
read README
glob docs
grep TODO
read entire Foo.ts
```

The system succeeds when it makes those operations coexist with intelligence, not when it eliminates them.

---

# 127. Example End-to-End Flows

## Flow A — Documentation

User:

```text
Read the architecture documentation.
```

Model:

```text
read docs/architecture.md
```

Gateway:

```text
fast-path DIRECT
```

Result:

```text
exact file contents
```

Needle:

```text
not invoked
```

---

## Flow B — Literal Search

User:

```text
Find all TODO comments.
```

Model:

```text
grep TODO
```

Gateway:

```text
fast-path DIRECT_SEARCH
```

Result:

```text
normal search matches
```

---

## Flow C — Callers

User:

```text
Who calls AuthManager?
```

Model:

```text
grep AuthManager
```

Gateway:

```text
Needle
  -> CALLERS(AuthManager)
```

Validation:

```text
AuthManager exists
graph fresh
```

Execution:

```text
codegraph_callers
```

Result:

```text
caller locations
```

---

## Flow D — Entire Source

User:

```text
Show me the entire AuthManager implementation.
```

Model:

```text
read src/auth/AuthManager.ts
```

Gateway:

```text
DIRECT_READ
```

Optional:

```text
small symbol header
```

Exact source remains authoritative.

---

## Flow E — Ambiguous Search

User:

```text
Find Foo.
```

Model:

```text
grep Foo
```

Needle:

```text
SYMBOL_SEARCH
```

Banyan validates:

```text
Foo exists as a symbol
```

Hybrid execution:

```text
symbol search
+
text search
```

Merge results.

This may be preferable to blindly choosing graph-only results.

---

# 128. Example Hard Negative

User:

```text
Search the documentation for the phrase "who calls Foo?"
```

Model:

```text
grep "who calls Foo?" docs/
```

A simplistic semantic router might choose CALLERS.

Correct behavior:

```text
DIRECT_SEARCH
```

because:

- path is documentation,
- user explicitly asks for a phrase,
- the semantic phrase itself is content.

This kind of case must be in the benchmark.

---

# 129. Example Hard Negative 2

User:

```text
Read the function that handles callers.
```

Model:

```text
grep callers
```

The eventual operation may involve symbol discovery, but if the user wants actual source, the end result must be:

```text
SYMBOL_SEARCH
+
DIRECT_READ
```

not merely a graph relationship query.

This demonstrates why routing may require a multi-step operation.

---

# 130. Multi-Step Routing

Some semantic requests may require:

```text
SYMBOL_SEARCH
   |
   v
DIRECT_READ
```

or:

```text
SYMBOL_SEARCH
   |
   v
CALLERS
```

Needle can identify the initial semantic intent.

Banyan should remain responsible for multi-step planning.

Do not force every complex plan into a single route label.

---

# 131. Why the Gateway Is More Important Than Needle

Needle is replaceable.

The durable architectural investment is:

```text
RepositoryGateway
```

because it creates the boundary between:

```text
model behavior
```

and:

```text
repository infrastructure
```

Needle is one implementation of routing.

---

# 132. Suggested Internal Interfaces

```ts
interface ToolRouter {
  classify(
    input: RouterInput
  ): Promise<RouteDecision>;
}

interface RepositoryGateway {
  execute(
    request: RepositoryRequest
  ): Promise<RepositoryResult>;
}

interface BackendSelector {
  select(
    operation: RepositoryOperation,
    context: BackendContext
  ): Promise<RepositoryBackend>;
}

interface RepositoryBackend {
  supports(operation: RepositoryOperation): boolean;

  execute(
    operation: RepositoryOperation
  ): Promise<RepositoryResult>;
}
```

---

# 133. Router Input

Suggested:

```ts
interface RouterInput {
  userRequest?: string;

  toolName: string;

  arguments: Record<string, unknown>;

  recentToolCalls: RepositoryToolCall[];

  investigationState?: InvestigationState;

  repositoryContext?: RepositoryContext;
}
```

Keep this stable.

---

# 134. Repository Context

Suggested:

```ts
interface RepositoryContext {
  root: string;

  graphStatus:
    | "fresh"
    | "stale"
    | "building"
    | "unavailable";

  supportedLanguages: string[];

  graphCoverage?: {
    indexedFiles: number;
    totalFiles: number;
  };
}
```

Add fields only when they materially affect routing.

---

# 135. Policy Precedence

When signals conflict, use:

```text
explicit exact-content request
>
explicit user scope
>
security/permission policy
>
deterministic route constraints
>
repository facts
>
Needle suggestion
>
heuristic fallback
```

This prevents the router from overriding explicit user intent.

---

# 136. User Intent Must Win

Example:

```text
"Search the docs for the exact phrase 'Foo calls Bar'."
```

Even if the phrase describes a relationship, the request is documentation search.

The router must honor explicit scope.

---

# 137. Repository Scope Must Win

Example:

```text
grep Foo docs/
```

Do not route to graph search if the user explicitly limits the operation to documentation.

The graph may know source relationships but not satisfy the requested scope.

---

# 138. Exactness Must Win

Example:

```text
Show the exact contents of Foo.ts.
```

Always direct read.

Do not replace exact retrieval with graph-derived summaries.

---

# 139. Semantic Intent Is Most Useful When the User Is Actually Asking a Relationship Question

The highest-confidence upgrades are:

```text
callers
references
dependents
imports
implementations
extensions
impact
```

These should be the first operations to optimize.

---

# 140. Optional Future Extension: Test Graph

Once the architecture exists, Banyan could add:

```text
which tests cover Foo?
which tests are affected by changing Foo?
```

Needle can eventually route:

```text
TEST_COVERAGE
TEST_IMPACT
```

without changing the model-facing tool interface.

This demonstrates why semantic routing is more future-proof than tool aliasing.

---

# 141. Optional Future Extension: Build Graph

Potential future routes:

```text
BUILD_DEPENDENCIES
AFFECTED_TARGETS
BUILD_IMPACT
```

Again, the model could still call familiar repository tools.

---

# 142. Optional Future Extension: Runtime Traces

Future backends could provide:

```text
runtime callers
runtime dependencies
observed execution paths
```

The gateway architecture can incorporate them without exposing a new model tool.

---

# 143. Optional Future Extension: Git Intelligence

Possible operations:

```text
who last changed this symbol?
what commit introduced this dependency?
which files usually change together?
```

These should become semantic operations and backend services.

Needle only needs to learn new route labels if these capabilities are introduced as explicit routing candidates.

---

# 144. Performance Optimization

The gateway should minimize work in this order:

```text
fast deterministic match
>
cached routing
>
Needle
>
expensive repository analysis
```

Do not make every request pay every layer.

---

# 145. Failure Isolation

A failure in:

```text
Needle
```

must not cause failure in:

```text
filesystem
```

A failure in:

```text
graph
```

must not cause failure in:

```text
direct search
```

Use independent error boundaries.

---

# 146. Debug Mode

A developer mode should expose:

```text
original tool
normalized operation
Needle route
confidence
policy overrides
backend
latency
result source
fallback reason
```

This will be essential during the first months of development.

---

# 147. User-Facing Transparency

Default user experience should remain simple.

Users generally do not need to see:

```text
Needle classified grep -> CALLERS at 0.93 confidence.
```

This is useful in developer diagnostics, not normal interaction.

---

# 148. Benchmark Against No Router

Measure:

```text
Primary LLM + native Banyan tools
Primary LLM + compatibility tools
Primary LLM + gateway/rules
Primary LLM + gateway/Needle
```

This isolates the value of each layer.

---

# 149. Benchmark Against Strong Tool-Using Models

Use at least two categories:

1. models that already use Banyan tools reliably,
2. models that strongly prefer conventional repository tools.

The router's main value should appear in category 2.

---

# 150. Success Target

A useful target is not:

```text
Needle chooses codegraph 90% of the time
```

It is:

```text
Models with poor native Banyan-tool selection
achieve repository-task performance approaching
models that select Banyan tools natively.
```

That validates the architecture.

---

# 151. Recommended Rollout Benchmark

For each model:

```text
A. conventional tools only
B. conventional + native Banyan tools
C. conventional + gateway rules
D. conventional + gateway + Needle
```

Measure:

- task score,
- task success,
- graph coverage,
- tool calls,
- context,
- tokens,
- latency.

This can become a major Banyan benchmark.

---

# 152. Potential Marketing Value

If the architecture works, the product claim becomes stronger:

> BanyanCode's repository intelligence does not depend on the model knowing which repository tool to call.

That is a more durable differentiator than claiming:

> our prompt makes the model use our tools.

---

# 153. Architectural Risks

## Risk: Needle misroutes

Mitigation:

- conservative thresholds,
- policy validation,
- direct fallback,
- hard-negative benchmark.

## Risk: Needle packaging complexity

Mitigation:

- isolated router package,
- optional backend,
- clean native boundary.

## Risk: graph freshness

Mitigation:

- explicit freshness state,
- incremental updates,
- fallback.

## Risk: context inflation

Mitigation:

- selective augmentation,
- compact results.

## Risk: maintenance cost

Mitigation:

- stable gateway interfaces,
- pluggable router,
- centralized policy.

---

# 154. What Should Not Be Implemented First

Avoid first-version complexity in:

```text
multi-stage Needle pipelines
fully learned routing
automatic code rewriting
aggressive read augmentation
dynamic tool catalogs
cross-session router memory
```

First establish:

```text
gateway
rules
Needle shadow
telemetry
safe fallback
```

---

# 155. Recommended First Milestone

The first useful milestone is:

```text
A model that only calls read/grep/glob
can complete repository-semantic tasks using
Banyan graph infrastructure without ever calling
a codegraph-specific model tool.
```

Demonstrate this before building sophisticated learned routing.

---

# 156. Recommended Second Milestone

Demonstrate:

```text
Needle route accuracy > deterministic baseline
```

on a held-out routing benchmark.

If it does not beat the rules, do not force it into production.

---

# 157. Recommended Third Milestone

Demonstrate:

```text
Primary LLM + compatibility gateway + Needle
```

approaches:

```text
Primary LLM + direct native Banyan tools
```

on repository tasks.

That is the architectural proof point.

---

# 158. Definition of Done

The implementation is ready for a first release when:

- `read`, `grep`, and `glob` still work normally.
- Graph-suitable semantic requests can be routed without model-specific prompting.
- Documentation and arbitrary text remain searchable/readable.
- Needle failure falls back safely.
- Graph freshness is checked.
- permissions remain enforced by Banyan.
- routing is fully traced.
- the router can be disabled.
- a benchmark demonstrates improvement on models with conventional tool priors.
- packaging does not materially complicate installation.

---

# 159. Final Architecture

The intended end state is:

```text
                              ANY PRIMARY LLM
                                     |
                           familiar tool actions
                                     |
                                     v
                     +-------------------------------+
                     | Banyan Repository Gateway     |
                     +---------------+---------------+
                                     |
                             normalize request
                                     |
                                     v
                       +-----------------------------+
                       | fast deterministic policy  |
                       +-------------+---------------+
                                     |
                       +-------------+-------------+
                       |                           |
                 obvious direct               ambiguous
                       |                           |
                       v                           v
                    execute                    Needle 2
                                                   |
                                           route + arguments
                                                   |
                                                   v
                                          Banyan validation
                                                   |
                              +--------------------+--------------------+
                              |                    |                    |
                              v                    v                    v
                           DIRECT               AUGMENT          INTELLIGENCE
                              |                    |                    |
                              v                    v                    v
                         filesystem          FS + metadata      codegraph / AST /
                         text search                               structural /
                                                                  repository RI
                              |                    |                    |
                              +--------------------+--------------------+
                                                   |
                                             unified result
                                                   |
                                                   v
                                              PRIMARY LLM
```

The most important property is that the **primary model's learned tool-use policy is no longer the architectural bottleneck**.

A model can continue to prefer:

```text
read
grep
glob
```

and Banyan can still use:

```text
search
symbols
graph
AST
relationships
architecture
ownership
impact
```

when the semantics warrant it.

Needle 2 should remain a replaceable local routing component. The stable and strategically important layer is the Banyan Repository Intelligence Gateway.

---

# 160. Immediate Engineering Recommendation

Before implementation:

1. Audit current Banyan tool registration and execution flow.
2. Identify the narrowest interception point through which `read`, `grep`, and `glob` can be routed.
3. Implement the gateway with DIRECT behavior only.
4. Add routing traces.
5. Build a 300–1,000 example routing benchmark with hard negatives.
6. Implement deterministic routing.
7. Integrate Needle 2 in shadow mode.
8. Compare Needle against rules.
9. Activate Needle only where it improves held-out results.
10. Fine-tune Needle later using real Banyan traces if justified.
11. Keep the router behind an abstraction so the underlying routing model can be replaced.

The architecture should be judged on one primary question:

> **Can Banyan turn conventional model behavior into high-quality repository intelligence without requiring the model itself to change its learned tool-use policy?**

If the answer is yes, Banyan has a genuinely model-agnostic repository-intelligence architecture rather than merely a better prompt.
