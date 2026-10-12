import { contextBridge, ipcRenderer } from "electron";
import type { Api } from "../shared/api";

const api: Api = {
  appInfo: () => ipcRenderer.invoke("app:info"),
  engineReady: () => ipcRenderer.invoke("engine:ready"),
  getStats: () => ipcRenderer.invoke("engine:stats"),
  searchRubrics: (query, mode, limit) => ipcRenderer.invoke("search:rubrics", query, mode, limit),
  searchRemedies: (query, limit) => ipcRenderer.invoke("search:remedies", query, limit),
  remediesForRubric: (rubricId) => ipcRenderer.invoke("rubric:remedies", rubricId),
  repertorize: (symptoms, opts) => ipcRenderer.invoke("repertorize", symptoms, opts),
  candidatesForSymptom: (symptom, limit) => ipcRenderer.invoke("mapper:candidates", symptom, limit),
  normalizeSymptom: (symptom) => ipcRenderer.invoke("mapper:normalize", symptom),
  getCycle: (remedy) => ipcRenderer.invoke("cycle:get", remedy),
  live: {
    status: () => ipcRenderer.invoke("live:status"),
    snapshot: () => ipcRenderer.invoke("live:snapshot"),
    telemetry: () => ipcRenderer.invoke("live:telemetry"),
    pause: () => ipcRenderer.invoke("live:pause"),
    resume: () => ipcRenderer.invoke("live:resume"),
    refreshDb: () => ipcRenderer.invoke("live:refresh"),
  },
  onLiveEvent: (cb) => {
    const wrapped = (_e: unknown, data: unknown) => cb(data as any);
    ipcRenderer.on("live:change", wrapped);
    ipcRenderer.on("engine:ready", wrapped);
    ipcRenderer.on("engine:error", wrapped);
  },
};

contextBridge.exposeInMainWorld("oorep", api);
