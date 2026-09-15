import { describe, expect, it } from "vitest";
import { assembleContextTreeSkills, CONTEXT_TREE_PACKAGED_SKILL_DIRECTORIES } from "../runner/skills.js";
import { resolveContextTreePackage } from "../runtime/context-tree.js";

describe("context tree skill assembly", () => {
  it("loads the six packaged skills through the real Client resolver", async () => {
    expect(CONTEXT_TREE_PACKAGED_SKILL_DIRECTORIES).toHaveLength(6);
    const assembled = await assembleContextTreeSkills();
    const resolved = resolveContextTreePackage();
    expect(resolved?.skillsPath).toBe(assembled.skillsPath);
    expect(assembled.skills.map((skill) => skill.name)).toEqual([...CONTEXT_TREE_PACKAGED_SKILL_DIRECTORIES]);
    expect(assembled.skillPaths).toEqual(assembled.skills.map((skill) => skill.directory));
    expect(assembled.skillPaths).not.toContain(assembled.skillsPath);
  });
});
