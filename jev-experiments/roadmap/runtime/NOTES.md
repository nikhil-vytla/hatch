# Runtime notes

- Established the shared contract before routing and local inference integration. Keep runtime limits and identity explicit rather than widening inputs or silently changing providers.
- Reproduced score-vector/cardinality, inherited-choice, numeric identity and malformed-envelope defects in the existing gateway/TypeScript adapter. Preserved their corrections as a two-file patch for separate review.
- Independent foundation review added checks for cancellation, precision, pinned revisions and malformed outer requests. Runtime tests retain those boundaries.
- Added a clean-source standalone check so the contract and its existing-code fixes can be reviewed before the larger application integration.
