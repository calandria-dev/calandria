#!/usr/bin/env bash
# Install the skills bundled in this repo (skills/*/SKILL.md) where a coding
# agent will actually find them.
#
#   scripts/install-skills.sh [--project DIR] [--agent claude|codex|both]
#                             [--link] [--force] [--list] [SKILL…]
#
# Claude Code and Codex read the SAME SKILL.md format but scan DIFFERENT
# directories, so one skill has to land in two places:
#
#   Claude Code   ~/.claude/skills/<name>/      or  <repo>/.claude/skills/<name>/
#   Codex         ~/.agents/skills/<name>/      or  <repo>/.agents/skills/<name>/
#
# Default is user scope: every project you open gets the skill and no
# repository grows a file it didn't ask for. Use --project to commit it into
# one repo instead, when the whole team should have it.
#
# Copies by default instead of symlinking: a symlink is nicer to keep current
# but does not survive a Windows checkout without Developer Mode, and a
# missing skill is worse than one that's a version behind. --link
# opts in.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
src="$here/skills"

scope_dir="$HOME"
agent="both"
mode="copy"
force=0
list_only=0
wanted=()

die() { echo "install-skills: $*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --project) shift; [ $# -gt 0 ] || die "--project needs a directory"
               scope_dir="$(cd "$1" 2>/dev/null && pwd)" || die "no such directory: $1"; shift ;;
    --project=*) scope_dir="$(cd "${1#*=}" 2>/dev/null && pwd)" || die "no such directory: ${1#*=}"; shift ;;
    --agent) shift; agent="${1:-}"; shift ;;
    --agent=*) agent="${1#*=}"; shift ;;
    --link) mode="link"; shift ;;
    --force) force=1; shift ;;
    --list) list_only=1; shift ;;
    -h|--help) sed -n '2,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) die "unknown option: $1" ;;
    *) wanted+=("$1"); shift ;;
  esac
done

case "$agent" in claude|codex|both) ;; *) die "--agent must be claude, codex or both" ;; esac
[ -d "$src" ] || die "no skills/ directory at $src"

available=()
for d in "$src"/*/; do
  [ -f "$d/SKILL.md" ] || continue
  available+=("$(basename "$d")")
done
[ ${#available[@]} -gt 0 ] || die "skills/ contains no SKILL.md"

if [ "$list_only" = 1 ]; then
  for name in "${available[@]}"; do
    desc="$(sed -n '/^description:/{s/^description: *//;p;q;}' "$src/$name/SKILL.md")"
    printf '%s\n    %s\n' "$name" "${desc:0:120}"
  done
  exit 0
fi

if [ ${#wanted[@]} -eq 0 ]; then wanted=("${available[@]}"); fi

targets=()
case "$agent" in
  claude) targets=("$scope_dir/.claude/skills") ;;
  codex)  targets=("$scope_dir/.agents/skills") ;;
  both)   targets=("$scope_dir/.claude/skills" "$scope_dir/.agents/skills") ;;
esac

for name in "${wanted[@]}"; do
  [ -f "$src/$name/SKILL.md" ] || die "no skill named '$name' in skills/ (try --list)"
  for base in "${targets[@]}"; do
    dest="$base/$name"
    if [ -e "$dest" ] || [ -L "$dest" ]; then
      if [ "$force" = 1 ]; then rm -rf "$dest"
      else echo "skip  $dest (already exists; --force to replace)"; continue; fi
    fi
    mkdir -p "$base"
    if [ "$mode" = link ]; then
      ln -s "$src/$name" "$dest"
      echo "link  $dest -> $src/$name"
    else
      cp -R "$src/$name" "$dest"
      echo "copy  $dest"
    fi
  done
done

echo
echo "Restart the agent session (or start a new task) so it rescans its skill directories."
