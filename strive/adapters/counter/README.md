# Integer-target benchmark fixture

A separate benchmark with two tasks: reach 7 and reach -2 using bounded integer
addition. It has no user simulator. Its own adapter, scorer and descriptor use
the same benchmark protocol, bridge, operation store, episode driver and verifier
as telecom.

`tests/vnext/test_second_benchmark.py` performs discovery, initialization,
mutation, interruption, original-result lookup, scoring and fresh-interpreter
replay. It checks the retained core hashes before and after execution. The hash
manifest was captured before this adapter was added.
