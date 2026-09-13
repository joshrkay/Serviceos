#!/bin/zsh
# usage: merge-chain.sh <pr> [<pr> ...]  — sequential merge-when-green with update-branch retries; never --admin
R=joshrkay/Serviceos
for N in "$@"; do
  for attempt in 1 2 3 4 5 6 7 8; do
    st=$(gh pr view $N -R $R --json state,mergeStateStatus --jq '"\(.state) \(.mergeStateStatus)"' 2>&1)
    echo "#$N attempt $attempt: $st"
    case "$st" in
      MERGED*) echo "#$N MERGED $(gh pr view $N -R $R --json mergeCommit --jq '.mergeCommit.oid[0:9]')"; break;;
      "OPEN BEHIND") gh pr update-branch $N -R $R 2>&1 | tail -1; sleep 90;;
      "OPEN DIRTY") echo "#$N DIRTY (conflicts) — stopping this PR"; break;;
      OPEN*)
        gh pr checks $N -R $R --watch --fail-fast -i 30 >/dev/null 2>&1; rc=$?
        if [ $rc -ne 0 ]; then echo "#$N checks not green rc=$rc: $(gh pr checks $N -R $R 2>&1 | grep -E '\tfail\t' | cut -f1 | tr '\n' ',')"; sleep 120; continue; fi
        out=$(gh pr merge $N -R $R --merge 2>&1); echo "$out" | grep -vE '^\s*$' | tail -2
        if gh pr view $N -R $R --json state --jq .state | grep -q MERGED; then echo "#$N MERGED $(gh pr view $N -R $R --json mergeCommit --jq '.mergeCommit.oid[0:9]')"; break; fi
        sleep 45;;
      *) sleep 60;;
    esac
  done
done
echo "chain done: $*"
