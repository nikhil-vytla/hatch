export { decide, priorAdapter } from "./decide";
export { routeTask } from "./router";
export { routeConfiguredTask, routeConfiguredTask as route_task } from "./configured-classifier";
export { classifyEml, classifyEml as classify_eml } from "./email";
export { selectRoute, classifyTask, defaultPolicy } from "./policy";
export { executeDestination } from "./execute";
export * from "./types";
export { createDecisionClassifier, createHostClassifier } from "./classifier";
export { createMacAdapter, classifyMacEml } from "./mac-adapter";
