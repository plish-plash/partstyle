import type { PartSource } from "../parts/library.js";

export interface TextFile {
  /** Path relative to the project root, with forward slashes. */
  file: string;
  text: string;
}

/** Everything the engine reads from a project, as text. Produced by the node loader or by tests. */
export interface ProjectSource {
  config: TextFile;
  /** context.md: YAML front matter for checks, prose for people and the AI. */
  context?: TextFile;
  circuits: TextFile[];
  parts: PartSource[];
}
