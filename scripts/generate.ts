import Anthropic from "@anthropic-ai/sdk";
import { generateGuide } from "../src/lib/agent/pipeline";
import { saveGuide } from "../src/lib/store";

/**
 * Generates guides from the command line: npm run generate -- "Notion" "Linear".
 * Running this over the directory is how the library would grow to 100 apps.
 */
try {
  process.loadEnvFile();
} catch {
  // No .env file, so rely on the environment.
}

const names = process.argv.slice(2);
if (names.length === 0) {
  console.error('Usage: npm run generate -- "App name" ["Another app"]');
  process.exit(1);
}

const client = new Anthropic();
for (const name of names) {
  const started = Date.now();
  console.log(`\n${name}`);
  const guide = await generateGuide(name, {
    client,
    signal: AbortSignal.timeout(8 * 60_000),
    emit: (event) => console.log(`  [${event.stage}] ${event.message}`),
  });
  saveGuide(guide);
  const labels = guide.claims.reduce<Record<string, number>>((all, claim) => ({ ...all, [claim.label]: (all[claim.label] ?? 0) + 1 }), {});
  console.log(`  Saved /guides/${guide.slug} in ${Math.round((Date.now() - started) / 1000)}s`, labels);
}
