import {
  DEFAULT_SEED_FLOW_TEMPLATES,
  createStarterFlowSpec,
  formatFlowSpecJson,
} from "@t3tools/shared/lunacodeFlowPresets";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

export const FLOW_PRESETS_SEED_MARKER_FILE = ".lunacode-flow-presets.json";
const FLOW_PRESETS_SEED_VERSION = 1;

const SeedMarkerSchema = Schema.Struct({
  version: Schema.Int,
});

const decodeSeedMarkerExit = Schema.decodeUnknownExit(Schema.fromJsonString(SeedMarkerSchema));
const encodeSeedMarkerJson = (version: number) => `${JSON.stringify({ version }, null, 2)}\n`;

export interface SeedDefaultFlowsResult {
  readonly seededFiles: ReadonlyArray<string>;
}

/**
 * Seeds the 6 curated default `.flow.json` workflow templates once per workspace/home folder.
 * Uses a dot-prefixed marker file (ignored by WorkflowRuntime) so user deletions stay respected
 * and existing files on disk are never overwritten.
 */
export const seedDefaultFlowsIfNeeded = Effect.fn("lunacode.workflows.seedDefaultFlowsIfNeeded")(
  function* (opts: {
    readonly directory: string;
    readonly projectId?: string | null;
  }): Effect.fn.Return<SeedDefaultFlowsResult, never, FileSystem.FileSystem | Path.Path> {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const markerPath = path.join(opts.directory, FLOW_PRESETS_SEED_MARKER_FILE);

    const markerExists = yield* fs.exists(markerPath).pipe(Effect.orElseSucceed(() => false));
    if (markerExists) {
      const markerRaw = yield* fs.readFileString(markerPath).pipe(Effect.orElseSucceed(() => ""));
      const decoded = decodeSeedMarkerExit(markerRaw);
      if (decoded._tag === "Success" && decoded.value.version >= FLOW_PRESETS_SEED_VERSION) {
        return { seededFiles: [] };
      }
    }

    yield* fs
      .makeDirectory(opts.directory, { recursive: true })
      .pipe(Effect.orElseSucceed(() => {}));

    const project =
      opts.projectId && opts.projectId.trim().length > 0
        ? opts.projectId.trim()
        : "default-project";
    const seededFiles: Array<string> = [];

    for (const template of DEFAULT_SEED_FLOW_TEMPLATES) {
      const targetPath = path.join(opts.directory, template.defaultFileName);
      const exists = yield* fs.exists(targetPath).pipe(Effect.orElseSucceed(() => true));
      if (exists) continue;
      const spec = createStarterFlowSpec({
        name: template.defaultFileName.replace(/\.flow\.json$/i, ""),
        template: template.id,
        project,
      });
      const wrote = yield* fs.writeFileString(targetPath, formatFlowSpecJson(spec)).pipe(
        Effect.as(true),
        Effect.orElseSucceed(() => false),
      );
      if (wrote) {
        seededFiles.push(template.defaultFileName);
      }
    }

    yield* fs
      .writeFileString(markerPath, encodeSeedMarkerJson(FLOW_PRESETS_SEED_VERSION))
      .pipe(Effect.orElseSucceed(() => {}));

    return { seededFiles };
  },
);
