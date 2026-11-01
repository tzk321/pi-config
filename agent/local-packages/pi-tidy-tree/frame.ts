/**
 * Public entry for the frame patches. The work lives in:
 *
 *   frame-draw.ts       border drawing and escape-aware string helpers
 *   tool-frame.ts       ToolExecutionComponent: the box, its clicks
 *   tool-group-view.ts  how a box looks and reacts inside a group
 *   tool-groups.ts      the grouping state machine
 *   message-frame.ts    compaction / branch / skill / custom / user boxes
 */

export { stripBackgroundFills } from "./frame-draw.ts";
export { patchToolBoxFrames, type ToolFrameOptions } from "./tool-frame.ts";
export { patchContainerBoxes, patchMessageBoxes, type ContainerBoxOptions } from "./message-frame.ts";
