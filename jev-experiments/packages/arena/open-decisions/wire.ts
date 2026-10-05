/**
 * SGLang's System One answers (noul / choice / score with x_label_mass) in the wire shape our
 * recordings already use for Jev and Laya: { type, value, probabilities, confidence }. The
 * translation lives in the Jev client package, beside the gateway's own normalization.
 */
export { toWire, type Raw, type WireAnswer } from "../../jev-client/src/wire";
