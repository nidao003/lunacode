import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { DEFAULT_SEED_FLOW_TEMPLATES } from "@t3tools/shared/lunacodeFlowPresets";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { compileFlowSpec } from "../../workflows/flow/FlowCompiler.ts";
import { parseFlowSpecFromJson } from "../../workflows/flow/FlowLoader.ts";
import { validateFlowSpec } from "../../workflows/flow/FlowValidator.ts";
import { FLOW_PRESETS_SEED_MARKER_FILE, seedDefaultFlowsIfNeeded } from "./defaultFlowSeeding.ts";

it.effect(
  "seeds 6 curated valid .flow.json templates once and respects marker and existing files",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "lunacode-flow-seed-" });

      // Pre-create one file with custom content before initial seeding.
      const customSource = '{"custom": true}\n';
      const customTarget = path.join(dir, DEFAULT_SEED_FLOW_TEMPLATES[0]!.defaultFileName);
      yield* fs.writeFileString(customTarget, customSource);

      const firstRun = yield* seedDefaultFlowsIfNeeded({
        directory: dir,
        projectId: "proj-test",
      });

      expect(firstRun.seededFiles).toHaveLength(DEFAULT_SEED_FLOW_TEMPLATES.length - 1);
      expect(firstRun.seededFiles).not.toContain(DEFAULT_SEED_FLOW_TEMPLATES[0]!.defaultFileName);
      expect(yield* fs.readFileString(customTarget)).toBe(customSource);
      expect(yield* fs.exists(path.join(dir, FLOW_PRESETS_SEED_MARKER_FILE))).toBe(true);

      // Every newly seeded .flow.json must parse, validate with 0 errors, and compile cleanly.
      for (const fileName of firstRun.seededFiles) {
        const raw = yield* fs.readFileString(path.join(dir, fileName));
        const spec = parseFlowSpecFromJson(raw);
        expect(spec.triggers.every((t) => t.kind === "manual")).toBe(true);
        const validation = validateFlowSpec(spec);
        expect(validation.issues.filter((issue) => issue.severity === "error")).toEqual([]);
        const compiled = compileFlowSpec(spec);
        expect(compiled.name).toBe(spec.name);
      }

      // Deleting a seeded template later must stay deleted on subsequent startups.
      const deletedFile = path.join(dir, firstRun.seededFiles[0]!);
      yield* fs.remove(deletedFile);
      const secondRun = yield* seedDefaultFlowsIfNeeded({
        directory: dir,
        projectId: "proj-test",
      });
      expect(secondRun.seededFiles).toEqual([]);
      expect(yield* fs.exists(deletedFile)).toBe(false);
    }).pipe(Effect.provide(NodeServices.layer)),
);
