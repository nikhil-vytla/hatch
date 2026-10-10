## Racket kernel: how to write forms

Each form is ONE string holding exactly one function definition, read as data (never run at load):

    (define (name param ...) body ...)        ; params: `x` or optional `[x default]`; no rest args

Nothing else: no top-level statements, `require`, `define-syntax`, `eval`, namespaces, files, network, processes,
continuations, threads, `parameterize`, `getenv`. Functions are called by their snake_case name (`add_expense`);
helpers may be defined as extra forms. A name must not be a builtin (don't define `sum`, `count`, `first`, `range`,
`take` ...). `set!` only on local variables. Every identifier must be a builtin or a function defined in the
(live + this) code, otherwise the change is refused. Allowed builtins: racket/base core (let, cond, for/fold,
for/list, hash ops, sort, map, filter, foldl, string ops, `format`, `~a`), racket/list, racket/string, racket/math.

State: the app state is ONE immutable value you read and replace.
- `(get-state)` returns it; `(set-state! s)` replaces it; `(update-state! f)` sets it to `(f state)`.
- Never mutate in place; build new values with `hash-set`, `hash-update`, `append`.
- A call is a transaction: if it raises, all its `set-state!` calls are discarded.

JSON <-> Racket: object = immutable hasheq with SYMBOL keys (`(hash-ref s 'expenses '())`, `(hasheq 'amount 1)`);
array = list; string = string; number = number; true/false = #t/#f; null = the symbol `'null` (test with
`(eq? x 'null)`; return `'null` for "no value"; `(void)` also becomes null). Optional JSON arguments that are
omitted take their default: write `[note 'null]`. Object keys that are data (category names) must be converted:
`(string->symbol category)` to use as a key, `(symbol->string k)` to return one as a string. Exact rationals are
returned as floats; `+inf.0`/`+nan.0` and procedures cannot be returned. Missing key with no default raises.

Throw with `(error 'fn_name "message")` or `(raise "message")`. Each call has 1 second and 128 MB; runaway code is
killed and the change refused.

Example (valid, complete):

    (define (add_expense amount category [note 'null])
      (unless (and (real? amount) (> amount 0)) (error 'add_expense "amount must be positive"))
      (let* ([s (get-state)]
             [es (hash-ref s 'expenses '())]
             [e (hasheq 'amount amount 'category category)])
        (set-state! (hash-set s 'expenses (append es (list (if (eq? note 'null) e (hash-set e 'note note))))))
        (add1 (length es))))

Laws (optional): `{"name": "...", "check": "<one Racket expression>"}` evaluated on generated states with your app
functions in scope; it must return a true value, e.g. `(= (/ (round (* (total) 100)) 100) (total))`.
