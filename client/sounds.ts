/**
 * The three notification cues, imported as data URLs by the client build.
 *
 * The build script inlines each MP3, so the bundle stays a single script and
 * the plugin needs no asset route. Browsers may refuse playback before the
 * page has seen a user gesture; the refused attempt is dropped rather than
 * queued — a stale approval sound played minutes later would be worse than
 * silence, and the result cues arrive after the task has actually finished.
 */

import approval from "../assets/sounds/approval.mp3";
import failed from "../assets/sounds/failed.mp3";
import success from "../assets/sounds/success.mp3";

/** One cue: a request appeared, a task completed, or a task failed. */
export type PodSound = "approval" | "success" | "failed";

const SOURCES: Record<PodSound, string> = { approval, failed, success };

/** Low enough to sit under a conversation, loud enough to notice from another window. */
const VOLUME = 0.7;

const players = new Map<PodSound, HTMLAudioElement>();

/** The one element for a cue, created on first use and reused afterwards. */
function player(name: PodSound): HTMLAudioElement {
  let audio = players.get(name);
  if (audio === undefined) {
    audio = new Audio(SOURCES[name]);
    audio.preload = "auto";
    audio.volume = VOLUME;
    players.set(name, audio);
  }
  return audio;
}

/** Play one cue now; a refused autoplay attempt is dropped. */
export function playSound(name: PodSound): void {
  if (typeof Audio === "undefined") return;
  const audio = player(name);
  audio.currentTime = 0;
  void audio.play().catch(() => {});
}
