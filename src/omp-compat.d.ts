declare module "@earendil-works/pi-coding-agent" {
  import type { Settings } from "@oh-my-pi/pi-coding-agent";
  /** OMP's documented compatibility loader returns the callback's scoped Settings instance. */
  export const SettingsManager: { create(cwd?: string, agentDir?: string): Settings | Promise<Settings> };
}
