import { getSetting } from "./store";

export type RecapMode = "automatic" | "on_open" | "off";

// Missing keys deliberately preserve the long-standing behavior: background
// work and both recap triggers are on until the user changes them.
export function backgroundJobsEnabled(): boolean {
  return getSetting("background_jobs") !== "off";
}

export function recapMode(): RecapMode {
  const value = getSetting("recap_mode");
  return value === "on_open" || value === "off" ? value : "automatic";
}

export function automaticRecapsEnabled(): boolean {
  return backgroundJobsEnabled() && recapMode() === "automatic";
}

export function openRecapsEnabled(): boolean {
  return backgroundJobsEnabled() && recapMode() !== "off";
}
