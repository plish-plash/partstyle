import type { PartSource } from "../parts/library.js";

export interface TextFile {
  /** Path relative to the project root, with forward slashes. */
  file: string;
  text: string;
}

/** Everything the engine reads from a project, as text. Produced by the node loader or by tests. */
export interface ProjectSource {
  /** partstyle-project.yaml: the project's name, settings and design context. */
  project: TextFile;
  /** comments.yaml: review comments from the viewer. */
  comments?: TextFile;
  circuits: TextFile[];
  parts: PartSource[];
}
