#!/usr/bin/env bash
#
# Yama → GitHub one-command setup
# ===============================================================================
# Interactively wires the @juspay/yama AI PR-review GitHub Action into ANY GitHub
# repository. It performs ONLY the code changes (it never touches your secrets,
# never commits, never opens a PR) and then prints a guided checklist of what YOU
# still need to do (set secrets, optionally make it a required check, raise a PR
# or merge — your call).
#
# What it writes:
#   • .github/workflows/yama-review.yml  — provider-aware review workflow
#   • yama.config.yaml                   — a standard, working config with clearly
#                                          marked TODOs you tune to "what to catch"
#
# Run it from the target repo (no install needed):
#   curl -fsSL https://raw.githubusercontent.com/juspay/yama/main/scripts/setup-github.sh | bash
# or, from a cloned yama checkout:
#   bash /path/to/yama/scripts/setup-github.sh
#
# Non-interactive / CI use (flags skip the prompts):
#   bash setup-github.sh --provider anthropic --model claude-opus-4-8 \
#        --branches main --yes
#
# Flags:
#   --provider <id>     litellm | anthropic | openai | google-ai | vertex
#   --model <name>      model id for the provider (a sensible default is offered)
#   --branches <list>   target branch(es), comma/space separated (default: repo default)
#   --ref <ref>         action ref to pin: a tag/SHA (default: v2.6.0), or a full
#                       owner/repo[@ref] to use a fork
#   --name <name>       workflow + required-check name (default: "Yama PR Review")
#   --workflow-file <f> workflow filename under .github/workflows (default: yama-review.yml)
#   --config-path <p>   config filename (default: yama.config.yaml)
#   --no-config         don't write yama.config.yaml (Yama uses built-in defaults)
#   --no-enforce        review posts comments but never fails the check (advisory)
#   --vertex-location   Vertex AI region (default: us-central1)
#   --force             overwrite existing files without asking
#   --dry-run           print what would be written; change nothing
#   --yes               non-interactive: accept defaults for every unanswered prompt
#   -h, --help          show this help and exit
# ===============================================================================

set -euo pipefail

# Action repo + default ref. Owned by juspay, so a tag pin is acceptable; for
# strict supply-chain immutability replace the tag with the commit SHA behind it.
readonly ACTION_REPO="juspay/yama"
readonly DEFAULT_REF="v2.6.0"
# pnpm version the action pins via pnpm/action-setup. Repos that declare a
# DIFFERENT pnpm in package.json "packageManager" trigger a clash we work around.
readonly ACTION_PNPM="10.14.0"

# --------------------------------------------------------------------------- UI
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  C_RESET=$'\033[0m'; C_BOLD=$'\033[1m'; C_DIM=$'\033[2m'
  C_BLUE=$'\033[34m'; C_GREEN=$'\033[32m'; C_YELLOW=$'\033[33m'; C_RED=$'\033[31m'; C_CYAN=$'\033[36m'
else
  C_RESET=''; C_BOLD=''; C_DIM=''; C_BLUE=''; C_GREEN=''; C_YELLOW=''; C_RED=''; C_CYAN=''
fi
info()  { printf '%s\n' "${C_BLUE}•${C_RESET} $*"; }
ok()    { printf '%s\n' "${C_GREEN}✓${C_RESET} $*"; }
warn()  { printf '%s\n' "${C_YELLOW}!${C_RESET} $*" >&2; }
err()   { printf '%s\n' "${C_RED}✗${C_RESET} $*" >&2; }
hdr()   { printf '\n%s\n' "${C_BOLD}${C_CYAN}$*${C_RESET}"; }
die()   { err "$*"; exit 1; }

# Read prompt answers from the controlling terminal even when the script itself
# arrives on stdin (curl | bash). Falls back to the default with no tty / --yes.
TTY=""
[ -r /dev/tty ] && TTY="/dev/tty"
ask() { # ask <out-var> <prompt> <default>
  local __var="$1" __prompt="$2" __default="${3:-}" __ans=""
  if [ -n "$ASSUME_YES" ] || [ -z "$TTY" ]; then
    printf -v "$__var" '%s' "$__default"; return
  fi
  if [ -n "$__default" ]; then
    printf '%s' "${C_BOLD}?${C_RESET} $__prompt ${C_DIM}[$__default]${C_RESET} " > "$TTY"
  else
    printf '%s' "${C_BOLD}?${C_RESET} $__prompt " > "$TTY"
  fi
  IFS= read -r __ans < "$TTY" || __ans=""
  [ -z "$__ans" ] && __ans="$__default"
  printf -v "$__var" '%s' "$__ans"
}
confirm() { # confirm <prompt> <default y|n>  -> 0 = yes
  local __prompt="$1" __default="${2:-y}" __ans=""
  if [ -n "$ASSUME_YES" ] || [ -z "$TTY" ]; then [ "$__default" = "y" ]; return; fi
  local hint="[Y/n]"; [ "$__default" = "n" ] && hint="[y/N]"
  printf '%s' "${C_BOLD}?${C_RESET} $__prompt ${C_DIM}$hint${C_RESET} " > "$TTY"
  IFS= read -r __ans < "$TTY" || __ans=""
  [ -z "$__ans" ] && __ans="$__default"
  case "$__ans" in [Yy]*) return 0;; *) return 1;; esac
}
# Self-contained help (works whether the script is a file or piped via curl|bash,
# where $0 is "bash" and unreadable; also avoids leaking source internals).
usage() {
  cat <<'USAGE'
Yama → GitHub one-command setup

Wires the @juspay/yama AI PR-review GitHub Action into a GitHub repo. It performs
ONLY the code changes (never touches secrets, never commits, never opens a PR),
then prints a checklist of what you still need to do.

Writes:
  .github/workflows/yama-review.yml   provider-aware review workflow
  yama.config.yaml                    standard config with TODOs you tune

Usage:
  bash setup-github.sh [flags]
  curl -fsSL https://raw.githubusercontent.com/juspay/yama/main/scripts/setup-github.sh | bash

Flags:
  --provider <id>      litellm | anthropic | openai | google-ai | vertex
  --model <name>       model id for the provider (a sensible default is offered)
  --branches <list>    target branch(es), comma/space separated (default: repo default)
  --ref <ref>          action ref to pin: tag/SHA (default: v2.6.0), or owner/repo[@ref]
  --name <name>        workflow + required-check name (default: "Yama PR Review")
  --workflow-file <f>  filename under .github/workflows (default: yama-review.yml)
  --config-path <p>    config filename (default: yama.config.yaml)
  --no-config          don't write yama.config.yaml (Yama uses built-in defaults)
  --no-enforce         review posts comments but never fails the check (advisory)
  --vertex-location    Vertex AI region (default: us-central1)
  --force              overwrite existing files (backs up the old file to .bak)
  --dry-run            print what would be written; change nothing
  --yes, -y            non-interactive: accept defaults for unanswered prompts
  -h, --help           show this help and exit
USAGE
}

# ----------------------------------------------------------------------- inputs
PROVIDER=""; MODEL=""; BRANCHES=""; REF="$DEFAULT_REF"; NAME="Yama PR Review"
WORKFLOW_FILE="yama-review.yml"; CONFIG_PATH="yama.config.yaml"
WRITE_CONFIG=1; ENFORCE=1; VERTEX_LOCATION="us-central1"
FORCE=""; DRY_RUN=""; ASSUME_YES=""

# Guard value-taking flags: a trailing flag with no value would otherwise hit
# `shift 2` with one arg left → "shift count out of range" → silent set -e abort.
need_val() { [ $# -ge 2 ] || die "$1 requires a value (use --help)"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --provider) need_val "$@"; PROVIDER="$2"; shift 2;;
    --model) need_val "$@"; MODEL="$2"; shift 2;;
    --branches|--branch) need_val "$@"; BRANCHES="$2"; shift 2;;
    --ref) need_val "$@"; REF="$2"; shift 2;;
    --name) need_val "$@"; NAME="$2"; shift 2;;
    --workflow-file) need_val "$@"; WORKFLOW_FILE="$2"; shift 2;;
    --config-path) need_val "$@"; CONFIG_PATH="$2"; shift 2;;
    --no-config) WRITE_CONFIG=0; shift;;
    --no-enforce) ENFORCE=0; shift;;
    --vertex-location) need_val "$@"; VERTEX_LOCATION="$2"; shift 2;;
    --force) FORCE=1; shift;;
    --dry-run) DRY_RUN=1; shift;;
    --yes|-y) ASSUME_YES=1; shift;;
    -h|--help) usage; exit 0;;
    *) die "Unknown argument: $1 (use --help)";;
  esac
done

# --------------------------------------------------------------- preconditions
command -v git >/dev/null 2>&1 || die "git is required but not found on PATH."
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || true)"
[ -n "$REPO_ROOT" ] || die "Not inside a git repository. Run this from the repo you want Yama to review."
cd "$REPO_ROOT"

hdr "Yama → GitHub setup"
info "Repository: ${C_BOLD}$REPO_ROOT${C_RESET}"
[ -n "$DRY_RUN" ] && warn "DRY RUN — no files will be written."

# Detect the default branch to offer as the review target.
# Robust under `set -e`: every step swallows its own failure (gh may error, a
# fresh repo may have no commits) and we always fall back to a sane default.
detect_default_branch() {
  local b=""
  b="$(git symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null | sed 's@^origin/@@')" || b=""
  if [ -z "$b" ] && command -v gh >/dev/null 2>&1; then
    b="$(gh repo view --json defaultBranchRef --jq '.defaultBranchRef.name' 2>/dev/null)" || b=""
  fi
  if [ -z "$b" ]; then
    b="$(git rev-parse --abbrev-ref HEAD 2>/dev/null)" || b=""
  fi
  [ -n "$b" ] || b="main"
  printf '%s' "$b"
}
DEFAULT_BRANCH="$(detect_default_branch)"

# ------------------------------------------------------------------- provider
if [ -z "$PROVIDER" ]; then
  if [ -n "$TTY" ] && [ -z "$ASSUME_YES" ]; then
    hdr "AI provider"
    cat > "$TTY" <<MENU
  1) litellm     (LiteLLM proxy — e.g. juspay private-large)
  2) anthropic   (Claude)
  3) openai      (GPT)
  4) google-ai   (Gemini, AI Studio key)
  5) vertex      (Gemini/Claude on Google Vertex AI, service-account JSON)
MENU
    ask _sel "Choose a provider (1-5):" "1"
    case "$_sel" in
      1|litellm) PROVIDER="litellm";; 2|anthropic) PROVIDER="anthropic";;
      3|openai) PROVIDER="openai";; 4|google-ai|googleai) PROVIDER="google-ai";;
      5|vertex) PROVIDER="vertex";; *) die "Invalid provider selection: $_sel";;
    esac
  else
    PROVIDER="litellm"
  fi
fi
case "$PROVIDER" in litellm|anthropic|openai|google-ai|vertex) ;; *) die "Unsupported provider: $PROVIDER";; esac

# Per-provider defaults + wiring. These arrays drive the preflight gate, the step
# `with:` inputs, and the closing guidance so they never drift apart.
DEFAULT_MODEL=""; REQUIRED_SECRETS=(); WITH_PAIRS=(); SECRET_DOC=""
case "$PROVIDER" in
  litellm)
    DEFAULT_MODEL="private-large"
    REQUIRED_SECRETS=(LITELLM_BASE_URL LITELLM_API_KEY)
    WITH_PAIRS=("litellm-base-url=LITELLM_BASE_URL" "litellm-api-key=LITELLM_API_KEY")
    SECRET_DOC=$'#   LITELLM_BASE_URL  : LiteLLM proxy base URL (reachable from GitHub runners).\n#   LITELLM_API_KEY   : LiteLLM proxy API key.'
    ;;
  anthropic)
    DEFAULT_MODEL="claude-opus-4-8"
    REQUIRED_SECRETS=(ANTHROPIC_API_KEY)
    WITH_PAIRS=("anthropic-api-key=ANTHROPIC_API_KEY")
    SECRET_DOC=$'#   ANTHROPIC_API_KEY : Anthropic API key (sk-ant-...).'
    ;;
  openai)
    DEFAULT_MODEL="gpt-4o"
    REQUIRED_SECRETS=(OPENAI_API_KEY)
    WITH_PAIRS=("openai-api-key=OPENAI_API_KEY")
    SECRET_DOC=$'#   OPENAI_API_KEY    : OpenAI API key (sk-...).'
    ;;
  google-ai)
    DEFAULT_MODEL="gemini-2.5-pro"
    REQUIRED_SECRETS=(GOOGLE_AI_API_KEY)
    WITH_PAIRS=("google-ai-api-key=GOOGLE_AI_API_KEY")
    SECRET_DOC=$'#   GOOGLE_AI_API_KEY : Google AI Studio API key.'
    ;;
  vertex)
    DEFAULT_MODEL="gemini-2.5-pro"
    # google-vertex-project is optional (auto-derived from the JSON); wire it so
    # users can override, but the preflight gate only requires the creds JSON.
    REQUIRED_SECRETS=(GOOGLE_APPLICATION_CREDENTIALS_JSON)
    WITH_PAIRS=("google-application-credentials=GOOGLE_APPLICATION_CREDENTIALS_JSON" "google-vertex-project=GOOGLE_VERTEX_PROJECT")
    SECRET_DOC=$'#   GOOGLE_APPLICATION_CREDENTIALS_JSON : Vertex service-account key JSON (full file contents).\n#   GOOGLE_VERTEX_PROJECT (optional)    : GCP project id; auto-derived from the JSON when unset.'
    ;;
esac
[ -z "$MODEL" ] && ask MODEL "Model id for $PROVIDER:" "$DEFAULT_MODEL"
[ -n "$MODEL" ] || die "A model id is required."

# ------------------------------------------------------------------- branches
[ -z "$BRANCHES" ] && ask BRANCHES "Branch(es) whose PRs get reviewed (comma/space separated):" "$DEFAULT_BRANCH"
# Split on commas/spaces with globbing OFF, so a branch name containing a shell
# glob char — or an intended GitHub Actions branch pattern like 'release/*' —
# is kept verbatim instead of being expanded against the repo's files.
_branch_list=""; _saved_ifs=$IFS; IFS=', '; set -f
for b in $BRANCHES; do
  [ -z "$b" ] && continue
  _branch_list="${_branch_list:+$_branch_list, }$b"
done
set +f; IFS=$_saved_ifs
[ -n "$_branch_list" ] || die "At least one target branch is required."
BRANCHES_YAML="[$_branch_list]"

# ------------------------------------------------------------------- other opts
[ -n "$ASSUME_YES" ] || ask REF "Pin the action to which ref (tag or commit SHA)?" "$REF"
[ -n "$ASSUME_YES" ] || ask NAME "Workflow / required-check name:" "$NAME"
if [ -z "$ASSUME_YES" ] && [ "$ENFORCE" = "1" ]; then
  confirm "Fail the check on a BLOCKED verdict (so it can gate merges)?" "y" && ENFORCE=1 || ENFORCE=0
fi

# Allow a full "owner/repo[@ref]" via --ref (for forks); otherwise pin our repo.
case "$REF" in
  */*) ACTION_USES="$REF" ;;
  *)   ACTION_USES="$ACTION_REPO@$REF" ;;
esac

# Emit NAME as a single-quoted YAML scalar (doubling any embedded quote) so a
# custom --name containing ':' or a leading YAML-significant char can't produce
# invalid YAML that GitHub Actions rejects. The branch-protection context users
# register is still the plain NAME (shown in the guidance), not this quoted form.
_sq="'"
NAME_YAML="'${NAME//$_sq/$_sq$_sq}'"

# Detect a pnpm "packageManager" clash (only matters if THIS repo pins a pnpm
# version different from the one the action uses internally).
PNPM_CLASH=0; REPO_PNPM=""
if [ -f package.json ]; then
  REPO_PNPM="$(sed -n 's/.*"packageManager"[[:space:]]*:[[:space:]]*"pnpm@\([0-9][0-9.]*\)".*/\1/p' package.json | head -n1)"
  if [ -n "$REPO_PNPM" ] && [ "$REPO_PNPM" != "$ACTION_PNPM" ]; then
    PNPM_CLASH=1
    info "Detected packageManager pnpm@$REPO_PNPM (≠ action's $ACTION_PNPM) → adding the pnpm-clash workaround."
  fi
fi

# =============================================================================
# Build provider-specific fragments, then assemble the workflow by ordered
# concatenation (printf / quoted-heredoc). We deliberately do NOT use bash
# ${var//pat/repl} string substitution: in bash 5.2 a `&` in the replacement is
# treated as the matched text, which would mangle the shell `&&` in the steps.
# printf '%s' and quoted heredocs reproduce values 100% literally instead.
# =============================================================================

# Preflight env lines for the provider secrets (10-space indent, literal ${{ }}).
PREFLIGHT_PROVIDER_ENV=""
for s in "${REQUIRED_SECRETS[@]}"; do
  PREFLIGHT_PROVIDER_ENV+="$(printf '          %s: ${{ secrets.%s }}' "$s" "$s")"$'\n'
done
PREFLIGHT_PROVIDER_ENV="${PREFLIGHT_PROVIDER_ENV%$'\n'}"

# Preflight "missing secret" condition.
PREFLIGHT_SECRET_CHECK='[ -z "$PAT" ]'
for s in "${REQUIRED_SECRETS[@]}"; do
  PREFLIGHT_SECRET_CHECK+=" || [ -z \"\$$s\" ]"
done

# Step `with:` provider inputs (10-space indent, literal ${{ }}).
WITH_PROVIDER_INPUTS=""
for pair in "${WITH_PAIRS[@]}"; do
  in_name="${pair%%=*}"; sec_name="${pair#*=}"
  WITH_PROVIDER_INPUTS+="$(printf '          %s: ${{ secrets.%s }}' "$in_name" "$sec_name")"$'\n'
done
[ "$PROVIDER" = "vertex" ] && WITH_PROVIDER_INPUTS+="$(printf '          google-vertex-location: %s' "$VERTEX_LOCATION")"$'\n'
WITH_PROVIDER_INPUTS="${WITH_PROVIDER_INPUTS%$'\n'}"

# config-path input (omit entirely when no config file will exist).
if [ "$WRITE_CONFIG" = "1" ] || [ -f "$CONFIG_PATH" ]; then
  CONFIG_PATH_LINE="$(printf '          config-path: %s' "$CONFIG_PATH")"
else
  CONFIG_PATH_LINE=""
fi

# Optional pnpm workaround + its restore step.
PNPM_SETUP=""; RESTORE_STEP=""
if [ "$PNPM_CLASH" = "1" ]; then
  PNPM_SETUP="$(cat <<'EOF'
      # The Yama action pins pnpm via pnpm/action-setup, but this repo declares a
      # different pnpm in package.json "packageManager", and pnpm/action-setup@v4
      # aborts when both are present and differ. Temporarily drop the field so the
      # action uses its own pinned pnpm; it builds in its own directory and reviews
      # the PR via the GitHub API (not the local tree), so this is invisible to the
      # review. Restored right after.
      - name: Work around pnpm/action-setup version clash
        if: steps.gate.outputs.run == 'true'
        run: |
          node -e "const fs=require('fs');const p=JSON.parse(fs.readFileSync('package.json','utf8'));delete p.packageManager;fs.writeFileSync('package.json',JSON.stringify(p,null,2)+'\n')"
EOF
)"
  RESTORE_STEP="$(cat <<'EOF'

      # Undo the temporary packageManager edit (no-op if it was never applied).
      - name: Restore package.json
        if: ${{ always() && steps.gate.outputs.run == 'true' }}
        run: git checkout -- package.json || true
EOF
)"
fi

# Verdict step: blocking (fails on BLOCKED) vs advisory (never fails on verdict).
if [ "$ENFORCE" = "1" ]; then
  VERDICT_STEP="$(cat <<'EOF'
      - name: Enforce verdict
        if: steps.gate.outputs.run == 'true'
        env:
          DECISION: ${{ steps.yama.outputs.decision }}
          OUTCOME: ${{ steps.yama.outcome }}
        run: |
          echo "Yama decision: ${DECISION:-<none>} (action outcome: ${OUTCOME})"
          # No verdict + failed action = the review couldn't complete (build / MCP
          # / provider error), not a code judgement. Fail so it's visible; re-run
          # the job to retry transient failures.
          if [ "$OUTCOME" != "success" ] && [ -z "$DECISION" ]; then
            echo "::error::Yama could not complete the review (infrastructure error, not a code verdict). Re-run this job to retry."
            exit 1
          fi
          if [ "$DECISION" = "BLOCKED" ]; then
            echo "::error::Yama BLOCKED this PR. Resolve the blocking issues flagged in the review, then push an update."
            exit 1
          fi
          echo "Yama review passed (decision=${DECISION:-APPROVED})."
EOF
)"
else
  VERDICT_STEP="$(cat <<'EOF'
      - name: Report verdict
        if: steps.gate.outputs.run == 'true'
        env:
          DECISION: ${{ steps.yama.outputs.decision }}
          OUTCOME: ${{ steps.yama.outcome }}
        run: |
          echo "Yama decision: ${DECISION:-<none>} (action outcome: ${OUTCOME})"
          if [ "$OUTCOME" != "success" ] && [ -z "$DECISION" ]; then
            echo "::warning::Yama could not complete the review (infrastructure error). Re-run to retry."
          fi
          # Advisory mode: the review is posted as comments but never fails the
          # check. Re-run setup without --no-enforce to gate merges on BLOCKED.
          echo "Yama review finished (advisory; decision=${DECISION:-<none>})."
EOF
)"
fi

# ----------------------------------------------------------- assemble workflow
gen_workflow() {
  # Header + name + triggers (dynamic values; no ${{ }} / shell $ in this span).
  cat <<EOF
# Yama PR Review — AI code review on PRs targeting the configured branch(es).
#
# Generated by scripts/setup-github.sh (https://github.com/juspay/yama). Powered
# by the published @juspay/yama action: it reads the PR through the hosted GitHub
# MCP server, walks the diff, and posts inline review comments + a verdict. The
# review RULES come from THIS repo — Yama auto-loads CLAUDE.md and CONTRIBUTING.md
# when present; focus areas / blocking criteria live in ${CONFIG_PATH}.
#
# Required repository secrets (Settings → Secrets and variables → Actions):
#   YAMA_GITHUB_TOKEN : a REAL GitHub PAT — fine-grained with "Pull requests:
#                       Read and write" + "Contents: Read", OR a classic PAT with
#                       \`repo\`. The hosted GitHub MCP endpoint rejects the
#                       ephemeral Actions GITHUB_TOKEN, so this is mandatory.
${SECRET_DOC}
#
# Fork PRs (which can't read secrets) and runs with missing secrets are skipped
# cleanly — the check passes so it never deadlocks merges.

name: ${NAME_YAML}

on:
  pull_request:
    types: [opened, synchronize, reopened]
    branches: ${BRANCHES_YAML}
EOF

  # concurrency / permissions / jobs scaffold (literal ${{ }}).
  cat <<'EOF'

concurrency:
  group: yama-review-${{ github.event.pull_request.number }}
  cancel-in-progress: true

permissions:
  contents: read
  pull-requests: write

jobs:
  yama-review:
EOF

  # Job name (= required-check context) + step scaffold up to env: (dynamic NAME).
  cat <<EOF
    # This job name IS the status-check context. To make Yama a REQUIRED check,
    # add a context named exactly "${NAME}" to the branch protection rule.
    name: ${NAME_YAML}
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write
    steps:
      # A required check must always report a conclusion, so when it can't run
      # (fork / missing secrets) we PASS instead of skipping, to avoid blocking
      # merges forever.
      - name: Preflight (fork + secrets)
        id: gate
        env:
EOF

  # Preflight env (literal ${{ }}): PAT, provider secrets, same-repo flag.
  printf '          PAT: ${{ secrets.YAMA_GITHUB_TOKEN }}\n'
  printf '%s\n' "$PREFLIGHT_PROVIDER_ENV"
  printf '          IS_SAME_REPO: ${{ github.event.pull_request.head.repo.full_name == github.repository }}\n'

  # Preflight run body up to the dynamic secret-presence check (literal shell $).
  cat <<'EOF'
        run: |
          if [ "$IS_SAME_REPO" != "true" ]; then
            echo "::notice::Fork PR — repository secrets are unavailable; skipping Yama review (check passes)."
            echo "run=false" >> "$GITHUB_OUTPUT"
            exit 0
          fi
EOF
  printf '          if %s; then\n' "$PREFLIGHT_SECRET_CHECK"
  cat <<'EOF'
            echo "::notice::Missing one or more required secrets (see workflow header); skipping Yama review (check passes)."
            echo "run=false" >> "$GITHUB_OUTPUT"
            exit 0
          fi
          echo "run=true" >> "$GITHUB_OUTPUT"

      - name: Checkout
        if: steps.gate.outputs.run == 'true'
        uses: actions/checkout@v4
        with:
          fetch-depth: 0
          # Yama authenticates with its own PAT; don't leave the ephemeral Actions
          # token in .git/config.
          persist-credentials: false
EOF

  # Optional pnpm-clash workaround (with surrounding blank lines).
  printf '\n'
  [ -n "$PNPM_SETUP" ] && printf '%s\n\n' "$PNPM_SETUP"

  # Yama Review step header (literal), then dynamic uses: / provider inputs.
  cat <<'EOF'
      - name: Yama Review
        if: steps.gate.outputs.run == 'true'
        id: yama
        # Don't auto-fail the job on the action's exit code — the next step maps
        # the verdict to the check result explicitly.
        continue-on-error: true
        # External consumer → published action. For strict supply-chain
        # immutability pin the full commit SHA behind this ref.
EOF
  printf '        uses: %s\n' "$ACTION_USES"
  printf '        with:\n'
  printf '          github-token: ${{ secrets.YAMA_GITHUB_TOKEN }}\n'
  printf '          ai-provider: %s\n' "$PROVIDER"
  printf '          ai-model: %s\n' "$MODEL"
  printf '%s\n' "$WITH_PROVIDER_INPUTS"
  [ -n "$CONFIG_PATH_LINE" ] && printf '%s\n' "$CONFIG_PATH_LINE"
  cat <<'EOF'
          # Review only — post inline comments + a verdict; never rewrite the PR
          # description.
          skip-description-enhance: "true"
EOF

  # Verdict step (+ optional restore).
  printf '\n%s\n' "$VERDICT_STEP"
  [ -n "$RESTORE_STEP" ] && printf '%s\n' "$RESTORE_STEP"
  # Always succeed: a trailing falsey test (empty RESTORE_STEP) would otherwise
  # make the function return non-zero and trip `set -e` on the capture below.
  return 0
}
WF="$(gen_workflow)"

# =============================================================================
# The standard yama.config.yaml — a working config with clearly-marked TODOs the
# repo owner tunes to "what they want to catch". Provider/model are intentionally
# OMITTED (the workflow controls them via ai-provider / ai-model).
# =============================================================================
IFS= read -r -d '' CONFIG_BODY <<'YAMACONFIG' || true
# =============================================================================
# Yama PR Review configuration
# =============================================================================
# Consumed by the @juspay/yama GitHub Action (.github/workflows). Auto-discovered
# from the repo root (search order: yama.config.yaml → config/yama.config.yaml →
# .yama/config.yaml) and also passed explicitly via the workflow `config-path`.
#
# WHERE THE REVIEW RULES COME FROM
#   Yama automatically loads, from this repo root, if present:
#     • CLAUDE.md       — your authoritative engineering rules
#     • CONTRIBUTING.md — contribution + commit conventions
#   and injects them into the reviewer as <project-rules>. Keep repo-specific
#   rules THERE; this file tunes WHAT the reviewer focuses on and WHAT blocks a
#   merge.
#
# PROVIDER / MODEL ARE INTENTIONALLY NOT SET HERE
#   They are controlled by the workflow inputs (ai-provider / ai-model), exposed
#   as AI_PROVIDER / AI_MODEL env. Yama merges this file OVER those env values, so
#   setting ai.provider / ai.model here would silently override the workflow.
# =============================================================================

version: 2
configType: "yama"

display:
  showBanner: false
  streamingMode: false
  verboseToolCalls: false
  showAIThinking: false

ai:
  # provider/model OMITTED on purpose — controlled by the workflow.
  temperature: 0.2 # deterministic, review-grade output
  timeout: "15m"
  retryAttempts: 3

  # The explore worker reads project rules (CLAUDE.md / CONTRIBUTING.md) and
  # codebase context. Keep enabled so the reviewer sees your repo's rules.
  explore:
    enabled: true
    timeout: "5m"
    cacheResults: true

# GitHub MCP only. Jira/Bitbucket off so no extra credentials are needed. Yama's
# built-in denylist already blocks repo-mutating GitHub tools; this is a
# read + review-comment workflow.
mcpServers:
  github:
    enabled: true
    # transport defaults to "http" (hosted GitHub MCP at api.githubcopilot.com).
  jira:
    enabled: false

review:
  enabled: true

  # TODO: Tailor this to your project. This is the high-level instruction the
  # reviewer follows. Point it at your CLAUDE.md / CONTRIBUTING.md as the source
  # of truth and tell it not to duplicate your existing lint/type CI.
  workflowInstructions: |
    You are reviewing a pull request for this repository. Treat the
    <project-rules> block (this repo's CLAUDE.md / CONTRIBUTING.md, if present) as
    the AUTHORITATIVE ruleset and cite the specific rule when you flag a
    violation.

    Do NOT duplicate mechanical checks already enforced by CI (formatting, lint,
    type errors). Focus on what static analysis cannot catch: logic / correctness
    bugs, security issues, broken backward compatibility, missing error handling,
    missing tests for new behaviour, and risky changes.

    Be specific and constructive: every comment references the exact file+line,
    explains the concrete risk, and suggests a fix where useful. Only block per
    <blocking-criteria>; otherwise leave inline comments and approve.

  # TODO: Choose what the review prioritises. Priority is advisory; see
  # blockingCriteria below for what actually fails the check.
  focusAreas:
    - name: "Security"
      priority: "CRITICAL"
      description: |
        - Hardcoded secrets / API keys / tokens / credentials in source
        - Injection (command/SQL/template), unsafe eval, SSRF, path traversal
        - Missing validation / sanitization of user or external input
    - name: "Correctness"
      priority: "MAJOR"
      description: |
        - Logic bugs, off-by-one, unhandled promise rejections, races
        - Missing / incorrect error handling
        - Breaking changes to a public API without a migration path
    - name: "Tests & Docs"
      priority: "MINOR"
      description: |
        - New behaviour has tests
        - Public behaviour changes are reflected in docs

  # TODO: Tune what BLOCKS a merge. ONLY these escalate the decision to BLOCKED
  # (which fails the check when the workflow runs in enforcing mode). Everything
  # else is posted as an advisory inline comment.
  blockingCriteria:
    - condition: "Any hardcoded secret, API key, token, password or credential committed in source (non-test, non-example)"
      action: "BLOCK"
      reason: "Security: secrets must never be committed"
    - condition: "Any CRITICAL severity security vulnerability (injection, auth bypass, SSRF, secret or PII exposure)"
      action: "BLOCK"
      reason: "Critical security risk"
    # - condition: "3 or more MAJOR severity issues in the same pull request"
    #   action: "BLOCK"
    #   reason: "Too many significant issues to merge safely"

  # Generated / vendored / binary files are skipped.
  excludePatterns:
    - "*.lock"
    - "pnpm-lock.yaml"
    - "package-lock.json"
    - "yarn.lock"
    - "*.min.js"
    - "*.map"
    - "*.svg"
    - "dist/**"
    - "build/**"
    - "coverage/**"

  contextLines: 3
  maxFilesPerReview: 100
  fileAnalysisTimeout: "2m"

# Review-only: never rewrite PR descriptions (also forced by the workflow input
# skip-description-enhance: "true").
descriptionEnhancement:
  enabled: false

# Stateless reviewer: no memory-bank dir, no knowledge-base file, no commits back
# to the repo (needs no write access beyond posting the review).
memoryBank:
  enabled: false
knowledgeBase:
  enabled: false
memory:
  enabled: false
  autoCommit: false

# Cost / runtime guardrails.
performance:
  maxReviewDuration: "15m"
  tokenBudget:
    maxTokensPerReview: 800000
    warningThreshold: 600000
YAMACONFIG

# =============================================================================
# Write the files (respecting --dry-run / --force / existing-file prompts).
# =============================================================================
WF_PATH=".github/workflows/$WORKFLOW_FILE"

write_file() { # write_file <path> <content>
  local path="$1" content="$2"
  if [ -n "$DRY_RUN" ]; then
    hdr "── would write $path ──"
    printf '%s\n' "$content"
    return 0
  fi
  if [ -e "$path" ]; then
    if [ -z "$FORCE" ]; then
      if [ -n "$ASSUME_YES" ]; then
        warn "$path exists — skipping (use --force to overwrite)."; return 1
      fi
      if ! confirm "$path already exists. Overwrite?" "n"; then
        warn "Skipped $path."; return 1
      fi
    fi
    # Always preserve the prior file when we're about to overwrite it.
    cp -p "$path" "$path.bak" && info "Backed up existing file → $path.bak"
  fi
  mkdir -p "$(dirname "$path")"
  printf '%s\n' "$content" > "$path"
  ok "Wrote $path"
}

hdr "Writing files"
write_file "$WF_PATH" "$WF" || true
if [ "$WRITE_CONFIG" = "1" ]; then
  write_file "$CONFIG_PATH" "$CONFIG_BODY" || true
else
  info "Skipping $CONFIG_PATH (--no-config); Yama will use built-in defaults."
fi

# =============================================================================
# Guided next steps — the things this script deliberately does NOT do for you.
# =============================================================================
ALL_SECRETS=("YAMA_GITHUB_TOKEN" "${REQUIRED_SECRETS[@]}")

hdr "✅ Code changes done. Now finish the setup:"

cat <<EOF

${C_BOLD}1) Add the repository secrets${C_RESET}  (Settings → Secrets and variables → Actions)

   ${C_BOLD}YAMA_GITHUB_TOKEN${C_RESET} must be a ${C_BOLD}real GitHub PAT${C_RESET} (NOT the default Actions
   GITHUB_TOKEN — the hosted GitHub MCP endpoint rejects it). Use a fine-grained
   PAT with "Pull requests: Read and write" + "Contents: Read", or a classic PAT
   with the \`repo\` scope.

   With the gh CLI:
EOF
for s in "${ALL_SECRETS[@]}"; do
  printf '     %s\n' "${C_DIM}gh secret set $s${C_RESET}"
done
cat <<EOF

   (You can also set them in the GitHub UI. Provider creds for ${C_BOLD}$PROVIDER${C_RESET}:
   ${REQUIRED_SECRETS[*]})

${C_BOLD}2) (Optional) Make Yama a required check${C_RESET} so a BLOCKED verdict gates merges.
   The check context is exactly: ${C_BOLD}$NAME${C_RESET}
   In GitHub: Settings → Branches → the protection rule for your branch →
   "Require status checks to pass" → add a check named exactly "$NAME".
   (It only appears in that list once the workflow has run at least once on a PR.)
EOF
if [ -f .github/settings.yml ]; then
  cat <<EOF
   This repo also has .github/settings.yml (Probot Settings app) — you can instead
   add "$NAME" to required_status_checks.contexts for your protected branch(es):

       required_status_checks:
         contexts:
           - "$NAME"
EOF
fi
cat <<EOF

${C_BOLD}3) Review & ship the change${C_RESET}
   • Review the generated $WF_PATH$( [ "$WRITE_CONFIG" = "1" ] && printf ' and %s' "$CONFIG_PATH" ).
$( [ "$WRITE_CONFIG" = "1" ] && printf '   • Tune %s — the TODO-marked focusAreas / blockingCriteria define\n     what Yama actually catches and blocks on.' "$CONFIG_PATH" )
   • Commit and open a PR (or merge to your default branch) — your call.
     The workflow runs on PRs targeting: ${C_BOLD}$BRANCHES_YAML${C_RESET}.

${C_DIM}Notes: the action self-builds (~2–3 min) on first run. Fork PRs and runs with
missing secrets are skipped cleanly so the check never deadlocks merges.${C_RESET}
EOF

[ -n "$DRY_RUN" ] && warn "DRY RUN complete — no files were written."
exit 0
