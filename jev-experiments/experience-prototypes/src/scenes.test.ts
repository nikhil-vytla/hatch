import { describe, expect, test } from "bun:test";
import { isValidElement } from "react";
import { liveScene, retired, scenes } from "./scenes";
import { sceneViews } from "./scene-views";
import { experimentNotes } from "./notes/manifest";

const live = new Set(scenes.map((s) => s.id));

describe("scene definitions", () => {
  test("ids are unique", () => {
    expect(live.size).toBe(scenes.length);
  });

  test("every scene's view renders an element, given an empty record", () => {
    for (const s of scenes) expect({ id: s.id, element: isValidElement(sceneViews[s.id]({ result: {}, composition: null })) }).toEqual({ id: s.id, element: true });
  });

  test("a scene that brings its own data names no other record to load", () => {
    for (const s of scenes.filter((s) => s.record === null)) expect({ id: s.id, loads: s.loads, companion: s.companion }).toEqual({ id: s.id, loads: undefined, companion: undefined });
  });

  test("only game pages put the headline strip after the scene", () => {
    for (const s of scenes.filter((s) => s.strip === "after")) expect({ id: s.id, format: s.format }).toEqual({ id: s.id, format: "game" });
  });

  test("every view belongs to a live scene", () => {
    expect(Object.keys(sceneViews).sort()).toEqual([...live].sort());
  });

  test("the router finds live scenes and nothing else", () => {
    for (const s of scenes) expect(liveScene(s.id)).toBe(s);
    for (const id of Object.keys(retired)) expect(liveScene(id)).toBeUndefined();
    expect(liveScene("constructor")).toBeUndefined();
  });
});

describe("catalog links", () => {
  test("a retired scene's replacement is a live scene, not another retired one", () => {
    for (const [id, r] of Object.entries(retired)) {
      const href = r.instead?.href;

      if (!href?.startsWith("#experiment/")) continue;

      expect({ id, target: href.slice("#experiment/".length), live: live.has(href.slice("#experiment/".length)) }).toEqual({
        id,
        target: href.slice("#experiment/".length),
        live: true,
      });
    }
  });

  test("every note's scene exists, live or retired", () => {
    for (const note of experimentNotes) expect(live.has(note.scene) || Object.hasOwn(retired, note.scene)).toBe(true);
  });

  test("no scene is both live and retired", () => {
    for (const id of live) expect(Object.hasOwn(retired, id)).toBe(false);
  });
});
