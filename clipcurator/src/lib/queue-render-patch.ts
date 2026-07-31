// PATCH for src/lib/queue.ts — add layout to the render request
//
// In the runRenderFinalClip function, find the renderReq object
// and add the layout field. The layout is stored in the clip's
// subtitleStyle field as JSON (alongside the subtitle style + splitRatio).
//
// Add this to the renderReq object:
//   layout: clip.subtitleStyle
//     ? (() => {
//         try {
//           return JSON.parse(clip.subtitleStyle).layout ?? "original";
//         } catch { return "original"; }
//       })()
//     : "original",

// Also extract splitRatio if needed for vertical_split layout.
// The clipper reads splitRatio from the layout parameter for now
// (it's embedded in the layout string as "vertical_split:0.3").
// If you want to pass it separately, add splitRatio to RenderRequest
// in clipper-client.ts and to the clipper's RenderRequest model.

// APPLY: Add this import at the top of queue.ts if not present:
// import type { VideoLayout } from "@/store/queue";
