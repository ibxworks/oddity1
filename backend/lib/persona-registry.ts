import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export type RegisteredPersona = {
  slug: string;
  displayName: string;
  prompt: string;
};

const __dirname = dirname(fileURLToPath(import.meta.url));
const PERSONAS_DIR = join(__dirname, "../config/personas-public-figures");

const registry = new Map<string, RegisteredPersona>();

function loadRegistry(): void {
  let files: string[];
  try {
    files = readdirSync(PERSONAS_DIR);
  } catch {
    console.warn("[persona-registry] Could not read personas directory:", PERSONAS_DIR);
    return;
  }

  for (const file of files) {
    if (!file.endsWith(".json")) continue;

    const slug = basename(file, ".json");
    const promptPath = join(PERSONAS_DIR, `${slug}.prompt`);

    if (!existsSync(promptPath)) {
      // Silently skip — prompt file not yet curated
      continue;
    }

    try {
      const json = JSON.parse(readFileSync(join(PERSONAS_DIR, file), "utf-8")) as {
        meta?: { person?: string };
      };
      const displayName = json?.meta?.person;
      if (!displayName) {
        console.warn(`[persona-registry] Skipping ${slug}: missing meta.person`);
        continue;
      }

      const prompt = readFileSync(promptPath, "utf-8");
      registry.set(slug, { slug, displayName, prompt });
    } catch (err) {
      console.warn(`[persona-registry] Failed to load persona ${slug}:`, err);
    }
  }

  if (registry.size > 0) {
    console.log(
      `[persona-registry] Loaded ${registry.size} persona(s):`,
      [...registry.keys()].join(", "),
    );
  }
}

// Load at module initialization (once per process / cold start)
loadRegistry();

export function getPersona(slug: string): RegisteredPersona | undefined {
  return registry.get(slug);
}

export function getAllPersonas(): RegisteredPersona[] {
  return [...registry.values()];
}

export function isValidPersonaSlug(slug: string): boolean {
  return registry.has(slug);
}
