import { download } from "../../api";
import { sourceFileName, type SourceFile } from "./source";

/** Download the same raw text that is fingerprinted, never a transformed asset URL. */
export function downloadSource(source: SourceFile) {
  download(sourceFileName(source), source.text, "text/plain");
}
