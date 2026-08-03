#!/usr/bin/env bash
# Demonstrate the drag-and-drop synthesis flow with two task bundles that
# share a seed file, proving store-level dedup across bundles.
set -euo pipefail
cd "$(dirname "$0")"
rm -rf drops bundles store

mkdir -p drops/expense_audit drops/log_triage

cat > drops/expense_audit/expenses.csv << 'EOF'
date,employee,category,amount,receipt
2026-05-02,jkim,travel,1240.50,yes
2026-05-03,mchen,meals,842.00,no
2026-05-03,jkim,meals,61.20,yes
2026-05-07,rpatel,equipment,2999.99,no
2026-05-09,mchen,travel,310.75,yes
EOF
cat > drops/expense_audit/policy.txt << 'EOF'
Expense policy v3:
- Meals over $75 require a receipt.
- Equipment over $1000 requires manager pre-approval noted in the report.
- All travel requires a receipt regardless of amount.
EOF

cat > drops/log_triage/service.log << 'EOF'
2026-06-01T10:02:11Z INFO  api    request ok path=/v1/rollouts
2026-06-01T10:02:14Z ERROR api    db timeout after 30s path=/v1/rollouts
2026-06-01T10:02:15Z ERROR api    db timeout after 30s path=/v1/rollouts
2026-06-01T10:04:02Z WARN  worker retry queue depth=1204
2026-06-01T10:05:44Z ERROR api    db timeout after 30s path=/v1/grades
EOF
# Same policy file dropped into a second, unrelated task:
cp drops/expense_audit/policy.txt drops/log_triage/policy.txt

python3 synth_task.py --files drops/expense_audit \
  --description "Audit these expense reports against the policy and produce violations.csv listing each violating row and the rule it breaks." \
  --name expense_audit --store ./store --out bundles/expense_audit

python3 synth_task.py --files drops/log_triage \
  --description "Triage this service log: identify the dominant failure, when it started, and write an incident_summary.md; check the policy file for any reporting requirements." \
  --name log_triage --store ./store --out bundles/log_triage

echo
echo "seed files across bundles: $(ls drops/*/* | wc -l)"
echo "unique objects in store:   $(find store/objects -type f | wc -l)  (dedup across bundles)"
