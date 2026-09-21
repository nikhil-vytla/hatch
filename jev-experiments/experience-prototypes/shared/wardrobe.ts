// Public protocol constants shared by the browser, recorder and deployed API.
// Keep the API dependency inside this ESM package; outside-root research files
// can be compiled using a different module format by the deployment builder.
export const FAL_MODEL = "decart/lucy2-vton/realtime";
export const SESSION_SECONDS = 60;
