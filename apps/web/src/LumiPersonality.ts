/** Lightweight, offline personality decisions for Lumi's autonomous gestures. */
export type PersonalityMode = "chill" | "balanced" | "hyper";
export type PersonalityMood = "happy" | "curious" | "sleepy" | "playful" | "focused" | "calm";

export type PersonalityProfile = {
  minWaitSeconds: number;
  maxWaitSeconds: number;
  recentHistorySize: number;
  repeatPenalty: number;
  moodWeights: Readonly<Record<PersonalityMood, number>>;
};

const PROFILES: Readonly<Record<PersonalityMode, PersonalityProfile>> = {
  chill: {
    minWaitSeconds: 48, maxWaitSeconds: 82, recentHistorySize: 3, repeatPenalty: 0.12,
    moodWeights: { happy: 0.12, curious: 0.12, sleepy: 0.30, playful: 0.06, focused: 0.10, calm: 0.30 },
  },
  balanced: {
    minWaitSeconds: 28, maxWaitSeconds: 52, recentHistorySize: 3, repeatPenalty: 0.08,
    moodWeights: { happy: 0.24, curious: 0.22, sleepy: 0.10, playful: 0.18, focused: 0.10, calm: 0.16 },
  },
  hyper: {
    minWaitSeconds: 15, maxWaitSeconds: 30, recentHistorySize: 2, repeatPenalty: 0.04,
    moodWeights: { happy: 0.25, curious: 0.20, sleepy: 0.02, playful: 0.32, focused: 0.04, calm: 0.07 },
  },
};

export function getPersonalityProfile(mode: PersonalityMode): PersonalityProfile {
  return PROFILES[mode] ?? PROFILES.balanced;
}

export function choosePersonalityMood(mode: PersonalityMode, random = Math.random): PersonalityMood {
  const weights = getPersonalityProfile(mode).moodWeights;
  const total = Object.values(weights).reduce((sum, weight) => sum + weight, 0);
  let needle = random() * total;
  for (const [mood, weight] of Object.entries(weights) as [PersonalityMood, number][]) {
    needle -= weight;
    if (needle <= 0) return mood;
  }
  return "calm";
}

export function chooseGesture<T extends string>(
  candidates: readonly T[],
  recent: readonly T[],
  mode: PersonalityMode,
  random = Math.random,
): T | null {
  if (candidates.length === 0) return null;
  const profile = getPersonalityProfile(mode);
  const ranked = candidates.map((id) => {
    const recentIndex = recent.lastIndexOf(id);
    const penalty = recentIndex < 0 ? 1 : profile.repeatPenalty / (recent.length - recentIndex);
    return { id, weight: Math.max(0.01, 1 - penalty) };
  });
  const total = ranked.reduce((sum, item) => sum + item.weight, 0);
  let needle = random() * total;
  for (const item of ranked) {
    needle -= item.weight;
    if (needle <= 0) return item.id;
  }
  return ranked[ranked.length - 1]?.id ?? null;
}

export function nextPersonalityWait(mode: PersonalityMode, random = Math.random): number {
  const profile = getPersonalityProfile(mode);
  return profile.minWaitSeconds + random() * (profile.maxWaitSeconds - profile.minWaitSeconds);
}
