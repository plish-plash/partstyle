import { cpSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Tests never read or write the real ~/.partstyle. Their settings list a copy of the repo's seed
// library (which the example project uses beside its own parts/), so a test that writes a seed
// record cannot change the repo; a test that needs other settings passes its own state folder.
// A test that writes the example's or a fixture's own records works on a copy of the project.
const state = mkdtempSync(path.join(tmpdir(), "partstyle-state-"));
const library = path.join(state, "library");
cpSync(fileURLToPath(new URL("./library", import.meta.url)), library, { recursive: true });
writeFileSync(path.join(state, "settings.yaml"), "libraries: [library]\n");
process.env.PARTSTYLE_STATE_DIR = state;
