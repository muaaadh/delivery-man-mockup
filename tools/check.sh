#!/usr/bin/env bash
# Forbidden-pattern scan (SPEC §5). Greps every shipped *.html / *.js / *.css file for the things the spec bans and prints each
# offending line as file:line: text. Exits 1 when anything is found, 0 (printing nothing) when the tree is clean.
# Usage: tools/check.sh [root]   (default: the repo root)
# Skipped: js/roads.js (generated data), node_modules, .git, docs, tools (Node scripts legitimately use console.log).
set -u
ROOT="${1:-$(cd "$(dirname "$0")/.." && pwd)}"
cd "$ROOT" || exit 2
GREP=/usr/bin/grep
[ -x "$GREP" ] || GREP=grep

FILES=$(find . \( -path ./node_modules -o -path ./.git -o -path ./docs -o -path ./tools \) -prune -o -type f \( -name '*.html' -o -name '*.js' -o -name '*.css' \) -print | $GREP -v '/js/roads\.js$' | sort)
PAGE_FILES=$(printf '%s\n' "$FILES" | $GREP -E '\.(html|js)$')
FOUND=0

report() {   # report <label> <matches>
  if [ -n "$2" ]; then
    FOUND=1
    printf '%s\n' "$2" | sed "s|^\./||; s|^|[$1] |"
  fi
}

scan() {     # scan <label> <grep flags> <pattern> <files>
  local label="$1" flags="$2" pattern="$3" files="$4"
  [ -z "$files" ] && return
  # shellcheck disable=SC2086
  report "$label" "$(printf '%s\n' $files | xargs $GREP -n $flags -e "$pattern" 2>/dev/null)"
}

scan 'console.log'     -E 'console\.(log|debug|info|warn|error|table)\('               "$FILES"
scan 'todo'            -E '\b(TODO|FIXME|XXX|TBC)\b'                                 "$FILES"
scan 'lorem'           -Ei 'lorem|ipsum'                                             "$FILES"
scan 'root-href'       -E "(href|src|action)=[\"']/([^/]|$)"                         "$FILES"
# "$1" inside a .replace() call is a capture group, not a price; everything else that reads $ + digit is a dollar amount.
report 'dollar-amount' "$(printf '%s\n' $FILES | xargs $GREP -nE '\$[0-9]' 2>/dev/null | $GREP -v 'replace(')"
scan 'uppercase'       -Ei 'text-transform:[[:space:]]*uppercase|font-variant:[[:space:]]*small-caps' "$FILES"
scan 'superlative'     -Ei '\b(seamless(ly)?|effortless(ly)?|elevate|unleash|revolutioni[sz]e|supercharge|cutting-edge|world-class)\b' "$FILES"
scan 'generic-link'    -E '\b(Learn more|Get started|Read more|Click here)\b'             "$PAGE_FILES"
scan 'module-script'   -E 'type="module"|crypto\.randomUUID\('                        "$PAGE_FILES"
scan 'native-dialogs'  -E '(^|[^.[:alnum:]_])(alert|prompt)\(|window\.(alert|prompt|confirm)\(' "$PAGE_FILES"

# Em dashes in JS/HTML strings (the <title> line is the one place allowed; // comments are ignored) and emoji anywhere.
if [ -n "$PAGE_FILES" ]; then
  report 'em-dash' "$(printf '%s\n' $PAGE_FILES | xargs perl -CSD -ne '(my $t = $_) =~ s{^\s*(//|\*|/\*).*}{}; $t =~ s{(^|[^:])//.*$}{$1}; print "$ARGV:$.: $_" if $t =~ /\x{2014}/ && !/<title>/; close ARGV if eof' 2>/dev/null)"
fi
report 'emoji' "$(printf '%s\n' $FILES | xargs perl -CSD -ne 'print "$ARGV:$.: $_" if /[\x{1F000}-\x{1FAFF}\x{2600}-\x{27BF}\x{2B00}-\x{2BFF}\x{FE0F}\x{1F1E6}-\x{1F1FF}]/; close ARGV if eof' 2>/dev/null)"

exit $FOUND
