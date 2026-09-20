import asyncio
import json
import random
from collections import deque

import gymnasium as gym
import minigrid  # noqa: F401 -- registers environments
from minigrid.core.constants import IDX_TO_COLOR, IDX_TO_OBJECT

from .core import ROOT, choice, digest, normalize

ACTIONS = {"turn_left": 0, "turn_right": 1, "forward": 2, "pick_up": 3, "open_door": 5}


def observation(obs, carrying):
    image = obs["image"]
    width, height = image.shape[:2]
    cells = []
    for y in range(height):
        row = []
        for x in range(width):
            obj, color, status = [int(v) for v in image[x, y]]
            name = IDX_TO_OBJECT[obj]
            if name in ("door", "key", "ball", "box"):
                name = IDX_TO_COLOR[color] + " " + name
            if obj == 4:
                name += " " + ["open", "closed", "locked"][status]
            row.append(name)
        cells.append(row)
    front = image[width // 2, height - 2]
    object_id, _, door_state = [int(v) for v in front]
    legal = ["turn_left", "turn_right"]
    if object_id in (1, 3, 8, 9) or object_id == 4 and door_state == 0:
        legal.append("forward")
    if object_id in (5, 6, 7) and not carrying:
        legal.append("pick_up")
    if object_id == 4:
        legal.append("open_door")
    return {
        "mission": obs["mission"],
        "visible_grid": cells,
        "coordinates": "Agent is in the bottom center cell, facing toward the top. Unseen cells are unknown.",
        "carrying": carrying,
        "legal_actions": legal,
    }


def heuristic(state):
    """Shortest route to a visible goal/key/door, else wall following. Same observations."""
    grid = state["visible_grid"]
    h, w = len(grid), len(grid[0])
    start = (w // 2, h - 1, 0)
    directions = [(0, -1), (1, 0), (0, 1), (-1, 0)]
    queue = deque([(start, [])])
    seen = {start}
    targets = []
    while queue:
        (x, y, d), path = queue.popleft()
        dx, dy = directions[d]
        nx, ny = x + dx, y + dy
        front = grid[ny][nx] if 0 <= nx < w and 0 <= ny < h else "wall"
        if "goal" in front:
            targets.append((0, len(path), path + ["forward"]))
        if "key" in front and not state["carrying"]:
            targets.append((1, len(path), path + ["pick_up"]))
        if "door" in front and "open" not in front and state["carrying"]:
            targets.append((2, len(path), path + ["open_door"]))
        next_states = [("turn_left", (x, y, (d - 1) % 4)), ("turn_right", (x, y, (d + 1) % 4))]
        if front in ("empty", "floor", "goal") or "door open" in front:
            next_states.append(("forward", (nx, ny, d)))
        for action, nxt in next_states:
            if nxt not in seen:
                seen.add(nxt)
                queue.append((nxt, path + [action]))
    if targets:
        action = min(targets)[2][0]
        if action in state["legal_actions"]:
            return action
    return "forward" if "forward" in state["legal_actions"] else "turn_right"


async def episode(client, env_id, seed, policy, max_steps=64, memo=None, pending=None):
    memo = {} if memo is None else memo
    pending = {} if pending is None else pending
    env = gym.make(env_id)
    obs, _ = env.reset(seed=seed)
    rng, trace, history = random.Random(seed), [], []
    success, errors = False, 0
    try:
        for step in range(max_steps):
            item = env.unwrapped.carrying
            carrying = f"{item.color} {item.type}" if item else None
            state = observation(obs, carrying)
            timing, confidence, cache_hit = 0, None, False
            if policy == "random":
                action = rng.choice(state["legal_actions"])
            elif policy == "visible_bfs":
                action = heuristic(state)
            else:
                try:
                    request_state = {
                        **state,
                        "recent_actions": history[-8:] if policy == "jev_memory" else [],
                    }
                    questions = {
                        "action": choice(
                            "Choose the next legal action to accomplish the mission. "
                            "Turn before moving toward a visible target. Pick up a key before opening a locked door. "
                            "Avoid repeating unproductive action cycles.",
                            state["legal_actions"],
                        )
                    }
                    key = digest({"state": request_state, "questions": questions})
                    cache_hit = key in memo
                    if cache_hit:
                        result = memo[key]
                    else:
                        cache_hit = key in pending
                        if key not in pending:
                            pending[key] = asyncio.create_task(
                                client.evaluate(
                                    request_state,
                                    questions,
                                    f"game/{env_id}/{seed}/{policy}/{step}",
                                )
                            )
                        future = pending[key]
                        try:
                            result = await future
                            memo[key] = result
                        finally:
                            if pending.get(key) is future:
                                pending.pop(key)
                    action = result["answers"]["action"]["value"]
                    timing = 0 if cache_hit else result["latency_ms"]
                    confidence = result["answers"]["action"]["confidence"]
                except Exception as exc:
                    from .core import BudgetExceeded

                    if isinstance(exc, BudgetExceeded):
                        raise
                    trace.append({"step": step, "error": str(exc)})
                    errors += 1
                    break
            if action not in state["legal_actions"]:
                raise ValueError("Illegal decision escaped the question contract")
            obs, reward, terminated, truncated, _ = env.step(ACTIONS[action])
            trace.append(
                {
                    "step": step,
                    "state": state,
                    "action": action,
                    "reward": reward,
                    "latency_ms": timing,
                    "confidence": confidence,
                    "cache_hit": cache_hit,
                }
            )
            history.append(
                {
                    "action": action,
                    "front_before": state["visible_grid"][-2][len(state["visible_grid"][0]) // 2],
                    "carrying_before": carrying,
                }
            )
            if terminated or truncated:
                success = reward > 0
                break
        return {
            "env": env_id,
            "seed": seed,
            "policy": policy,
            "success": success,
            "steps": len(trace),
            "errors": errors,
            "trace": trace,
            "max_steps": max_steps,
            "observation": "egocentric partial grid, no privileged state",
        }
    finally:
        env.close()


async def games(client, quick=False):
    seeds = range(3 if quick else 30)
    policies = ["random", "visible_bfs", "jev_reactive", "jev_memory"]
    tasks = [
        {"id": f"{env}/{seed}/{policy}", "env": env, "seed": seed, "policy": policy}
        for env in ("MiniGrid-Empty-5x5-v0", "MiniGrid-DoorKey-5x5-v0")
        for seed in seeds
        for policy in policies
    ]
    rows, memo, pending = [], {}, {}
    previous = sorted((ROOT / "runs").glob("*-games-*/result.json"))
    resumed_from = None
    if previous:
        source = previous[-1]
        old = json.loads(source.read_text())
        manifest = json.loads(source.with_name("manifest.json").read_text())
        if old.get("status") == "partial" and manifest["config"] == client.run.manifest["config"]:
            rows = old.get("episodes", [])
            memo.update(old.get("decision_cache", {}))
            resumed_from = source.parent.name
            # Exact successful wire requests preserve the original question and ordering.
            logs = source.with_name("requests.jsonl")
            for line in logs.read_text().splitlines():
                record = json.loads(line)
                if record["status"] == "ok":
                    request = record["request"]
                    key = digest({"state": request["state"], "questions": request["questions"]})
                    memo[key] = {
                        "answers": normalize(record["response"], request["questions"]),
                        "latency_ms": record["latency_ms"],
                    }
            print(
                f"Resuming {len(rows)} completed episodes and {len(memo)} decisions from {resumed_from}",
                flush=True,
            )
    complete = {(r["env"], r["seed"], r["policy"]) for r in rows}
    queue = asyncio.Queue()
    for task in tasks:
        if (task["env"], task["seed"], task["policy"]) not in complete:
            queue.put_nowait(task)

    async def worker():
        while not queue.empty():
            task = queue.get_nowait()
            row = await episode(
                client, task["env"], task["seed"], task["policy"], memo=memo, pending=pending
            )
            rows.append(row)
            client.run.checkpoint(
                {
                    "episodes": rows,
                    "completed_episodes": len(rows),
                    "planned_episodes": len(tasks),
                    "resumed_from": resumed_from,
                    "decision_cache": memo,
                }
            )
            print(f"Games: {len(rows)}/{len(tasks)} episodes", flush=True)

    await asyncio.gather(*(worker() for _ in range(4)))
    rows.sort(key=lambda row: (row["env"], row["seed"], policies.index(row["policy"])))
    summaries = []
    for env in ("MiniGrid-Empty-5x5-v0", "MiniGrid-DoorKey-5x5-v0"):
        for policy in policies:
            selected = [r for r in rows if r.get("env") == env and r.get("policy") == policy]
            summaries.append(
                {
                    "env": env,
                    "policy": policy,
                    "episodes": len(selected),
                    "success_rate": sum(r.get("success", False) for r in selected) / len(seeds),
                    "mean_steps": sum(r.get("steps", 0) for r in selected) / len(seeds),
                    "errors": sum(r.get("errors", 1) for r in selected),
                }
            )
    return {
        "summary": summaries,
        "resumed_from": resumed_from,
        "episodes": rows,
        "memoized_states": len(memo),
        "cache_hits": sum(
            step.get("cache_hit", False) for row in rows for step in row.get("trace", [])
        ),
        "note": "The visible BFS baseline uses exact geometry from the same partial observation. "
        "Seeds pair policies; the 64-step lab limit differs from environment defaults. "
        "Successful decisions are cached by exact state and question, including memory. "
        "Episodes therefore share some decisions; they are not independent fresh model samples.",
    }
