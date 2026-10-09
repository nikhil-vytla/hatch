## Writing forms for the Elixir (BEAM) kernel

Each form is exactly ONE function definition in Elixir: `def name(state, args...) do ... end` for a public
function, or `defp name(state, args...)` for a private helper. Nothing else at top level (no `defmodule`, `import`,
`@attr`, bare expressions). Names are snake_case. One form per function name; redefining a name replaces it.
Several clauses of the SAME name may share one form (`def f(state, 0), do: ..` newline `def f(state, n), do: ..`).
Optional arguments use defaults: `def add_expense(state, amount, category, note \\ nil)`.

**State-passing convention.** Every function (def and defp) takes the state as its FIRST argument, then the call's
arguments. State is a map with STRING keys: `%{"expenses" => [%{"amount" => 12.5, "category" => "food"}], "budgets" => %{"food" => 15}}`;
either key may be missing, so read with `Map.get(state, "expenses", [])`.
- A read returns a plain value: `def total(state), do: ...`.
- A write returns the tuple `{value, new_state}`. Never mutate; build a new map with `Map.put`.
- Functions may call each other as `by_category(state)` (a plain-value read) and must pass `state` along.
- Throw with `raise "message"`. A raising call changes nothing.

**JSON mapping.** JSON object -> map with string keys, array -> list, string -> binary, number -> integer or float,
true/false -> booleans, null -> `nil`. Return values are converted back (atoms become strings, tuples lists), so
return maps with string keys, lists, numbers, strings, booleans, `nil`.

**Allowed.** Kernel operators and functions, `Enum`, `Map`, `List`, `String`, `Float`, `Integer`, `Keyword`, `MapSet`,
`Tuple`, `Range`, `:math`, `fn`/`&` captures, `if/case/cond/with/for`, pipes, your own functions. Field access like
`e.amount` is NOT allowed (use `e["amount"]`). Forbidden: any other module (`File`, `System`, `IO`, `Code`, `Process`,
`:erlang`, `:os`, ...), `apply`, `spawn`, `send`, `receive`, `String.to_atom`, `@attributes`, `import/require/use`.
Calling a function that no form defines is rejected. A call that runs over 1 s is killed.

**Example.**
```elixir
def total(state) do
  state |> Map.get("expenses", []) |> Enum.reduce(0, fn e, sum -> sum + e["amount"] end)
end
```
```elixir
def add_expense(state, amount, category) do
  if not (is_number(amount) and amount > 0), do: raise("amount must be positive")
  expenses = Map.get(state, "expenses", [])
  {length(expenses) + 1, Map.put(state, "expenses", expenses ++ [%{"amount" => amount, "category" => category}])}
end
```
Round to cents with `Float.round(x * 1.0, 2)`. Sort with `Enum.sort/1`. `laws` are ignored by this kernel.

Optional `develop` field `migrate` (one `def migrate(state)` form, old state -> new state) for changes that alter the
shape of stored state; the gates then run on the migrated state. Examples in a migrating request use the NEW shape.
