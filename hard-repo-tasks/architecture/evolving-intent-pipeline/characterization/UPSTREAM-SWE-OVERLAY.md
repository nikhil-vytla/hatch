# Pinned upstream SWE scheduling overlay

## Immutable basis

The source checkout was clean at Microsoft Evolving Intent commit
[`993d6be9597ac03854b46362ccd647eb1bfd267a`](https://github.com/microsoft/evolving-intent/tree/993d6be9597ac03854b46362ccd647eb1bfd267a).
This note records the two files needed to substantiate the SWE overlay
correction without vendoring the repository.

- [`situated_simulation/turn_scheduler_swe.py`](https://github.com/microsoft/evolving-intent/blob/993d6be9597ac03854b46362ccd647eb1bfd267a/situated_simulation/turn_scheduler_swe.py)
  has Git blob SHA-1 `05e92ef71bc72a8de04559274166f491fd9f3e39` and
  file SHA-256
  `3449af66c4bebcd1e87410e54067812a9093ffcf966097e2230298cabaa67a48`.
- [`situated_simulation/turn_scheduler.py`](https://github.com/microsoft/evolving-intent/blob/993d6be9597ac03854b46362ccd647eb1bfd267a/situated_simulation/turn_scheduler.py)
  has Git blob SHA-1 `4b39a4758786482d7d53c1404a60f035aaf61d47`
  and file SHA-256
  `f5420d2d629f0405968db677d810a50b5d7ad8a1aa79f424d7d083826ecc90de`.

The blob IDs came from `git rev-parse HEAD:<path>`. The content hashes came
from the exact checked-out bytes.

## Relevant ranges

- [`_strip_symptoms`, lines 82-131](https://github.com/microsoft/evolving-intent/blob/993d6be9597ac03854b46362ccd647eb1bfd267a/situated_simulation/turn_scheduler_swe.py#L82-L131)
  deep-copies the raw record and removes every `category == "symptom"` item
  from source and predecessor arguments.
- [`_make_inject_hook`, lines 509-623](https://github.com/microsoft/evolving-intent/blob/993d6be9597ac03854b46362ccd647eb1bfd267a/situated_simulation/turn_scheduler_swe.py#L509-L623)
  distributes symptoms within the matching function phase and inserts each
  item at index zero of the receiving slot.
- [`create_sample_swe`, lines 630-662](https://github.com/microsoft/evolving-intent/blob/993d6be9597ac03854b46362ccd647eb1bfd267a/situated_simulation/turn_scheduler_swe.py#L630-L662)
  strips symptoms, installs the hook, and calls the generic scheduler with the
  stripped record.
- [`create_sample`, lines 1391-1408](https://github.com/microsoft/evolving-intent/blob/993d6be9597ac03854b46362ccd647eb1bfd267a/situated_simulation/turn_scheduler.py#L1391-L1408)
  invokes the post-fill hook after argument filling and before `fill_texts`.

## Minimal excerpt

```python
stripped, target_syms, pred_syms = _strip_symptoms(raw)
hook = _make_inject_hook(target_syms, pred_syms, source_function_text)
kwargs["post_fill_hook"] = hook
sample = create_sample(stripped, *args, **kwargs)
```

```python
target_slot.arguments.insert(0, ArgumentItem(cid, text, False))
```

```python
if post_fill_hook is not None:
    post_fill_hook(...)
fill_texts(slots, selected_functions, source_function, counterfactual_map, cond_by_id)
```

The correction is therefore narrow. The SWE wrapper removes symptom-category
arguments before the generic scheduler sees the record. Its hook restores those
same symptoms at the front of the appropriate filled slots before text
construction. It does not strip symptoms before predecessor construction, and
it does not re-inject the source problem.
