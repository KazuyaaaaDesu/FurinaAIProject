import { readFile } from "node:fs/promises";
import path from "node:path";
import { AgentError } from "./policies.js";
import { SessionManager } from "./session-manager.js";

const SKILL_FILES = new Map([
  ["general-assistant", "skills/general-assistant/SKILL.md"],
  ["vision-analysis", "skills/vision-analysis/SKILL.md"],
]);

export async function loadSkillRegistry(projectRoot, options = {}) {
  const skills = new Map();
  for (const [expectedId, relativePath] of SKILL_FILES) {
    const absolutePath = path.resolve(projectRoot, relativePath);
    const file = await readFile(absolutePath, "utf8");
    const skill = parseSkillDocument(file);
    if (skill.id !== expectedId) {
      throw new Error(`Skill ID mismatch in registered file: ${expectedId}`);
    }
    skills.set(skill.id, { ...skill, relativePath });
  }
  return createSkillRegistry(skills, options);
}

export function parseSkillDocument(source) {
  if (typeof source !== "string" || source.length > 40_000) {
    throw new Error("Skill document must be a string no larger than 40000 characters.");
  }
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) throw new Error("Skill document must have frontmatter delimiters.");

  const metadata = new Map();
  for (const line of match[1].split(/\r?\n/)) {
    const entry = line.match(/^([A-Za-z][A-Za-z0-9]*):\s*(.*?)\s*$/);
    if (!entry || metadata.has(entry[1])) {
      throw new Error("Skill frontmatter contains invalid or duplicate metadata.");
    }
    metadata.set(entry[1], entry[2]);
  }

  const allowedKeys = new Set(["id", "name", "description", "requiredToolIds"]);
  if ([...metadata.keys()].some((key) => !allowedKeys.has(key))) {
    throw new Error("Skill frontmatter contains unsupported metadata.");
  }
  const id = metadata.get("id");
  const name = metadata.get("name");
  const description = metadata.get("description");
  const requiredRaw = metadata.get("requiredToolIds");
  if (
    typeof id !== "string" ||
    !/^[a-z0-9-]{1,64}$/.test(id) ||
    !name ||
    name.length > 100 ||
    !description ||
    description.length > 500 ||
    !requiredRaw ||
    !/^\[(?:\s*[a-z][a-z0-9._-]{1,63}(?:\s*,\s*[a-z][a-z0-9._-]{1,63})*)?\s*\]$/.test(requiredRaw)
  ) {
    throw new Error("Skill metadata is invalid.");
  }

  const requiredToolIds = requiredRaw === "[]"
    ? []
    : requiredRaw.slice(1, -1).split(",").map((toolId) => toolId.trim());
  const instructions = match[2].trim();
  if (!instructions) throw new Error("Skill instructions cannot be empty.");

  return { id, name, description, requiredToolIds, instructions };
}

export function createSkillRegistry(
  skillMap,
  { sessionManager = new SessionManager(), registeredToolIds } = {},
) {
  if (registeredToolIds) {
    const knownToolIds = new Set(registeredToolIds);
    for (const skill of skillMap.values()) {
      if (skill.requiredToolIds.some((id) => !knownToolIds.has(id))) {
        throw new Error(`Skill ${skill.id} references an unregistered tool.`);
      }
    }
  }
  return {
    activate(clientId, sessionId, skillId, enabled, allowedSkillIds) {
      const skill = skillMap.get(skillId);
      if (!skill) {
        throw new AgentError(404, "SKILL_NOT_FOUND", "Skill is not registered.");
      }
      if (!allowedSkillIds.includes(skillId)) {
        throw new AgentError(403, "SKILL_FORBIDDEN", "Skill is not allowed for this client.");
      }
      const session = sessionManager.getOrCreate(clientId, sessionId);
      if (enabled) session.activeSkillIds.add(skillId);
      else session.activeSkillIds.delete(skillId);
      return { id: skillId, enabled, requiredToolIds: [...skill.requiredToolIds] };
    },
    activeFor(clientId, sessionId, requestedIds, allowedSkillIds) {
      const current = sessionManager.get(clientId, sessionId)?.activeSkillIds ?? new Set();
      const selected = requestedIds ?? [...current];
      for (const skillId of selected) {
        if (!allowedSkillIds.includes(skillId)) {
          throw new AgentError(403, "SKILL_FORBIDDEN", "Skill is not allowed for this client.");
        }
        if (!current.has(skillId)) {
          throw new AgentError(422, "SKILL_NOT_ACTIVE", "Skill must be activated for this session first.");
        }
        if (!skillMap.has(skillId)) {
          throw new AgentError(404, "SKILL_NOT_FOUND", "Skill is not registered.");
        }
      }
      return selected.map((id) => skillMap.get(id));
    },
    sessionManager,
    listFor(clientId, allowedSkillIds) {
      return [...skillMap.values()]
        .filter((skill) => allowedSkillIds.includes(skill.id))
        .map(({ id, name, description, requiredToolIds }) => ({
          id,
          name,
          description,
          requiredToolIds: [...requiredToolIds],
          allowed: true,
        }));
    },
  };
}
