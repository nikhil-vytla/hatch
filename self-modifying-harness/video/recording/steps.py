import json
turns = [
 ("The party", "I'm running a D&D one-shot tonight and you're my table assistant. The party: Mira (wizard, 14 HP), Thorn (fighter, 28 HP) and Pip (rogue, 18 HP). Keep track of them for me."),
 ("Initiative", "Combat! Roll initiative: Mira +2, Thorn +1, Pip +4, and three goblins at +2 each. Roll a d20 for everyone and give me the turn order."),
 ("Damage and healing", "The goblins hit Thorn for 7 and Mira for 9. Then Mira drinks a potion of healing: roll 2d4+2 for her. Where is everyone now?"),
 ("A new rule", "A giant spider bites Pip: poisoned until the end of round 3, and we're in round 1. Track conditions and the round from now on, then advance two rounds and tell me who's still poisoned."),
 ("Provenance", "Quick recap for the table: everyone's HP and conditions. And who asked you to track conditions, and when?"),
]
steps = [["wait", 4], ["snap", "Starting forge: a fresh session on deepseek-flash"]]
for title, text in turns:
    steps += [["snap", title], ["type", text + "\r"], ["until", "ready |", 600], ["wait", 2]]
steps += [["snap", "Done"], ["wait", 2], ["type", "/quit\r"], ["wait", 4]]
print(json.dumps(steps))
