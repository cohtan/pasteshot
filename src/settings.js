export const RESOLUTIONS = {
  standard: {
    id: "standard",
    maxWidth: 1280,
    sharp: false,
  },
  screen: {
    id: "screen",
    maxWidth: 3840,
    sharp: false,
  },
  sharp: {
    id: "sharp",
    maxWidth: 3840,
    sharp: true,
  },
};

export const DEFAULT_RESOLUTION = "standard";
const STORAGE_KEY = "resolution";

export function resolutionById(id) {
  return RESOLUTIONS[id] || RESOLUTIONS[DEFAULT_RESOLUTION];
}

export function outputLimits(preset, pixelRatio = 1) {
  return {
    maxWidth: preset.maxWidth,
    pixelRatio: preset.sharp ? Math.max(pixelRatio, 1) : 1,
  };
}

async function readStoredId() {
  try {
    const sync = await chrome.storage.sync.get(STORAGE_KEY);
    if (typeof sync[STORAGE_KEY] === "string") return sync[STORAGE_KEY];
  } catch {
    /* Sync storage is unavailable in some browser profiles. */
  }
  const local = await chrome.storage.local.get(STORAGE_KEY);
  return local[STORAGE_KEY];
}

export async function getResolution() {
  try {
    return resolutionById(await readStoredId());
  } catch {
    return RESOLUTIONS[DEFAULT_RESOLUTION];
  }
}

export async function setResolution(id) {
  const preset = resolutionById(id);
  await chrome.storage.local.set({ [STORAGE_KEY]: preset.id });
  try {
    await chrome.storage.sync.set({ [STORAGE_KEY]: preset.id });
  } catch {
    /* Local storage already has the choice. */
  }
  return preset;
}
