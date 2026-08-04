# These admission records are no longer reproducible from current code

The admission records and preregistered design digest in this folder were
computed by code that no longer exists. They are still valid evidence of what
was run, and they have not been altered. They can no longer be *recomputed* from
the current package.

## What changed

`freeze_swe_specs` hashed every arm's turn texts into the task spec digest, and
the matched arm was retired as a design decision. Removing it therefore changed
the spec digest of tasks whose own material — issue statement, repo, base
commit, gold patch, test patch, test lists — is byte-identical to what was
admitted. The admission records bind that digest, so they no longer match.

## Why we accepted the break instead of preserving reproducibility

Keeping a code path that rebuilds the retired three-arm spec would mean keeping
the matched-arm construction, the arm-triple validator, and the arm-hashing spec
layout alive purely so that a digest could be recomputed — the entire structure
this restructure exists to remove, retained for one verification. The digests
below plus the revision that produces them give the same auditability at no
ongoing cost.

## How to verify the historical digests

They reproduce exactly at commit `6cca01d2aeca6e62183d2bbff5aaea27225ba882`
(`main` immediately before the restructure):

```
git worktree add /tmp/parallax-legacy 6cca01d2aeca6e62183d2bbff5aaea27225ba882
```

| record | spec digest | environment digest | bundle digest |
|---|---|---|---|
| `astropy__astropy-14508` | `1d3898ea20589bc7…` | `d316aca1d21f17ad…` | `faded71cfdbd5723…` |
| `django__django-13786` | `adfa72c8da16f5c8…` | `ec50eefd6ab672e5…` | `3f0e43ecd6dbf330…` |
| `pydata__xarray-4695` | `547f4f100a8202c2…` | `ce715305dd5cdbd2…` | `7f9e298096fa8840…` |

Full values are in the unmodified `*/admission.json` files beside this note.
The preregistered design digest of the static-vs-evolved experiment is
`e230043ce85483b90e636b594e828dd78f525ddd9fd4bc6a25bf11caeeda4eaa`, linked to
screening design `175dc9521d461fb24b93ef932955976d007a9d5f34724b7ad7e7516b46f3184b`
with exact unit correspondence. Those two are unaffected by the arm change in
substance but were computed by the same retired code, so the same revision
applies.

## What we changed so this cannot happen again

Task identity is now scoped to the task. `SweTaskSpec` covers the public issue
and the sealed authority; each condition carries its own digest, and admission
binds the task spec and the environment rather than the compiled bundle. Editing
or retiring a condition now changes that condition's digest and the experiment's
design digest, and leaves every task's identity and admission record intact.
