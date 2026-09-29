# Release only supported claims

- Owner: root
- Type: research
- Status: Resolved 29 Sep 2026. The first public release is the site deployed from GitHub main; the Sep 21 application patch is superseded
- Depends on: All first-release decisions

## Question and resolution

The original gate said the release stays open until [application.patch](../application.patch) and its provider-free workflow land on GitHub main and that revision deploys. That never happened. Main moved on without the patch: the arena rebuild, One box, Decide and the materials-first home all shipped through ordinary pull requests. On 29 Sep 2026, 15 of the patch's 23 files were still unapplied and the other 8 had diverged, so the gate could not be met as written.

Resolution: the patch is superseded, not applied. The first public release is the site as deployed from main (`269a923`, [record](../verification/public-release.json)). Pieces of the patch that are still wanted are ported one at a time as small pull requests; MAP.md lists the candidates. The provider-free check that mattered is covered by the six Jev workflows already on main.

The claims the release supports are unchanged. The completed study and installation checks support an experimental validation-selected local default, not a general-purpose quality claim. The small routing comparison does not establish savings or a classifier advantage. Material rule interpretation has frozen labels but no model accuracy result. Mobile browser emulation and short frame samples do not replace physical-device usability or long-running performance checks. The arena and Decide replay recorded answers; Decide's deck is twenty authored calls, and its visitor tally is counts only.

## Evidence

- [Clean checkout, patch hash and prepared-output comparisons](../verification/clean-checkout.json)
- [Provider-free checks](../verification/checks.json), [actual browser downloads](../verification/downloads-release.json), [active scene observations](../verification/PERFORMANCE.md)
- [Real coding-client delegation](../integration/README.md) and [routing comparison](../routing/comparison/README.md)
- [Completed training/export gate](../training/release-status.json), [validation-only selection](../training/default-selection.json), [fresh default package](../mac/default-package-verification.json)
- [Three Fable reviews and independent dispositions](../reviews/README.md)
- [Current canonical deployment, explicitly preceding this patch](../verification/canonical-deployment.json), and the [public release record](../verification/public-release.json) that supersedes it
- [Review slices and exact branch checks](../delivery/README.md)
