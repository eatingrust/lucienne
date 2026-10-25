/** Approved Oct 25 scope. Personas come from profile service; this module never invents them. */
export const sources = ["photoshop", "illustrator", "gimp", "premiere", "after-effects", "resolve"] as const;
export type SourceApp = (typeof sources)[number];
export const targets = ["blender", "krita", "reaper", "kdenlive"] as const;
export type TargetApp = (typeof targets)[number];
export const routes = sources.flatMap((source) =>
  (sources.indexOf(source) < 3 ? ["blender", "krita", "kdenlive"] : ["blender", "reaper", "kdenlive"])
    .map((target) => ({ source, target: target as TargetApp, id: `${source}--${target}` })),
);
export const taskActions: Record<TargetApp, readonly string[]> = {
  blender: ["select", "move"], krita: ["paint", "select", "transform"],
  reaper: ["split", "trim", "play"], kdenlive: ["cut", "trim", "play"],
};
export const chatIntents = ["move-key-panels", "enlarge-work-area", "simplify-tools"] as const;
export type PersonaRoster = Record<SourceApp, readonly string[]>;
export function validateRoster(roster: PersonaRoster): void {
  if (!roster || Object.keys(roster).length !== sources.length) throw new Error("Expected exactly six source rosters");
  for (const source of sources) {
    const ids = roster[source];
    if (!Array.isArray(ids) || ids.length !== 3 || new Set(ids).size !== 3 || [...ids].some((id) => typeof id !== "string" || !/^[a-z0-9][a-z0-9._-]*$/i.test(id))) {
      throw new Error(`${source} requires three distinct actual persona IDs`);
    }
  }
}
export function matrix(roster: PersonaRoster) {
  validateRoster(roster);
  return routes.flatMap((route) => roster[route.source].map((personaId) => ({
    ...route, personaId, caseId: `${route.id}--${personaId}`,
    actions: taskActions[route.target], chatIntents,
    requiresMontageTitle: sources.indexOf(route.source) < 3 && route.target === "kdenlive",
  })));
}
