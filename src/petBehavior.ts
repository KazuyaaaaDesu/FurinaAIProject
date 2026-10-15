export type PetBehavior =
  | "idle"
  | "walking"
  | "greeting"
  | "talking"
  | "reacting"
  | "interacting"
  | "paused";

export type MotionCategory =
  | "idle"
  | "locomotion"
  | "greeting"
  | "speech"
  | "reaction"
  | "interaction"
  | "pose";

export type MotionReturnBehavior = "previous" | "idle";
export type MotionFallbackBehavior = "idle" | null;

export type MotionDefinition = {
  id: string;
  label: string;
  source: string;
  loop: boolean;
  category: MotionCategory;
  priority: number;
  returnBehavior: MotionReturnBehavior;
  fallbackBehavior: MotionFallbackBehavior;
};

export type MotionManifest = MotionDefinition[];

const BEHAVIOR_PRIORITY: Record<PetBehavior, number> = {
  idle: 0,
  walking: 10,
  talking: 20,
  greeting: 30,
  reacting: 35,
  interacting: 40,
  paused: 100,
};

type TemporaryBehavior = {
  behavior: PetBehavior;
  priority: number;
  returnBehavior: MotionReturnBehavior;
};

function categoryBehavior(category: MotionCategory): PetBehavior {
  switch (category) {
    case "idle":
      return "idle";
    case "locomotion":
      return "walking";
    case "greeting":
      return "greeting";
    case "speech":
      return "talking";
    case "reaction":
      return "reacting";
    case "interaction":
    case "pose":
      return "interacting";
  }
}

export class PetBehaviorController {
  private baseBehavior: PetBehavior = "idle";
  private temporaryBehavior:
    | (TemporaryBehavior & { token: number })
    | null = null;
  private paused = false;
  private nextToken = 1;

  get current(): PetBehavior {
    if (this.paused) return "paused";
    return this.temporaryBehavior?.behavior ?? this.baseBehavior;
  }

  get base(): PetBehavior {
    return this.baseBehavior;
  }

  get isPaused(): boolean {
    return this.paused;
  }

  setPaused(paused: boolean) {
    this.paused = paused;
  }

  setBase(behavior: "idle" | "walking" | "talking") {
    this.baseBehavior = behavior;
  }

  beginMotion(definition: MotionDefinition): number | null | false {
    const behavior = categoryBehavior(definition.category);
    if (
      behavior === "idle" ||
      behavior === "walking" ||
      behavior === "talking"
    ) {
      this.setBase(behavior);
      this.temporaryBehavior = null;
      return null;
    }

    const currentPriority = this.temporaryBehavior?.priority ?? -1;
    if (currentPriority > definition.priority) return false;

    const token = this.nextToken++;
    this.temporaryBehavior = {
      behavior,
      priority: definition.priority,
      returnBehavior: definition.returnBehavior,
      token,
    };
    return token;
  }

  beginReaction(priority = BEHAVIOR_PRIORITY.reacting): number | null {
    const currentPriority = this.temporaryBehavior?.priority ?? -1;
    if (currentPriority > priority) return null;

    const token = this.nextToken++;
    this.temporaryBehavior = {
      behavior: "reacting",
      priority,
      returnBehavior: "previous",
      token,
    };
    return token;
  }

  finishTemporary(token: number) {
    if (this.temporaryBehavior?.token !== token) {
      return this.baseBehavior;
    }
    if (this.temporaryBehavior?.returnBehavior === "idle") {
      this.baseBehavior = "idle";
    }
    this.temporaryBehavior = null;
    return this.baseBehavior;
  }

  cancelTemporary() {
    this.temporaryBehavior = null;
  }

  acceptsMotion(definition: MotionDefinition) {
    const behavior = categoryBehavior(definition.category);
    if (
      behavior === "idle" ||
      behavior === "walking" ||
      behavior === "talking"
    ) {
      return true;
    }
    return (
      (this.temporaryBehavior?.priority ?? -1) <= definition.priority
    );
  }
}

export function isMotionManifest(value: unknown): value is MotionManifest {
  if (!Array.isArray(value)) return false;

  const ids = new Set<string>();
  const categories: MotionCategory[] = [
    "idle",
    "locomotion",
    "greeting",
    "speech",
    "reaction",
    "interaction",
    "pose",
  ];

  return value.every((item) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      return false;
    }

    const entry = item as Record<string, unknown>;
    if (
      typeof entry.id !== "string" ||
      !/^[a-z0-9-]+$/i.test(entry.id) ||
      ids.has(entry.id) ||
      typeof entry.label !== "string" ||
      typeof entry.source !== "string" ||
      typeof entry.loop !== "boolean" ||
      typeof entry.category !== "string" ||
      !categories.includes(entry.category as MotionCategory) ||
      typeof entry.priority !== "number" ||
      !Number.isInteger(entry.priority) ||
      (entry.returnBehavior !== "previous" &&
        entry.returnBehavior !== "idle") ||
      (entry.fallbackBehavior !== null &&
        entry.fallbackBehavior !== "idle")
    ) {
      return false;
    }

    ids.add(entry.id);
    return true;
  });
}
