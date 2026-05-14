export interface OpenAiEndpoint {
  id: string;
  name: string;
  baseUrl: string;
  apiKey?: string;
  models: string[];
}

export interface SelectedModel {
  endpointId: string;
  model: string;
}

export interface ModelSettings {
  endpoints: OpenAiEndpoint[];
  selected?: SelectedModel;
}

export const MODEL_SETTINGS_CHANGED = "luna:model-settings-changed";

const MODEL_SETTINGS_KEY = "luna.modelSettings.v1";

let cachedSettings: ModelSettings = { endpoints: [] };
let initialized = false;

function normalizeModels(value: string | string[]) {
  const raw = Array.isArray(value) ? value : value.split(/[\n,]/);
  return raw.map((item) => item.trim()).filter(Boolean);
}

export function loadModelSettings(): ModelSettings {
  if (!initialized && typeof window !== "undefined") {
    initialized = true;
    const raw = window.localStorage.getItem(MODEL_SETTINGS_KEY);
    if (raw) {
      try {
        cachedSettings = normalizeSettings(JSON.parse(raw) as ModelSettings);
      } catch {
        cachedSettings = { endpoints: [] };
      }
    }
  }
  return cachedSettings;
}

function normalizeSettings(settings: ModelSettings): ModelSettings {
  const endpoints = settings.endpoints.map((endpoint) => ({ ...endpoint, models: normalizeModels(endpoint.models ?? []) }));
  const selected = settings.selected && endpoints.some((endpoint) => endpoint.id === settings.selected?.endpointId && endpoint.models.includes(settings.selected.model))
    ? settings.selected
    : undefined;
  return { endpoints, selected };
}

export function saveModelSettings(settings: ModelSettings) {
  cachedSettings = normalizeSettings(settings);
  initialized = true;
  if (typeof window !== "undefined") {
    window.localStorage.setItem(MODEL_SETTINGS_KEY, JSON.stringify(cachedSettings));
    window.dispatchEvent(new Event(MODEL_SETTINGS_CHANGED));
  }
}

export function upsertEndpoint(input: Omit<OpenAiEndpoint, "id"> & { id?: string }) {
  const settings = loadModelSettings();
  const endpoint: OpenAiEndpoint = {
    id: input.id ?? crypto.randomUUID(),
    name: input.name.trim(),
    baseUrl: input.baseUrl.trim().replace(/\/$/, ""),
    apiKey: input.apiKey?.trim() || undefined,
    models: normalizeModels(input.models)
  };
  const endpoints = settings.endpoints.some((item) => item.id === endpoint.id)
    ? settings.endpoints.map((item) => (item.id === endpoint.id ? endpoint : item))
    : [...settings.endpoints, endpoint];

  saveModelSettings({ endpoints, selected: settings.selected ?? (endpoint.models[0] ? { endpointId: endpoint.id, model: endpoint.models[0] } : undefined) });
}

export function deleteEndpoint(id: string) {
  const settings = loadModelSettings();
  const endpoints = settings.endpoints.filter((endpoint) => endpoint.id !== id);
  const selected = settings.selected?.endpointId === id ? undefined : settings.selected;
  saveModelSettings({ endpoints, selected });
}

export function selectModel(selected: SelectedModel) {
  const settings = loadModelSettings();
  saveModelSettings({ ...settings, selected });
}

export function getSelectedModel() {
  const settings = loadModelSettings();
  if (!settings.selected) return null;
  const endpoint = settings.endpoints.find((item) => item.id === settings.selected?.endpointId);
  if (!endpoint) return null;
  return { endpoint, model: settings.selected.model };
}
