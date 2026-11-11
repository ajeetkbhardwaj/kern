# Plan: 4-Layer Safety Policy for Kern (TypeScript Adaptation)

## Overview
Adapt docker-agents' 4-concentric-layers safety model (Chapter 11) as kern's security framework. Provides defense-in-depth with declarative permissions, configurable safety modes, hook-based enforcement, and optional real isolation.

## TypeScript Adaptation Goals

### 1. Layer 1: Permission Rules (`src/permissions/`)
Declarative lists evaluated **Deny → Allow → Ask**, otherwise fall through to safety mode:

```yaml
# kern permissions.yaml
permissions:
  allow:
    - "git status"
    - "git diff *"
    - "ls"
    - "cat"
  deny:
    - "rm -rf *"
    - "docker rm *"
    - "chmod -R 777 /"
  ask:
    - "kubectl *"
    - "sudo *"
```

**Classifier labels every shell/tool call as**:
- `safe` - allowlisted shell verbs or tools annotated read-only (MCP annotations feed this directly)
- `destructive` - recognized dangerous patterns (`rm -rf`, force-push, etc.)
- `unknown` - everything else

**Evaluation order**: Deny rules first, then Allow, then Ask (fall through to safety mode)

### 2. Layer 2: Safety Modes
Configurable autonomy levels with precedence:

| Mode | safe | destructive | unknown | Notes |
|------|------|-------------|---------|-------|
| `strict` | ask | ask | ask | Maximum oversight |
| `balanced` *(default)* | allow | ask | ask | Daily driver |
| `restricted` | allow | **deny** | **deny** | Headless fail-closed (CI/servers) |
| `autonomous` | allow | allow | allow | Legacy `--yolo` |

**Selection precedence** (highest wins):
1. `--safety` flag on command line
2. `safety_policy` on API session create/PATCH
3. Per-agent `safety:` config
4. `runtime.safety` global setting

**In-TUI prompt escalation**: Keys (B/A) let the user shift behavior mid-run
**Approvals can be remembered**: "always allow this pattern" writes back into the rule set

### 3. Layer 3: Hook Enforcement (integrates with hooks system)
`tool_input_transform` → `tool_guard` → `permission_request` → approval UI → `tool_response_transform`

- Even auto-approved calls pass transforms (secret redaction runs regardless of mode)
- Evaluator-backed guards produce OpenAI-style approve/reject verdicts from an LLM judge
- Hooks provide the interception mechanism; safety modes provide the policy

### 4. Layer 4: Real Isolation (optional, fail-closed)
**Note**: "restricted mode is a policy boundary, not a security boundary"

**OS-level isolation options**:
- Namespaces-style confinement (Linux user/pid/mount namespaces)
- `sandbox/kit` implementations (darwin/linux, seatbelt-style)
- Cloud sandboxes: remote execution environments; templates & provisioning
- Tool execution targeting remote runtimes (`runtime/remote`) - agent logic local, side effects elsewhere

### 5. Supporting Protections
- `readonly: true` - filters toolsets/agents to non-mutating tools (enforced in teamloader)
- `agentignore` files + `.agentignore` for distribution
- `redact_secrets` tri-state - auto-injects three hooks:
  - Scrubbing secrets from tool args
  - Scrubbing secrets from outgoing messages
  - Scrubbing secrets from outputs before persistence/UI/next LLM call
- `tri-state auto` - detects likely secret presence heuristically
- Server hardening: `pkg/httpsec`, `pkg/servesafety`, `pkg/protect` guard serve api/mcp/a2a surfaces
- Unix-socket listeners default on some platforms (with auth/origin checks)

### 5. Threat-Model Takeaway
Docker Agent assumes the **model may be prompt-injected**; therefore:
- Least-privilege defaults (balanced mode)
- Fail-closed option (restricted mode)
- Annotation-driven classification
- Hook-based scrubbing
- Optional hard isolation
- Form defense-in-depth rather than one gate

## Integration with Kern Components

### With Policy Engine
- Safety mode selection feeds into `DefaultPolicy` configuration
- Permission rules evaluate before tool execution
- Hook enforcement pipeline runs at each tool lifecycle point

### With Tool Registry
- Tool annotations (`readOnlyHint`, `destructiveHint`) feed into classifier
- Tool execution checks safety mode before allowing
- Policy denied/require_approval respected per mode

### With TUI
- Safety mode displayed in status bar
- B/A keys for mid-run mode switching
- Approval prompts respect current safety mode
- Rule set editable from TUI (writes back to config)

## Implementation Priority
**HIGH** - dramatically improves kern's security posture and is foundational for production use.

## Files to Create/Modify
- `src/permissions/permissions.ts` - Permission rule engine
- `src/safety/safety-mode.ts` - Safety mode configuration and evaluation
- `src/safety/safety-patterns.ts` - Destructive pattern detection
- `src/policy.ts` - Integrate safety modes into DefaultPolicy
- `tui/` - Safety mode display and B/A key handling
- `docs/configuration/permissions.md` - User-facing config docs

## Reference from docker-agents
- Chapter 11: Permissions, Safety Modes & Sandbox
- Safety modes table and evaluation precedence
- Redact secrets tri-state mechanism
- Threat-model takeaway philosophy
- Layer 4 isolation options and caveats