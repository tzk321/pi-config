import { existsSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Apply on /reload too, without requiring a new parent shell.
export default function (_pi: ExtensionAPI) {
  process.env.PI_LENS_DISABLE_LSP_INSTALL = "1";
  process.env.PI_LENS_DISABLE_TOOL_INSTALL = "1";
  // Use the verified local CPU backend and embedding model; no CUDA toolchain required.
  // Local keyword/semantic/deep search and incremental embeddings verified.
  process.env.PI_MEMORY_QMD_UPDATE = "background";
  process.env.QMD_FORCE_CPU = "1";
  const embed = `${process.env.HOME}/.cache/qmd/models/embeddinggemma-300M-Q8_0.gguf`;
  if (existsSync(embed)) process.env.QMD_EMBED_MODEL = embed;
}
