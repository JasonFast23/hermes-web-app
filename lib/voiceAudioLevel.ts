// A live 0-1 volume value updated up to 60x/second while Eva's voice is
// playing. Deliberately NOT Zustand/React state — a value that changes
// every animation frame has no business going through a render cycle;
// every subscriber would re-render 60 times a second for a number nobody
// needs to reason about, just draw. VoiceSession writes to `.current`
// directly from its audio-analysis loop; anything that wants to visualize
// it (the reactive orb in ChatPanel) runs its own requestAnimationFrame
// loop reading this and applies the value straight to a DOM node's style,
// bypassing React entirely for the actual animation.
export const voiceAudioLevelRef = { current: 0 };
