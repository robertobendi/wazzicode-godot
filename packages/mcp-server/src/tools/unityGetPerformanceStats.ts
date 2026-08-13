import { z } from "zod";
import { ToolDef } from "../registry.js";
import { BRIDGE_METHODS, bridgeCall } from "./_helpers.js";
import { PerfSampleResult } from "@uvibe/core";

const InputShape = {
  detailLevel: z.enum(["summary", "normal", "full"]).optional(),
};

export const unityGetPerformanceStats: ToolDef<typeof InputShape, PerfSampleResult> = {
  name: "unity_get_performance_stats",
  description:
    "Reads Unity's own profiler counters via Unity.Profiling.ProfilerRecorder: main-thread frame time (and estimated FPS), draw calls, batches, SetPass calls, triangles, vertices, per-frame GC allocation, and memory usage — averaged over a rolling window of recent frames. Counters only advance while frames render, so values are richest in play mode (enter with unity_enter_play_mode first). The first call after a domain reload may report warmingUp=true until samples accumulate.",
  requires: ["unity_bridge"],
  inputShape: InputShape,
  async run(args, ctx) {
    return bridgeCall<PerfSampleResult>(
      ctx.bridge,
      BRIDGE_METHODS.perfSample,
      {},
      args.detailLevel ?? "normal"
    );
  },
};
