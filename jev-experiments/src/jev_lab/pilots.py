"""Original fixtures and bounded renderable artifacts."""

from .core import choice, collect, noul, score

BRIEFS = [
    "A quiet moonlit garden with drifting fireflies and a small pond",
    "A busy coral reef with curious fish and waving plants",
    "An orange desert at sunset with windblown dunes",
    "A rainy city at night, full of reflections and umbrellas",
    "A bright geometric playground with bouncing shapes",
    "A snowy forest with slow falling snowflakes",
    "A tiny alien planet with orbiting moons and purple grass",
    "An underwater library where glowing books drift past",
    "A clockwork greenhouse with rotating flowers",
    "A cheerful farm at dawn with birds circling",
    "An abandoned space station with blinking lights",
    "A paper ocean with sailing boats and curling waves",
    "A cozy campsite with flickering flames and floating sparks",
    "A neon jungle with climbing vines and hidden creatures",
    "A peaceful mountain lake with clouds moving slowly",
    "A carnival of colorful kites moving in a breeze",
    "A microscopic world of swimming cells",
    "A cave of crystals that pulse with light",
    "A field of flowers growing toward the sun",
    "A minimalist black and white dance of circles",
]

PALETTES = {
    "night": ["#11172f", "#504e9c", "#94b6dc", "#ffeab0"],
    "warm": ["#241722", "#ad4f41", "#f39b53", "#ffe3a1"],
    "ocean": ["#102f43", "#247d8c", "#70cbb9", "#dcf4d6"],
    "garden": ["#172b23", "#527c46", "#a5c06d", "#f1d9a6"],
    "neon": ["#191529", "#924cdb", "#e06dad", "#87ecce"],
    "monochrome": ["#171b20", "#656e79", "#b6bec8", "#f2f0e9"],
}


def scene_questions():
    questions = {
        "palette": choice(
            "Which palette best fits the requested scene?",
            {
                "night": "Moonlight, dark blue, silver and pale yellow",
                "warm": "Sunset, oranges and warm earth",
                "ocean": "Water, teal, blue and sea green",
                "garden": "Plants, forest greens and soft sunlight",
                "neon": "Strange luminous purple, pink and mint",
                "monochrome": "Black, white and gray",
            },
        ),
        "terrain": choice(
            "What background environment should the scene use?",
            ["hills", "waves", "buildings", "stars", "flat"],
        ),
        "density": choice("How visually crowded should it be?", ["sparse", "balanced", "dense"]),
        "motion": choice(
            "What dominant movement fits the scene?", ["drift", "orbit", "bounce", "grow", "pulse"]
        ),
    }
    for i in range(4):
        questions[f"shape{i}"] = choice(
            f"For visual layer {i}, which motif best conveys a distinct part of the scene?",
            ["circle", "leaf", "triangle", "star", "line"],
        )
    return questions


async def scene(client, brief, tag="scene"):
    result = await client.evaluate(brief, scene_questions(), tag)
    values = {k: v["value"] for k, v in result["answers"].items()}
    return {
        "brief": brief,
        "scene": values,
        "palette": PALETTES[values["palette"]],
        "answers": result["answers"],
        "latency_ms": result["latency_ms"],
    }


async def pixel(client, brief, size=8):
    palette = {
        "ink": "Dark navy background",
        "teal": "Medium teal or green",
        "coral": "Warm pink or orange",
        "cream": "Pale cream or light yellow",
    }
    questions = {}
    for y in range(size):
        for x in range(size):
            vertical = "upper" if y < size / 3 else "lower" if y >= 2 * size / 3 else "middle"
            horizontal = "left" if x < size / 3 else "right" if x >= 2 * size / 3 else "center"
            questions[f"p{x}_{y}"] = choice(
                f"Imagine the requested picture on a {size} by {size} grid. Choose the color for "
                f"column {x + 1}, row {y + 1}, in the {vertical} {horizontal}. Top left is column 1, row 1.",
                palette,
            )
    result = await client.evaluate(brief, questions, "pixels")
    return {
        "brief": brief,
        "size": size,
        "answers": result["answers"],
        "latency_ms": result["latency_ms"],
        "note": "Independent pixel distributions, not a joint image distribution.",
    }


async def visuals(client, quick=False):
    briefs = BRIEFS[:4] if quick else BRIEFS
    scenes = await collect(
        [{"id": str(i), "brief": b} for i, b in enumerate(briefs)],
        lambda r: scene(client, r["brief"], "scene/" + r["id"]),
    )
    client.run.checkpoint({"scenes": scenes})
    pixels = await collect(
        [{"id": str(i), "brief": b} for i, b in enumerate(briefs[:4])],
        lambda r: pixel(client, r["brief"], 8),
    )
    return {
        "scenes": scenes,
        "pixels": pixels,
        "checks": {
            "expected_scenes": len(briefs),
            "valid_scenes": sum("scene" in s for s in scenes),
        },
        "human_preference": None,
        "note": "Renderable choices are verified; visual quality awaits optional blinded ratings.",
    }


UI_BRIEFS = [
    (
        "Compare three subscription plans and emphasize the price",
        "comparison",
        ["name", "price", "features"],
    ),
    (
        "Show project status for a team, with sortable owners and deadlines",
        "table",
        ["name", "owner", "status", "deadline"],
    ),
    ("Collect a user's name and email for a newsletter", "form", ["name", "email"]),
    (
        "Tell the story of five product milestones in chronological order",
        "timeline",
        ["name", "date", "description"],
    ),
    ("Let people browse a gallery of art projects", "cards", ["name", "image", "description"]),
    (
        "Compare battery life and prices of three cameras",
        "comparison",
        ["name", "price", "battery"],
    ),
    ("Track incoming bug reports with severity and owner", "table", ["name", "severity", "owner"]),
    (
        "Ask a visitor to describe a problem and leave contact details",
        "form",
        ["name", "email", "description"],
    ),
    ("Display the release history of a project", "timeline", ["name", "date", "description"]),
    ("Browse recipes with a picture and cooking time", "cards", ["name", "image", "duration"]),
    ("Compare courses by price and duration", "comparison", ["name", "price", "duration"]),
    (
        "Audit inventory with quantity, status and owner",
        "table",
        ["name", "quantity", "status", "owner"],
    ),
    ("Register attendees by name and email", "form", ["name", "email"]),
    ("Present a museum's history as dated events", "timeline", ["name", "date", "description"]),
    ("Explore a set of hiking routes", "cards", ["name", "image", "duration"]),
    ("Compare three laptops' prices and features", "comparison", ["name", "price", "features"]),
    ("Find orders by status, customer and deadline", "table", ["name", "status", "deadline"]),
    (
        "Gather feedback as a short description with an email address",
        "form",
        ["email", "description"],
    ),
    ("Show how a garden grew over the seasons", "timeline", ["name", "date", "image"]),
    (
        "Browse community events with names and descriptions",
        "cards",
        ["name", "description", "date"],
    ),
]


def ui_questions(fields):
    return {
        "layout": choice(
            "Which presentation best serves the brief?",
            {
                "table": "Dense records compared across columns",
                "cards": "Browse individual items visually",
                "timeline": "Events in chronological sequence",
                "comparison": "A few alternatives compared side by side",
                "form": "Collect structured input from the user",
            },
        ),
        "density": choice(
            "Which information density suits the request?", ["compact", "comfortable", "spacious"]
        ),
        "emphasis": choice("What deserves visual emphasis?", {f: f for f in fields}),
        **{
            f"field_{f}": noul(f"Does the requested interface need the '{f}' field?")
            for f in fields
        },
    }


async def ui_one(client, brief, fields, previous=None):
    out = await client.evaluate(
        {"brief": brief, "available_fields": fields, "previous_layout": previous},
        ui_questions(fields),
        "ui",
    )
    values = {k: a["value"] for k, a in out["answers"].items()}
    return {
        "brief": brief,
        "layout": values["layout"],
        "density": values["density"],
        "emphasis": values["emphasis"],
        "fields": [f for f in fields if values[f"field_{f}"] >= 0.5],
        "answers": out["answers"],
        "latency_ms": out["latency_ms"],
    }


async def ui(client, quick=False):
    tasks = [
        {"id": str(i), "brief": b, "target": t, "fields": f}
        for i, (b, t, f) in enumerate(UI_BRIEFS[:4] if quick else UI_BRIEFS)
    ]

    async def one(r):
        fields = list(dict.fromkeys(r["fields"] + ["email", "owner", "price", "description"]))
        result = await ui_one(client, r["brief"], fields)
        revision = await ui_one(
            client,
            r["brief"] + ". Keep the same layout, make it easier to scan.",
            fields,
            result["layout"],
        )
        return {
            **result,
            "target": r["target"],
            "layout_correct": result["layout"] == r["target"],
            "revision": revision,
            "revision_preserved_layout": revision["layout"] == result["layout"],
        }

    rows = await collect(tasks, one)
    return {
        "rows": rows,
        "layout_accuracy": sum(r.get("layout_correct", False) for r in rows) / len(rows),
        "revision_stability": sum(r.get("revision_preserved_layout", False) for r in rows)
        / len(rows),
        "note": "Targets describe authored fixture intent, not a universal best UI.",
    }


IDEAS = [
    {
        "id": "a",
        "name": "Pocket tutor",
        "evidence": "Two-day prototype. Local flashcards and adaptive hints. "
        "Useful to students. Similar apps exist. Can demo in a browser.",
    },
    {
        "id": "b",
        "name": "Living atlas",
        "evidence": "Two-week prototype. A procedural world changes as visitors "
        "describe it. Distinctive and visually shareable. Practical audience is uncertain.",
    },
    {
        "id": "c",
        "name": "Citation checker",
        "evidence": "Four-day prototype. Compare claims against supplied "
        "sources. Useful to researchers. Many related tools exist. Text-based demo.",
    },
]
CRITERIA = ["usefulness", "novelty", "ease", "shareability"]


def rank_options(assessments, weights):
    total = sum(max(0, weights.get(k, 0)) for k in CRITERIA)
    normalized = {k: max(0, weights.get(k, 0)) / total if total else 0.25 for k in CRITERIA}
    ranked = []
    for item in assessments:
        values = item["scores"]
        utility = sum(normalized[k] * values[k] / 2 for k in CRITERIA)
        dominated = any(
            all(other["scores"][k] >= values[k] for k in CRITERIA)
            and any(other["scores"][k] > values[k] for k in CRITERIA)
            for other in assessments
            if other["id"] != item["id"]
        )
        ranked.append({**item, "utility": utility, "dominated": dominated})
    ranked.sort(key=lambda r: (-r["utility"], r["id"]))
    unknowns = [
        (normalized[k] * (1 - item["confidence"].get(k, 0)), item["id"], k)
        for item in assessments
        for k in CRITERIA
    ]
    _, ident, criterion = max(unknowns)
    return {
        "ranking": ranked,
        "weights": normalized,
        "next_question": {
            "option": ident,
            "criterion": criterion,
            "method": "Weight times uncertainty, a heuristic rather than expected information gain",
        },
    }


async def assess_decision(client, ideas=IDEAS):
    questions = {}
    rubrics = {
        "usefulness": [
            "No identified practical beneficiary",
            "Plausible benefit, unvalidated",
            "Clear concrete benefit",
        ],
        "novelty": [
            "Common existing idea",
            "Some distinctive combination",
            "Unusual approach or experience",
        ],
        "ease": [
            "Substantial work or unresolved dependencies",
            "Moderate prototype effort",
            "Small straightforward prototype",
        ],
        "shareability": [
            "Hard to demonstrate",
            "Can be explained with examples",
            "Immediate visible demonstration",
        ],
    }
    for item in ideas:
        for criterion in CRITERIA:
            questions[f"{item['id']}_{criterion}"] = score(
                f"Assess {criterion} for option {item['id']} using only its supplied evidence.",
                rubrics[criterion],
            )
        questions[f"{item['id']}_missing"] = noul(
            f"Is material evidence missing for comparing option {item['id']}?"
        )
    out = await client.evaluate(ideas, questions, "decision")
    assessments = []
    for item in ideas:
        assessments.append(
            {
                **item,
                "scores": {k: out["answers"][f"{item['id']}_{k}"]["value"] for k in CRITERIA},
                "confidence": {
                    k: out["answers"][f"{item['id']}_{k}"]["confidence"] or 0 for k in CRITERIA
                },
                "missing_probability": out["answers"][f"{item['id']}_missing"]["value"],
            }
        )
    return {
        "assessments": assessments,
        "answers": out["answers"],
        **rank_options(assessments, {k: 1 for k in CRITERIA}),
        "latency_ms": out["latency_ms"],
    }


async def decisions(client, quick=False):
    rows = []
    for i in range(4 if quick else 20):
        # Rotate order and vary evidence, rather than repeating one subjective ranking.
        ideas = [
            {
                **item,
                "evidence": item["evidence"]
                + (" A working prototype already exists." if j == i % 3 and i >= 3 else ""),
            }
            for j, item in enumerate(IDEAS)
        ]
        ideas = ideas[i % 3 :] + ideas[: i % 3]
        try:
            out = await assess_decision(client, ideas)
        except Exception as exc:
            rows.append({"case": i, "error": str(exc)})
            continue
        sweeps = {
            k: rank_options(out["assessments"], {c: 5 if c == k else 1 for c in CRITERIA})
            for k in CRITERIA
        }
        rows.append({"case": i, **out, "weight_sweeps": sweeps})
        client.run.checkpoint({"rows": rows})
    return {
        "rows": rows,
        "note": "Scores are model assessments; ranks are explicit weighted calculations. "
        "No objectively correct preference ranking is claimed.",
    }
