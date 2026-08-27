#!/usr/bin/env bash
# worktree-probe.sh — read-only survey of how this repository behaves when
# several git worktrees of it exist at once. Prints findings; changes nothing.
#
#   bash worktree-probe.sh [repo-dir]
#
# Findings are prefixed:
#   [!!]  breaks a parallel worktree, or corrupts shared state
#   [? ]  suspicious — confirm in the file before acting
#   [ok]  checked, nothing to do
#   [--]  context, no judgement
#
# Pattern matching cannot see everything (a service that must already be
# running, an account that must exist). Treat a clean run as "no *detectable*
# problems", and read the repo's own setup docs too.
set -u

repo_arg="${1:-.}"
cd "$repo_arg" 2>/dev/null || { echo "worktree-probe: no such directory: $repo_arg" >&2; exit 1; }

root="$(git rev-parse --show-toplevel 2>/dev/null || true)"
[ -n "$root" ] || { echo "worktree-probe: not inside a git repository" >&2; exit 1; }
cd "$root"

bad() { printf '[!!] %s\n' "$*"; }
sus() { printf '[? ] %s\n' "$*"; }
ok()  { printf '[ok] %s\n' "$*"; }
inf() { printf '[--] %s\n' "$*"; }
sec() { printf '\n== %s ==\n' "$*"; }
has() { command -v "$1" >/dev/null 2>&1; }
# Tracked-file grep: extended regex, no binaries, no lockfiles. A caller may add
# its own pathspec exclusions after a "--" and they are MERGED with these rather
# than emitted as a second "--", which git grep silently matches nothing for.
tg() {
  local args=() specs=() seen=0 a
  for a in "$@"; do
    if [ "$a" = "--" ] && [ "$seen" = 0 ]; then seen=1; continue; fi
    if [ "$seen" = 1 ]; then specs+=("$a"); else args+=("$a"); fi
  done
  git grep -nIE "${args[@]}" -- ':!*lock*' ':!*.lock' ':!*.min.*' \
    ${specs[@]+"${specs[@]}"} 2>/dev/null
}
size_of() { [ -e "$1" ] && du -sh "$1" 2>/dev/null | cut -f1 || true; }
# indent + truncate: findings are pointers to a file, not the file's contents
cite() { sed 's/^/     /' | cut -c1-160; }

echo "worktree-probe — $root"

# --------------------------------------------------------------- context ---
sec "Context"
common="$(git rev-parse --git-common-dir 2>/dev/null || echo '?')"
gitdir="$(git rev-parse --git-dir 2>/dev/null || echo '?')"
if [ "$(git rev-parse --is-inside-work-tree 2>/dev/null)" = "true" ] && [ "$common" != "$gitdir" ]; then
  inf "Running inside a LINKED worktree (.git is a file). git-dir=$gitdir common=$common"
else
  inf "Running inside the main checkout. git-dir=$gitdir"
fi
n_wt="$(git worktree list 2>/dev/null | wc -l | tr -d ' ')"
inf "Worktrees that exist now: $n_wt"
git worktree list 2>/dev/null | head -5 | cite
[ "${n_wt:-0}" -gt 5 ] && echo "     … $((n_wt - 5)) more (each one is a full copy of the working tree on disk)"

# ------------------------------------------- 1. untracked-but-needed files ---
sec "1. Files a fresh worktree will not have"
ignored="$(git status --porcelain --ignored=matching 2>/dev/null | sed -n 's/^!! //p' || true)"
config_like="$(printf '%s\n' "$ignored" | grep -Ei '(^|/)(\.env($|\.)|\.envrc|.*\.local\.(js|ts|json|ya?ml|toml|ini|env)$|local\.(json|ya?ml|toml|ini|py|rb)$|secrets?\.|credentials|.*\.(pem|key|p12|pfx|jks|crt|cer)$|.*\.tfvars$|CLAUDE\.md$|AGENTS\.md$)' | grep -v '/$' | head -30 || true)"
if [ -n "${config_like:-}" ]; then
  bad "gitignored config/secret files present here — none of them exist in a new worktree:"
  printf '%s\n' "$config_like" | cite
  for e in .env.example .env.sample .env.template env.example .env.dist; do
    [ -f "$e" ] && break
    [ "$e" = .env.dist ] && bad "  …and nothing committed shows what belongs in them"
  done
else
  ok "no gitignored config- or secret-looking files in this checkout"
fi

# Which of them does the code actually read?
env_names="$(tg -o '\b(process\.env\.[A-Z0-9_]+|env\.[A-Z0-9_]{4,}|os\.environ(\.get)?\[?.[A-Z0-9_]+|ENV\[.[A-Z0-9_]+|getenv\(.[A-Z0-9_]+)' 2>/dev/null | grep -oE '[A-Z][A-Z0-9_]{3,}' | sort -u || true)"
n_env="$(printf '%s\n' "$env_names" | grep -c . || true)"
example=""
for f in .env.example .env.sample .env.template env.example .env.dist; do
  [ -f "$f" ] && example="$f" && break
done
if [ "${n_env:-0}" -gt 0 ]; then
  inf "code reads $n_env distinct environment variables"
  if [ -n "$example" ]; then
    missing="$(printf '%s\n' "$env_names" | while read -r v; do
      [ -n "$v" ] || continue
      grep -qE "^[# ]*${v}=" "$example" 2>/dev/null || echo "$v"
    done | grep -vE '^(NODE_ENV|CI|HOME|PATH|PWD|USER|SHELL|TERM|TMPDIR|TEMP|LANG|LC_.*|PORT|DEBUG|VERBOSE|LOG_LEVEL|HOSTNAME|COMSPEC|COLUMNS|LINES|FORCE_COLOR|NO_COLOR|EDITOR|npm_.*|GIT_.*|ELECTRON_.*)$' || true)"
    if [ -n "${missing:-}" ]; then
      n_missing="$(printf '%s\n' "$missing" | grep -c . || true)"
      sus "$example does not mention $n_missing variable(s) the code reads:"
      printf '%s\n' "$missing" | head -12 | cite
      [ "${n_missing:-0}" -gt 12 ] && echo "     … $((n_missing - 12)) more"
      echo "     Some are injected by the platform or optional — check the ones that gate startup."
      echo "     An example missing the vars that matter is how this bug survives its own fix."
    else
      ok "$example covers every environment variable found in the code"
    fi
  else
    bad "no .env.example (or equivalent) committed, but the code reads env vars"
  fi
fi

# ------------------------------------------------------- 2. dependencies ---
sec "2. Per-worktree dependency cost"
declare_dep() { [ -f "$1" ] && inf "$2  (manifest: $1${3:+, installs into $3})"; }
found_dep=0
for pair in \
  "pnpm-lock.yaml|Node / pnpm|node_modules" \
  "yarn.lock|Node / yarn|node_modules" \
  "package-lock.json|Node / npm|node_modules" \
  "bun.lockb|Node / bun|node_modules" \
  "uv.lock|Python / uv|.venv" \
  "poetry.lock|Python / poetry|" \
  "Pipfile.lock|Python / pipenv|" \
  "requirements.txt|Python / pip|.venv" \
  "go.sum|Go|" \
  "Cargo.lock|Rust / cargo|target" \
  "Gemfile.lock|Ruby / bundler|vendor/bundle" \
  "composer.lock|PHP / composer|vendor" \
  "gradle/libs.versions.toml|JVM / gradle|build" \
  "pom.xml|JVM / maven|target" \
  "packages.lock.json|.NET|obj"; do
  f="${pair%%|*}"; rest="${pair#*|}"; label="${rest%%|*}"; dir="${rest#*|}"
  if [ -f "$f" ]; then found_dep=1; declare_dep "$f" "$label" "$dir"
    if [ -n "$dir" ] && [ -e "$dir" ]; then
      s="$(size_of "$dir")"
      [ -n "$s" ] && inf "    $dir is currently $s — every worktree pays that again"
    fi
  fi
done
[ "$found_dep" = 0 ] && ok "no dependency lockfile found at the repo root"

if [ -f pnpm-workspace.yaml ] || grep -q '"workspaces"' package.json 2>/dev/null; then
  inf "this repo is a package-manager WORKSPACE root"
  echo "     A worktree placed INSIDE it corrupts this checkout's node_modules."
  echo "     Calandria puts worktrees outside the repo, so this is fine there —"
  echo "     but check any other worktree tooling the user runs."
fi
if [ -f pnpm-lock.yaml ]; then
  if grep -qE 'virtualStoreType:\s*global|enableGlobalVirtualStore:\s*true' pnpm-workspace.yaml .npmrc 2>/dev/null; then
    ok "pnpm global virtual store enabled — per-worktree install is near-free"
  else
    sus "pnpm without a global virtual store: set virtualStoreType: global to make worktree installs near-free"
  fi
fi

# -------------------------------------------------------------- 3. ports ---
sec "3. Ports"
port_hits="$(tg -e '(:|=|\s|\(|,)(300[0-9]|3[1-9][0-9]{2}|4[0-9]{3}|5[0-9]{3}|8[0-9]{3}|9[0-9]{3})\b' \
  -- ':!*.md' ':!*.snap' ':!*.svg' 2>/dev/null | grep -vE 'process\.env|import\.meta\.env|os\.environ|getenv|\$\{?[A-Z_]*PORT|ENV\[' | head -40 || true)"
if [ -n "${port_hits:-}" ]; then
  n="$(printf '%s\n' "$port_hits" | wc -l | tr -d ' ')"
  sus "literal port numbers in $n tracked line(s) — each one is a collision between two tasks:"
  printf '%s\n' "$port_hits" | head -20 | cite
  [ "$n" -gt 20 ] && echo "     … $((n - 20)) more"
else
  ok "no literal port numbers found in tracked source"
fi
if tg -q -e 'process\.env\.PORT|os\.environ.{1,3}PORT|ENV\[.PORT|getenv\(.PORT' >/dev/null 2>&1; then
  ok "something already honors \$PORT"
else
  bad "nothing reads \$PORT — an agent in a worktree has no way to move the server off a busy port"
fi
if tg -q -e 'listen\((0|[\"'"'"']0[\"'"'"'])' >/dev/null 2>&1 || tg -q -e 'port\s*=\s*0\b' >/dev/null 2>&1; then
  ok "something binds port 0 (ephemeral) — good sign for the test suite"
else
  sus "no ephemeral (port 0) binding found; check whether tests bind a fixed port"
fi

# ------------------------------------------ 4. shared state outside the repo ---
sec "4. Shared mutable state outside the repo"
compose="$(ls docker-compose.y*ml compose.y*ml 2>/dev/null | head -3 || true)"
if [ -n "${compose:-}" ]; then
  inf "compose files: $(echo $compose | tr '\n' ' ')"
  named_project=0
  grep -qE '^\s*name:' $compose 2>/dev/null && named_project=1
  grep -rq 'COMPOSE_PROJECT_NAME' .env .envrc Makefile justfile 2>/dev/null && named_project=1
  if [ "$named_project" = 1 ]; then
    ok "a compose project name is set explicitly"
  else
    bad "no COMPOSE_PROJECT_NAME / top-level 'name:' — two worktrees share containers, networks and volumes"
  fi
  cn="$(grep -nE '^\s*container_name:' $compose 2>/dev/null | grep -v '\${' | head -10 || true)"
  [ -n "${cn:-}" ] && bad "literal container_name: defeats per-worktree namespacing:" && printf '%s\n' "$cn" | cite
  pb="$(grep -nE '^\s*-\s*"?[0-9]{2,5}:[0-9]{2,5}"?\s*$' $compose 2>/dev/null | head -10 || true)"
  [ -n "${pb:-}" ] && bad "fixed host port bindings — the second worktree's stack will not start:" && printf '%s\n' "$pb" | cite
  vol="$(sed -n '/^volumes:/,/^[a-z]/p' $compose 2>/dev/null | grep -E '^\s{2}[a-z0-9_-]+:' | head -10 || true)"
  if [ -n "${vol:-}" ]; then
    if [ "$named_project" = 1 ]; then
      inf "named volumes exist; the compose project name is what keeps them apart per worktree"
    else
      bad "named volumes are shared by every worktree while the project name is the default:"
      printf '%s\n' "$vol" | cite
    fi
  fi
else
  ok "no docker compose file"
fi

db="$(tg -e '(postgres|postgresql|mysql|mariadb|mongodb|redis|amqp)://[^\"'"'"'` ]*' -- ':!*.md' ':!docs/**' 2>/dev/null | grep -vE '\$\{|process\.env|os\.environ|getenv|ENV\[' | head -10 || true)"
[ -n "${db:-}" ] && bad "hardcoded database/broker URLs — every worktree writes to the same instance:" && printf '%s\n' "$db" | cite
sqlite="$(tg -e '[\"'"'"'`][^\"'"'"'`]*\.(sqlite3?|db)[\"'"'"'`]' -- ':!*.md' ':!docs/**' 2>/dev/null | head -10 || true)"
[ -n "${sqlite:-}" ] && sus "SQLite file paths — a fixed one is a shared writable file across worktrees:" && printf '%s\n' "$sqlite" | cite
tmp="$(tg -e '[\"'"'"'`](/tmp/|/var/tmp/|~/\.cache/|\$HOME/)[a-zA-Z0-9._-]+' -- ':!*.md' ':!docs/**' ':!tests/**' ':!*test*' 2>/dev/null | head -10 || true)"
[ -n "${tmp:-}" ] && sus "fixed paths outside the repo (locks, sockets, caches) are shared state:" && printf '%s\n' "$tmp" | cite
[ -z "${db:-}${sqlite:-}${tmp:-}" ] && ok "no hardcoded database URLs or fixed out-of-repo paths found"

# --------------------------------------- 5. .git-is-a-directory assumptions ---
sec "5. Assumptions that .git is a directory"
gitpath="$(tg -e '[^a-zA-Z0-9_.-]\.git/' -- ':!.gitignore' ':!*.md' 2>/dev/null | head -15 || true)"
if [ -n "${gitpath:-}" ]; then
  bad "literal .git/ paths — in a worktree .git is a FILE pointing outside the worktree:"
  printf '%s\n' "$gitpath" | cite
  echo "     Use git rev-parse --git-dir / --git-common-dir / --git-path instead."
else
  ok "no literal .git/ paths in tracked files"
fi
if tg -q -e 'git rev-parse --git-common-dir' >/dev/null 2>&1; then
  ok "something already resolves the common git dir"
fi
mnt="$(tg -e '(-v|--volume|--mount)[^\n]*:/[a-z]' -- ':!*.md' 2>/dev/null | head -8 || true)"
[ -n "${mnt:-}" ] && sus "bind mounts of the checkout: git inside the container cannot follow a worktree's .git file:" && printf '%s\n' "$mnt" | cite

# ------------------------------------------- 6. submodules, LFS, hooks ---
sec "6. Submodules, LFS, hooks"
if [ -f .gitmodules ]; then
  bad "submodules present — a new worktree leaves them uninitialized; bootstrap must run git submodule update --init --recursive"
  grep -E '^\s*path' .gitmodules | cite
else
  ok "no submodules"
fi
if grep -q 'filter=lfs' .gitattributes 2>/dev/null; then
  sus "git-lfs tracked files — each worktree materializes its OWN full copy of every blob; nothing dedupes it"
else
  ok "no git-lfs"
fi
hp="$(git config --get core.hooksPath 2>/dev/null || true)"
[ -n "${hp:-}" ] && inf "core.hooksPath = $hp (shared with the main repo; worktree tooling has been known to overwrite it)"
if grep -qE '"prepare"\s*:' package.json 2>/dev/null; then
  inf "package.json has a prepare script (husky/lefthook?) — it has not run in a fresh worktree until deps are installed"
fi

# ---------------------------------------------------- 7. bootstrap story ---
sec "7. Bootstrap"
boot=""
grep -qE '^(bootstrap|setup|init|dev-setup):' Makefile 2>/dev/null && boot="make <target from Makefile>"
grep -qiE '^(bootstrap|setup|init):' justfile Justfile 2>/dev/null && boot="${boot:+$boot / }just <target>"
grep -qE '"(setup|bootstrap|prepare|postinstall)"\s*:' package.json 2>/dev/null && boot="${boot:+$boot / }npm run <script from package.json>"
for f in scripts/setup.sh scripts/bootstrap.sh bin/setup script/setup setup.sh; do
  [ -x "$f" ] && boot="${boot:+$boot / }$f"
done
if [ -n "$boot" ]; then
  ok "a bootstrap entry point exists: $boot"
else
  bad "no single bootstrap command found — nothing prepares a bare checkout, and no orchestrator hook will"
fi
named=0
for f in AGENTS.md CLAUDE.md README.md CONTRIBUTING.md; do
  [ -f "$f" ] || continue
  if grep -qiE '(bootstrap|first[- ]run|fresh (checkout|clone|worktree)|npm (ci|install)|make setup|just setup)' "$f" 2>/dev/null; then
    ok "$f tells a fresh checkout what to run first"; named=1; break
  fi
done
[ "$named" = 0 ] && bad "neither AGENTS.md nor CLAUDE.md says what to run in a fresh checkout — the agent's first turn has to guess"
[ -f AGENTS.md ] || sus "no AGENTS.md — Codex sessions read that file, not CLAUDE.md"
[ -f CLAUDE.md ] || sus "no CLAUDE.md — Claude Code sessions read that file, not AGENTS.md"

sec "Done"
echo "Confirm each [!!] and [? ] in the file it names before proposing a change."
