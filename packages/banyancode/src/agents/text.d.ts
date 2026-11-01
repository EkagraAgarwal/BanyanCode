// Bun imports `.txt` assets as their UTF-8 contents, which also embeds them
// when the binary is compiled. Prompt files are loaded this way so the plugin
// ships no runtime filesystem reads (see the Phase 2 risk about embedded assets).
declare module "*.txt" {
  const content: string
  export default content
}
