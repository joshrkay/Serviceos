#!/bin/zsh
R=joshrkay/Serviceos; LOG=/Users/joshuakay/.claude/jobs/c58f3967/tmp/merge-chain-1094.log
for i in $(seq 1 120); do grep -q '#1094 MERGED' $LOG 2>/dev/null && break; grep -q 'chain done' $LOG 2>/dev/null && { echo "chain ended without merge"; exit 1; }; sleep 60; done
grep -q '#1094 MERGED' $LOG || { echo "timeout waiting for merge"; exit 1; }
MC=$(gh pr view 1094 -R $R --json mergeCommit --jq '.mergeCommit.oid[0:9]'); MT=$(gh pr view 1094 -R $R --json mergedAt --jq .mergedAt); echo "1094 merged $MC at $MT"
for pr in 1085 1087; do st=$(gh pr view $pr -R $R --json state --jq .state); gh pr comment $pr -R $R --body "Merged to \`main\` via batch PR #1094 (merge commit $MC, $MT) at the head this PR carried when the batch was cut (see #1094's table). The gate section, evidence page and PRD stamps above stand as recorded. Closing as merged-via-batch." >/dev/null; [ "$st" = "OPEN" ] && gh pr close $pr -R $R >/dev/null && echo "closed #$pr" || echo "#$pr already $st"; done
for t in 1012 1022 1014 1025 1017; do gh issue comment $t -R $R --body "**Landed on \`main\`:** the gated lane branches noted above merged via batch PR #1094 → merge commit $MC ($MT); their rung transitions and PRD stamps are now on \`origin/main\` (batch 5 carries the owner-surfaces and public-surfaces rung-5 lanes (rows 4.1, 4.2, 4.4, 1.2, 1.11, 7.6, 8.4, 2.9) and the dormant lane's 4.7 timezone pin)." >/dev/null && echo "noted #$t"; done
echo "post-merge done"
