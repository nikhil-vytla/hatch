# Eyes against state

`#experiment/eyes`. The same Snake game (the arcade engine) runs on the same seed in two lanes:

- **A, reads the facts:** the greedy rule (code) or Jev's recorded games read the positions as text.
- **B, looks at the screen:** an open vision-language model sees a 320×320 screenshot and picks the next move.

Jev is text-only. TypeSafe's model page says "No image, audio, or video input", so Jev never sees pixels.

## How lane B was recorded

`vlm_server.py` runs a model with MLX-VLM on an Apple M4 Max. Each move gets one prefill over the image plus a fixed question, with no generation. The logits of the answer letters A–D (up, right, down, left) at the answer position are softmaxed into probabilities, the way SGLang's `/v1/decisions` works. `record.ts` then:

- plays the game with the site's own engine
- draws each frame with `frame.ts`, using the page's palette; the recorded hash is the PNG the model saw
- turns the chosen direction into the engine's left, straight or right using the snake's heading, as arrow keys would

Choosing to go back the way it came drives the head into its own neck and ends the game.

| Run | Model | Licence |
|---|---|---|
| `qwen3-vl-4b.v1` | mlx-community/Qwen3-VL-4B-Instruct-4bit | Apache-2.0 |
| `qwen3-vl-4b.v2` | the same model, with a clearer wording, tried once for a fairer chance | Apache-2.0 |
| `qwen3-vl-8b.v1` | mlx-community/Qwen3-VL-8B-Instruct-4bit | Apache-2.0 |
| `qwen3-vl-8b.perception` | yes/no checks: is the food above the head, and is it to the right? Asked on the greedy rule's games, where the truth is known | Apache-2.0 |

All runs are free and local; no paid calls were made. Seeds are 101–120 plus Jev's 7, 19 and 42.

## Results (`summary.ts`, recorded 2–3 Oct 2026)

| Decider | Reads | Survived | Median moves | Food a game | Per move | Same move as greedy |
|---|---|---|---|---|---|---|
| Greedy rule | facts | 21 of 23 | 90 | 12.0 | under 1 ms | 100% |
| Jev (recorded) | facts | 2 of 3 | 90 | 10.3 | 313 ms | — |
| Qwen3-VL-4B | screenshot | 0 of 23 | 9 | 1.1 | 229 ms | 70% |
| Qwen3-VL-4B, clearer wording | screenshot | 0 of 23 | 9 | 1.0 | 403 ms | 41% |
| Qwen3-VL-8B | screenshot | 0 of 23 | 8 | 0.0 | 638 ms | 24% |

Seeing isn't the problem. The 8B model said correctly whether the food was above the head 202 of 214 times (94%), and whether it was to the right 193 of 208 times (93%). Its moves are where it fails: it answered only "right" or "up", and drove into a wall in all 23 games.

## Limits

- These are zero-shot, small, quantised models on a 10×10 board. A fine-tuned or larger model, or one served on a GPU, may do far better.
- There's one run per configuration over 23 seeds, and Jev has only 3 recorded games.
- Times are per move, warm, on one M4 Max.
- The two wordings are the only prompt variants tried.

## Reproduce

```sh
uv venv venv --python 3.12 && uv pip install --python venv/bin/python mlx-vlm
venv/bin/python live-worlds/eyes/vlm_server.py --model mlx-community/Qwen3-VL-4B-Instruct-4bit --port 30100
bun live-worlds/eyes/record.ts --prompt v1            # or --prompt v2, or --name qwen3-vl-8b
bun live-worlds/eyes/perception.ts --name qwen3-vl-8b # with the 8B model served
```

The build (`build.ts`, called from `prepare.ts`) writes `public/eyes/eyes.json`, and `bun test live-worlds/eyes` checks the replay. If Python can't verify Hugging Face's certificate on a managed Mac, point `SSL_CERT_FILE` at a bundle exported from the system keychain.
