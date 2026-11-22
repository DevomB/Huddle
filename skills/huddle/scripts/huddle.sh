#!/usr/bin/env bash
# huddle: seats and inboxes for one person's agents, plus the communicator's watch on GitHub.
#   join [seat]               take a seat: the first session is lead (the communicator), the rest w1, w2...
#   who                       list seats; "waiting" means that agent is free and listening
#   send <from> <to> <text>   put a message in another seat's inbox
#   wait <seat> [seconds]     block until the inbox has mail, print it, exit (for lead, GitHub news is mail)
#   say <issue> <text>        lead only: comment on an issue, marked as written by an agent
set -euo pipefail
H=$(git rev-parse --git-common-dir) # fails here when not in a git repo
H=$(cd "$H/.." && pwd)/.huddle
G=$H/lead/.gh
TEAM='test("^(OWNER|MEMBER|COLLABORATOR)$")' # only people with access to the repo get through to an agent
die() { echo "huddle: $*" >&2; exit 1; }

put() { # from to text
  [ -d "$H/$2" ] || die "no seat '$2'"
  printf '%s\n' "$3" > "$H/$2/.$1.$$" && mv "$H/$2/.$1.$$" "$H/$2/$(date -u +%Y%m%d%H%M%S).$$.$1"
}

who() {
  for d in "$H"/lead "$H"/w[0-9]*; do
    [ -d "$d" ] || continue
    if [ -n "$(find "$d/.wait" -mmin -1 2>/dev/null)" ]; then echo "${d##*/} waiting"; else echo "${d##*/} busy"; fi
  done
}

# Both watchers print what is new and move a cursor kept in $G, so nothing is shown twice or missed
# between runs. The cursors are GitHub's own ids and timestamps, never this machine's clock.
# A comment's later lines are indented, so no comment can fake a cursor line or another comment's header.
comments() {
  local last since
  read -r last since < "$G/comments"
  gh api "repos/$(cat "$G/repo")/issues/comments?sort=created&direction=asc&per_page=100&since=$since" --jq '
    .[] | select(.id > '"$last"') | "\(.id) \(.created_at)",
    (select(.user.type != "Bot" and (.author_association | '"$TEAM"')
       and ((.user.login == "'"$(cat "$G/login")"'" and (.body | startswith("[agent]"))) | not))
     | "#\(.issue_url | split("/") | last) @\(.user.login): \(.body | gsub("\r"; "") | gsub("\n"; "\n  "))")' |
    while IFS= read -r l; do
      case $l in [0-9]*) echo "$l" > "$G/comments" ;; *) printf '%s\n' "$l" ;; esac
    done
}

issues() { # $1: --paginate on the first pass. The cursor trails a minute because GitHub's issue list lags
  gh api ${1-} "repos/$(cat "$G/repo")/issues?state=all&sort=updated&direction=asc&per_page=100&since=$(cat "$G/since")" --jq '
    .[] | "\(.number)\t\(.updated_at | fromdateiso8601 - 60 | todate)\t" + (if .pull_request or (.author_association | '"$TEAM"' | not) then ""
      else "\(.state) [\([.assignees[].login] | join(","))] \(.title)" end)' |
    while IFS=$'\t' read -r n t line; do
      echo "$t" > "$G/since"
      [ -z "$line" ] || [ "$(cat "$G/issues/$n" 2>/dev/null)" = "$line" ] || { echo "$line" > "$G/issues/$n"; echo "#$n $line"; }
    done
}

case ${1-} in
join)
  mkdir -p "$H" && echo '*' > "$H/.gitignore"
  me=${2-}
  if [ -z "$me" ]; then
    if mkdir "$H/lead" 2>/dev/null; then me=lead; else
      n=1; until mkdir "$H/w$n" 2>/dev/null; do n=$((n + 1)); done; me=w$n
    fi
  fi
  case $me in lead | w[0-9]*) mkdir -p "$H/$me" ;; *) die "seats are lead, w1, w2..." ;; esac
  if [ "$me" = lead ] && [ ! -f "$G/since" ]; then # start watching from now
    mkdir -p "$G/issues"
    { gh repo view --json nameWithOwner --jq .nameWithOwner > "$G/repo" && gh api user --jq .login > "$G/login" &&
      gh api "repos/$(cat "$G/repo")/issues/comments?sort=created&direction=desc&per_page=1" \
        --jq '(.[0] // {id: 0, created_at: "2000-01-01T00:00:00Z"}) | "\(.id) \(.created_at)"' > "$G/comments" &&
      echo 2000-01-01T00:00:00Z > "$G/since" && issues --paginate > /dev/null; } ||
      { rm -rf "$H/lead"; die "the communicator needs gh logged in and a GitHub origin: check 'gh auth status'"; }
  fi
  [ "$me" = lead ] || [ ! -d "$H/lead" ] || put "$me" lead joined
  echo "you are $me"; who ;;
who) who ;;
send) put "${2:?from}" "${3:?to}" "${*:4}" ;;
say) gh issue comment "${2:?issue}" -R "$(cat "$G/repo")" --body "[agent] ${*:3}" ;;
wait)
  me=${2:?seat}; d=$H/$me; [ -d "$d" ] || die "no seat '$me': run join first"
  tok=$$.$RANDOM; echo "$tok" > "$d/.wait"
  trap '[ "$(cat "$d/.wait" 2>/dev/null)" != "$tok" ] || rm -f "$d/.wait"' EXIT
  end=$(($(date +%s) + ${3:-3000})); n=0; fails=0
  while [ "$(cat "$d/.wait" 2>/dev/null)" = "$tok" ]; do
    touch "$d/.wait"
    if [ "$me" = lead ] && [ $((n % 15)) = 0 ]; then # every 30 s
      if { comments && issues; } > "$d/.news" 2> "$G/err"; then fails=0; else fails=$((fails + 1)); fi
      if [ -s "$d/.news" ]; then mv "$d/.news" "$d/$(date -u +%Y%m%d%H%M%S).$$.github"; fi
      [ $fails -lt 10 ] || die "GitHub watch keeps failing: $(cat "$G/err")"
    fi
    set -- "$d"/*
    if [ -e "$1" ]; then
      for f; do echo "--- from ${f##*.}"; cat "$f"; rm "$f"; done
      exit 0
    fi
    [ "$(date +%s)" -lt "$end" ] || { echo "nothing new"; exit 0; }
    sleep 2; n=$((n + 1))
  done
  echo "another session is now waiting as $me" ;;
*) sed -n '2,7s/^# //p' "$0" ;;
esac
