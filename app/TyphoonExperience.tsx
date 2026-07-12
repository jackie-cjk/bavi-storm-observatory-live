"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";

type ViewMode = "live" | "replay" | "beijing";
type DataMode = "live" | "delayed" | "snapshot";

type TrackPoint = {
  id: number;
  validAt: string;
  latitude: number;
  longitude: number;
  classification: { code: string; label: string };
  pressureHpa: number | null;
  maxWindMs: number | null;
  movement?: { direction: string | null; speedKmh: number | null };
  windRadiiKm?: Array<{
    thresholdKts: number;
    northeast: number | null;
    southeast: number | null;
    southwest: number | null;
    northwest: number | null;
  }>;
  distanceToBeijingKm?: number;
};

type ForecastPoint = TrackPoint & {
  leadHours: number;
  baseAt?: string;
  agency?: string;
};

type TyphoonPayload = {
  schemaVersion: string;
  status: { mode: "live" | "fallback"; active: boolean; message: string };
  updatedAt: string;
  generatedAt: string;
  source: {
    provider: string;
    agency: string;
    product: string;
    detailUrl: string;
    isFallback: boolean;
  };
  storm: {
    id: string;
    name: string;
    localName: string;
    basin: string;
    current: TrackPoint;
  };
  observed: TrackPoint[];
  forecast: ForecastPoint[];
  beijing: {
    currentDistanceKm: number;
    minDistanceKm: number | null;
    closestForecast: {
      validAt: string;
      leadHours: number;
      distanceKm: number;
      latitude: number;
      longitude: number;
    } | null;
  };
};

const BEIJING = { latitude: 39.9042, longitude: 116.4074 };
const BAVI_CACHE_KEY = "bavi-live-cache-v1";
const NMC_LIST_ENDPOINT =
  "https://typhoon.nmc.cn/weatherservice/typhoon/jsons/list_default";
const NMC_DETAIL_ENDPOINT =
  "https://typhoon.nmc.cn/weatherservice/typhoon/jsons";
const NMC_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== ""
    ? value.trim()
    : null;
}

function compactUtcToIso(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = value.trim().match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})$/);
  if (!match) return null;

  const timestamp = Date.UTC(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    Number(match[4]),
    Number(match[5]),
  );
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function epochToIso(value: unknown): string | null {
  const timestamp = finiteNumber(value);
  if (timestamp === null) return null;
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function isWholeOuterParentheses(value: string): boolean {
  if (!value.startsWith("(") || !value.endsWith(")")) return false;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }

    if (character === '"') inString = true;
    else if (character === "(") depth += 1;
    else if (character === ")") {
      depth -= 1;
      if (depth < 0 || (depth === 0 && index !== value.length - 1)) return false;
    }
  }
  return depth === 0 && !inString;
}

/** Strip NMC's JSONP wrapper and parse only the enclosed JSON; never execute it. */
function parseNmcPayload(text: string): unknown {
  if (text.length === 0 || text.length > NMC_MAX_RESPONSE_BYTES) {
    throw new Error("NMC response size is invalid");
  }

  let payload = text.replace(/^\uFEFF/, "").trim();
  if (payload.startsWith("{") || payload.startsWith("[")) {
    return JSON.parse(payload) as unknown;
  }

  const callbackMatch = payload.match(
    /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\s*\(/,
  );
  if (!callbackMatch) throw new Error("NMC response is not JSON or JSONP");

  let end = payload.length;
  while (end > 0 && /\s/.test(payload[end - 1])) end -= 1;
  if (payload[end - 1] === ";") {
    end -= 1;
    while (end > 0 && /\s/.test(payload[end - 1])) end -= 1;
  }
  if (payload[end - 1] !== ")") {
    throw new Error("NMC JSONP wrapper is incomplete");
  }

  payload = payload.slice(payload.indexOf("(") + 1, end - 1).trim();
  while (isWholeOuterParentheses(payload)) {
    payload = payload.slice(1, -1).trim();
  }
  if (!payload.startsWith("{") && !payload.startsWith("[")) {
    throw new Error("NMC JSONP payload is not JSON");
  }
  return JSON.parse(payload) as unknown;
}

async function fetchNmcText(url: string, signal: AbortSignal): Promise<string> {
  const response = await fetch(url, {
    cache: "no-store",
    credentials: "omit",
    mode: "cors",
    referrerPolicy: "no-referrer",
    signal,
  });
  if (!response.ok) throw new Error(`NMC request failed with ${response.status}`);

  const declaredLength = finiteNumber(response.headers.get("content-length"));
  if (declaredLength !== null && declaredLength > NMC_MAX_RESPONSE_BYTES) {
    throw new Error("NMC response exceeds the size limit");
  }
  const text = await response.text();
  if (new TextEncoder().encode(text).byteLength > NMC_MAX_RESPONSE_BYTES) {
    throw new Error("NMC response exceeds the size limit");
  }
  return text;
}

function normalizeWindRadii(value: unknown): NonNullable<TrackPoint["windRadiiKm"]> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((raw) => {
    if (!Array.isArray(raw)) return [];
    const threshold = String(raw[0] ?? "").match(/\d+/);
    const thresholdKts = threshold ? finiteNumber(threshold[0]) : null;
    if (thresholdKts === null) return [];
    return [{
      thresholdKts,
      northeast: finiteNumber(raw[1]),
      southeast: finiteNumber(raw[2]),
      southwest: finiteNumber(raw[3]),
      northwest: finiteNumber(raw[4]),
    }];
  });
}

function normalizeObservation(value: unknown): TrackPoint | null {
  if (!Array.isArray(value)) return null;
  const id = finiteNumber(value[0]);
  const longitude = finiteNumber(value[4]);
  const latitude = finiteNumber(value[5]);
  const validAt = epochToIso(value[2]) ?? compactUtcToIso(value[1]);
  if (
    id === null || longitude === null || latitude === null || validAt === null ||
    longitude < -180 || longitude > 180 || latitude < -90 || latitude > 90
  ) return null;

  const code = nullableString(value[3]) ?? "UNKNOWN";
  return {
    id,
    validAt,
    longitude,
    latitude,
    classification: { code, label: intensityLabel(code) },
    pressureHpa: finiteNumber(value[6]),
    maxWindMs: finiteNumber(value[7]),
    movement: {
      direction: nullableString(value[8]),
      speedKmh: finiteNumber(value[9]),
    },
    windRadiiKm: normalizeWindRadii(value[10]),
    distanceToBeijingKm: Math.round(
      haversine(latitude, longitude, BEIJING.latitude, BEIJING.longitude),
    ),
  };
}

function normalizeForecast(value: unknown): ForecastPoint | null {
  if (!Array.isArray(value)) return null;
  const leadHours = finiteNumber(value[0]);
  const baseAt = compactUtcToIso(value[1]);
  const longitude = finiteNumber(value[2]);
  const latitude = finiteNumber(value[3]);
  const agency = nullableString(value[6])?.toUpperCase();
  if (
    leadHours === null || baseAt === null || longitude === null || latitude === null ||
    agency !== "BABJ" || longitude < -180 || longitude > 180 ||
    latitude < -90 || latitude > 90
  ) return null;

  const validAtTimestamp = Date.parse(baseAt) + leadHours * 3_600_000;
  const code = nullableString(value[7]) ?? "UNKNOWN";
  return {
    id: validAtTimestamp,
    leadHours,
    baseAt,
    validAt: new Date(validAtTimestamp).toISOString(),
    longitude,
    latitude,
    classification: { code, label: intensityLabel(code) },
    pressureHpa: finiteNumber(value[4]),
    maxWindMs: finiteNumber(value[5]),
    agency: "BABJ",
    distanceToBeijingKm: Math.round(
      haversine(latitude, longitude, BEIJING.latitude, BEIJING.longitude),
    ),
  };
}

function titleCaseName(name: string) {
  return name
    .toLowerCase()
    .split(/([\s-]+)/)
    .map((part) => (/^[a-z]/.test(part) ? part[0].toUpperCase() + part.slice(1) : part))
    .join("");
}

async function fetchDirectNmcBavi(signal: AbortSignal): Promise<TyphoonPayload> {
  const listUrl = new URL(NMC_LIST_ENDPOINT);
  listUrl.searchParams.set("t", String(Date.now()));
  listUrl.searchParams.set("callback", "typhoon_jsons_list_default");
  const listPayload = parseNmcPayload(await fetchNmcText(listUrl.href, signal));
  if (!isRecord(listPayload) || !Array.isArray(listPayload.typhoonList)) {
    throw new Error("NMC typhoon list has an unexpected shape");
  }

  const matches = listPayload.typhoonList.filter(
    (entry) => Array.isArray(entry) && nullableString(entry[1])?.toUpperCase() === "BAVI",
  );
  const listEntry = matches.find(
    (entry) => Array.isArray(entry) && nullableString(entry[7])?.toLowerCase() === "start",
  ) ?? matches[0];
  if (!Array.isArray(listEntry)) throw new Error("Bavi is not present in the NMC list");
  const internalId = finiteNumber(listEntry[0]);
  if (internalId === null) throw new Error("Bavi has no NMC internal id");

  const callback = `typhoon_jsons_view_${internalId}`;
  const detailUrl = new URL(`${NMC_DETAIL_ENDPOINT}/view_${internalId}`);
  detailUrl.searchParams.set("t", String(Date.now()));
  detailUrl.searchParams.set("callback", callback);
  const detailPayload = parseNmcPayload(await fetchNmcText(detailUrl.href, signal));
  if (!isRecord(detailPayload) || !Array.isArray(detailPayload.typhoon)) {
    throw new Error("NMC Bavi detail has an unexpected shape");
  }

  const typhoon = detailPayload.typhoon;
  const rawPoints = typhoon[8];
  if (!Array.isArray(rawPoints)) throw new Error("NMC Bavi detail contains no track");
  const observed = rawPoints
    .map(normalizeObservation)
    .filter((point): point is TrackPoint => point !== null)
    .sort((left, right) => left.validAt.localeCompare(right.validAt));
  if (observed.length < 2) throw new Error("NMC Bavi track is empty");

  let rawBabjForecast: unknown[] = [];
  for (let index = rawPoints.length - 1; index >= 0; index -= 1) {
    const rawPoint = rawPoints[index];
    if (!Array.isArray(rawPoint) || !isRecord(rawPoint[11])) continue;
    const candidate = rawPoint[11].BABJ;
    if (Array.isArray(candidate) && candidate.length > 0) {
      rawBabjForecast = candidate;
      break;
    }
  }
  const forecast = rawBabjForecast
    .map(normalizeForecast)
    .filter((point): point is ForecastPoint => point !== null)
    .sort((left, right) => left.leadHours - right.leadHours);
  if (forecast.length === 0) throw new Error("NMC Bavi detail contains no BABJ forecast");

  const current = observed[observed.length - 1];
  const closestForecast = forecast.reduce<ForecastPoint | null>(
    (closest, point) => closest === null ||
      (point.distanceToBeijingKm ?? Infinity) < (closest.distanceToBeijingKm ?? Infinity)
      ? point
      : closest,
    null,
  );
  const generatedAt = new Date().toISOString();
  return {
    schemaVersion: "1.0",
    status: {
      mode: "live",
      active: nullableString(typhoon[7])?.toLowerCase() === "start" ||
        nullableString(listEntry[7])?.toLowerCase() === "start",
      message: "Live CMA/NMC observation and BABJ forecast.",
    },
    updatedAt: current.validAt,
    generatedAt,
    source: {
      provider: "China Meteorological Administration — National Meteorological Center",
      agency: "CMA / NMC",
      product: "Official typhoon track and BABJ forecast",
      detailUrl: detailUrl.href,
      isFallback: false,
    },
    storm: {
      id: String(typhoon[3] ?? listEntry[3] ?? "2609"),
      name: titleCaseName(nullableString(typhoon[1]) ?? "BAVI"),
      localName: nullableString(typhoon[2]) ?? "巴威",
      basin: "Western North Pacific",
      current,
    },
    observed,
    forecast,
    beijing: {
      currentDistanceKm: current.distanceToBeijingKm ?? Math.round(
        haversine(current.latitude, current.longitude, BEIJING.latitude, BEIJING.longitude),
      ),
      minDistanceKm: closestForecast?.distanceToBeijingKm ?? null,
      closestForecast: closestForecast ? {
        validAt: closestForecast.validAt,
        leadHours: closestForecast.leadHours,
        distanceKm: closestForecast.distanceToBeijingKm ?? Math.round(
          haversine(
            closestForecast.latitude,
            closestForecast.longitude,
            BEIJING.latitude,
            BEIJING.longitude,
          ),
        ),
        latitude: closestForecast.latitude,
        longitude: closestForecast.longitude,
      } : null,
    },
  };
}

function isTrackPoint(value: unknown): value is TrackPoint {
  if (!isRecord(value) || !isRecord(value.classification)) return false;
  // The existing Worker forecast intentionally has no synthetic point id.
  return (value.id === undefined || finiteNumber(value.id) !== null) &&
    typeof value.validAt === "string" && Number.isFinite(Date.parse(value.validAt)) &&
    finiteNumber(value.latitude) !== null && finiteNumber(value.longitude) !== null &&
    typeof value.classification.code === "string" &&
    typeof value.classification.label === "string";
}

function isUsableTyphoonPayload(value: unknown): value is TyphoonPayload {
  if (
    !isRecord(value) || !isRecord(value.status) || !isRecord(value.source) ||
    !isRecord(value.storm) || !isRecord(value.beijing) ||
    !Array.isArray(value.observed) || !Array.isArray(value.forecast)
  ) return false;

  const statusMode = value.status.mode;
  const closestForecast = value.beijing.closestForecast;
  return value.schemaVersion === "1.0" &&
    (statusMode === "live" || statusMode === "fallback") &&
    typeof value.status.active === "boolean" &&
    typeof value.updatedAt === "string" && Number.isFinite(Date.parse(value.updatedAt)) &&
    typeof value.generatedAt === "string" && Number.isFinite(Date.parse(value.generatedAt)) &&
    typeof value.source.detailUrl === "string" &&
    isTrackPoint(value.storm.current) &&
    value.observed.length >= 2 && value.observed.every(isTrackPoint) &&
    value.forecast.every((point) => isRecord(point) &&
      finiteNumber(point.leadHours) !== null && isTrackPoint(point)) &&
    finiteNumber(value.beijing.currentDistanceKm) !== null &&
    (closestForecast === null || (
      isRecord(closestForecast) &&
      typeof closestForecast.validAt === "string" &&
      finiteNumber(closestForecast.leadHours) !== null &&
      finiteNumber(closestForecast.distanceKm) !== null &&
      finiteNumber(closestForecast.latitude) !== null &&
      finiteNumber(closestForecast.longitude) !== null
    ));
}

async function fetchPreferredPayload(signal: AbortSignal): Promise<TyphoonPayload> {
  try {
    const response = await fetch(`/api/typhoon/bavi?t=${Date.now()}`, {
      cache: "no-store",
      signal,
    });
    if (!response.ok) throw new Error("Site live feed unavailable");
    const incoming = await response.json() as unknown;
    if (!isUsableTyphoonPayload(incoming)) throw new Error("Malformed site live feed");
    return incoming;
  } catch (error) {
    if (signal.aborted) throw error;
    return fetchDirectNmcBavi(signal);
  }
}

function readCachedPayload(): TyphoonPayload | null {
  try {
    const cached = window.localStorage.getItem(BAVI_CACHE_KEY);
    if (!cached) return null;
    const parsed = JSON.parse(cached) as unknown;
    return isUsableTyphoonPayload(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function writeCachedPayload(payload: TyphoonPayload) {
  try {
    window.localStorage.setItem(BAVI_CACHE_KEY, JSON.stringify(payload));
  } catch {
    // Storage may be unavailable in privacy modes; the live view still works.
  }
}

const fallbackObserved: TrackPoint[] = [
  [1782950400000, 11, 160.1, "TS", 998, 18],
  [1783036800000, 13, 155.3, "TY", 970, 35],
  [1783123200000, 12.6, 151.6, "SuperTY", 920, 60],
  [1783209600000, 12.8, 149, "SuperTY", 920, 60],
  [1783296000000, 14.8, 145.4, "SuperTY", 910, 65],
  [1783382400000, 16.2, 139.9, "SuperTY", 915, 62],
  [1783468800000, 16.9, 134.1, "SuperTY", 915, 62],
  [1783555200000, 18.3, 130, "SuperTY", 930, 55],
  [1783598400000, 18.8, 128.8, "STY", 945, 48],
  [1783620000000, 19.9, 128.2, "STY", 945, 45],
  [1783641600000, 20.8, 127.6, "STY", 955, 42],
  [1783652400000, 21.1, 127.3, "TY", 960, 40],
].map(([time, lat, lon, code, pressure, wind], index) => ({
  id: 3_260_000 + index,
  validAt: new Date(time as number).toISOString(),
  latitude: lat as number,
  longitude: lon as number,
  classification: { code: code as string, label: intensityLabel(code as string) },
  pressureHpa: pressure as number,
  maxWindMs: wind as number,
  distanceToBeijingKm: haversine(lat as number, lon as number, BEIJING.latitude, BEIJING.longitude),
}));

const fallbackForecast: ForecastPoint[] = [
  [12, 22.9, 125.9, "STY", 955, 42],
  [24, 25.1, 123.8, "STY", 950, 45],
  [36, 26.8, 121.6, "STY", 950, 45],
  [48, 28.8, 119.3, "STS", 980, 30],
  [60, 30.8, 117.7, "TS", 995, 20],
  [72, 32.8, 116.9, "TD", 1000, 15],
].map(([lead, lat, lon, code, pressure, wind], index) => ({
  id: 3_270_000 + index,
  leadHours: lead as number,
  baseAt: "2026-07-10T03:00:00.000Z",
  validAt: new Date(1783652400000 + (lead as number) * 3_600_000).toISOString(),
  latitude: lat as number,
  longitude: lon as number,
  classification: { code: code as string, label: intensityLabel(code as string) },
  pressureHpa: pressure as number,
  maxWindMs: wind as number,
  agency: "BABJ",
  distanceToBeijingKm: haversine(lat as number, lon as number, BEIJING.latitude, BEIJING.longitude),
}));

const fallbackPayload: TyphoonPayload = {
  schemaVersion: "1.0",
  status: { mode: "fallback", active: true, message: "Bundled CMA snapshot" },
  updatedAt: "2026-07-10T03:00:00.000Z",
  generatedAt: "2026-07-10T05:40:00.000Z",
  source: {
    provider: "China Meteorological Administration — National Meteorological Center",
    agency: "CMA / NMC",
    product: "Official typhoon track and BABJ forecast",
    detailUrl: "https://typhoon.nmc.cn/weatherservice/typhoon/jsons/view_3257931",
    isFallback: true,
  },
  storm: {
    id: "2609",
    name: "Bavi",
    localName: "巴威",
    basin: "Western North Pacific",
    current: fallbackObserved[fallbackObserved.length - 1],
  },
  observed: fallbackObserved,
  forecast: fallbackForecast,
  beijing: {
    currentDistanceKm: Math.round(haversine(21.1, 127.3, BEIJING.latitude, BEIJING.longitude)),
    minDistanceKm: Math.round(Math.min(...fallbackForecast.map((point) => point.distanceToBeijingKm ?? Infinity))),
    closestForecast: {
      validAt: fallbackForecast[fallbackForecast.length - 1].validAt,
      leadHours: 72,
      distanceKm: Math.round(fallbackForecast[fallbackForecast.length - 1].distanceToBeijingKm ?? 791),
      latitude: 32.8,
      longitude: 116.9,
    },
  },
};

const VIEW_COPY: Record<ViewMode, { index: string; kicker: string; title: string; description: string }> = {
  live: {
    index: "01",
    kicker: "LIVE ORBIT",
    title: "The storm,\nmade visible.",
    description: "Official CMA analysis and BABJ forecast, rendered as a living atmospheric field.",
  },
  replay: {
    index: "02",
    kicker: "TRACK REPLAY",
    title: "Eight days of\nrapid evolution.",
    description: "Scrub the complete observed path from genesis to the latest official analysis.",
  },
  beijing: {
    index: "03",
    kicker: "BEIJING IMPACT",
    title: "Far-field rain.\nNear-term risk.",
    description: "No direct core passage in the 72-hour CMA track. Beijing’s threat is remote moisture transport.",
  },
};

function intensityLabel(code: string) {
  const labels: Record<string, string> = {
    TD: "Tropical depression",
    TS: "Tropical storm",
    STS: "Severe tropical storm",
    TY: "Typhoon",
    STY: "Severe typhoon",
    SuperTY: "Super typhoon",
  };
  return labels[code] ?? code;
}

function haversine(lat1: number, lon1: number, lat2: number, lon2: number) {
  const toRad = (value: number) => (value * Math.PI) / 180;
  const radius = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return radius * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function formatCst(iso: string, includeDate = true) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "Awaiting timestamp";
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Shanghai",
    month: includeDate ? "short" : undefined,
    day: includeDate ? "2-digit" : undefined,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

function project(longitude: number, latitude: number) {
  return new THREE.Vector3((longitude - 137) * 0.22, (latitude - 25) * 0.245, 0.12);
}

function makeTextSprite(text: string, accent = false) {
  const canvas = document.createElement("canvas");
  canvas.width = 384;
  canvas.height = 80;
  const context = canvas.getContext("2d");
  if (!context) return new THREE.Sprite();
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.font = "600 25px Arial";
  context.letterSpacing = "4px";
  context.fillStyle = accent ? "#ffb967" : "#83bed0";
  context.fillText(text, 12, 48);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const material = new THREE.SpriteMaterial({ map: texture, transparent: true, opacity: accent ? 0.92 : 0.55, depthWrite: false });
  const sprite = new THREE.Sprite(material);
  sprite.scale.set(2.2, 0.46, 1);
  return sprite;
}

function TyphoonScene({ data, view, replayIndex }: { data: TyphoonPayload; view: ViewMode; replayIndex: number }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef(view);
  const replayRef = useRef(replayIndex);

  useEffect(() => {
    viewRef.current = view;
  }, [view]);

  useEffect(() => {
    replayRef.current = replayIndex;
  }, [replayIndex]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "high-performance" });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.55));
    renderer.setSize(host.clientWidth, host.clientHeight);
    renderer.setClearColor(0x000000, 0);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    host.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    scene.fog = new THREE.FogExp2(0x02060d, 0.035);
    const camera = new THREE.PerspectiveCamera(38, host.clientWidth / host.clientHeight, 0.1, 100);
    camera.position.set(0, 0, 15.5);

    const world = new THREE.Group();
    world.rotation.x = -0.08;
    world.rotation.z = -0.025;
    scene.add(world);

    const gridMaterial = new THREE.LineBasicMaterial({ color: 0x2d9bb1, transparent: true, opacity: 0.12 });
    const gridGeometry = new THREE.BufferGeometry();
    const gridPositions: number[] = [];
    for (let lon = 105; lon <= 165; lon += 5) {
      const a = project(lon, 3);
      const b = project(lon, 48);
      gridPositions.push(a.x, a.y, 0, b.x, b.y, 0);
    }
    for (let lat = 5; lat <= 45; lat += 5) {
      const a = project(105, lat);
      const b = project(165, lat);
      gridPositions.push(a.x, a.y, 0, b.x, b.y, 0);
    }
    gridGeometry.setAttribute("position", new THREE.Float32BufferAttribute(gridPositions, 3));
    world.add(new THREE.LineSegments(gridGeometry, gridMaterial));

    const glassPlane = new THREE.Mesh(
      new THREE.PlaneGeometry(14.8, 11.7),
      new THREE.MeshBasicMaterial({ color: 0x06212d, transparent: true, opacity: 0.1, depthWrite: false }),
    );
    glassPlane.position.z = -0.04;
    world.add(glassPlane);

    const cityGroup = new THREE.Group();
    const cities = [
      ["BEIJING", 116.4074, 39.9042, true],
      ["SHANGHAI", 121.4737, 31.2304, false],
      ["TAIPEI", 121.5654, 25.033, false],
      ["MANILA", 120.9842, 14.5995, false],
      ["TOKYO", 139.6917, 35.6895, false],
    ] as const;
    for (const [name, lon, lat, accent] of cities) {
      const position = project(lon, lat);
      const dot = new THREE.Mesh(
        new THREE.CircleGeometry(accent ? 0.07 : 0.035, 24),
        new THREE.MeshBasicMaterial({ color: accent ? 0xffb45c : 0x75c5d8, transparent: true, opacity: accent ? 1 : 0.48 }),
      );
      dot.position.copy(position);
      dot.position.z = 0.18;
      cityGroup.add(dot);
      const label = makeTextSprite(name, accent);
      label.position.copy(position);
      label.position.x += 0.74;
      label.position.y += 0.18;
      label.position.z = 0.22;
      label.scale.multiplyScalar(accent ? 0.76 : 0.6);
      cityGroup.add(label);
    }
    world.add(cityGroup);

    const observedPoints = data.observed.map((point) => project(point.longitude, point.latitude));
    const latest = data.storm.current ?? data.observed[data.observed.length - 1];
    const forecastPoints = [project(latest.longitude, latest.latitude), ...data.forecast.map((point) => project(point.longitude, point.latitude))];

    const trackCurve = new THREE.CatmullRomCurve3(observedPoints, false, "centripetal", 0.32);
    const trackLine = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(trackCurve.getPoints(Math.max(80, observedPoints.length * 8))),
      new THREE.LineBasicMaterial({ color: 0x8de9f4, transparent: true, opacity: 0.82 }),
    );
    trackLine.position.z = 0.18;
    world.add(trackLine);

    let forecastCurve: THREE.CatmullRomCurve3 | null = null;
    let forecastLine: THREE.Line | null = null;
    if (forecastPoints.length > 1) {
      forecastCurve = new THREE.CatmullRomCurve3(forecastPoints, false, "centripetal", 0.3);
      const forecastMaterial = new THREE.LineDashedMaterial({ color: 0xc0a7ff, dashSize: 0.12, gapSize: 0.1, transparent: true, opacity: 0.88 });
      forecastLine = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(forecastCurve.getPoints(100)),
        forecastMaterial,
      );
      forecastLine.computeLineDistances();
      forecastLine.position.z = 0.2;
      world.add(forecastLine);
    }

    const trailCount = window.innerWidth < 760 ? 80 : 180;
    const trailPositions = new Float32Array(trailCount * 3);
    const trailGeometry = new THREE.BufferGeometry();
    trailGeometry.setAttribute("position", new THREE.BufferAttribute(trailPositions, 3));
    const trailMaterial = new THREE.PointsMaterial({
      color: 0x9df7ff,
      size: window.innerWidth < 760 ? 0.045 : 0.035,
      transparent: true,
      opacity: 0.8,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const trailPoints = new THREE.Points(trailGeometry, trailMaterial);
    trailPoints.position.z = 0.21;
    world.add(trailPoints);

    const stormGroup = new THREE.Group();
    world.add(stormGroup);
    const particleCount = window.innerWidth < 760 ? 2200 : 6200;
    const particleGeometry = new THREE.BufferGeometry();
    const radii = new Float32Array(particleCount);
    const angles = new Float32Array(particleCount);
    const phases = new Float32Array(particleCount);
    for (let i = 0; i < particleCount; i += 1) {
      const random = Math.random();
      radii[i] = 0.05 + Math.pow(random, 0.72) * 1.42;
      angles[i] = Math.random() * Math.PI * 2;
      phases[i] = Math.random() * Math.PI * 2;
    }
    particleGeometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(particleCount * 3), 3));
    particleGeometry.setAttribute("aRadius", new THREE.BufferAttribute(radii, 1));
    particleGeometry.setAttribute("aAngle", new THREE.BufferAttribute(angles, 1));
    particleGeometry.setAttribute("aPhase", new THREE.BufferAttribute(phases, 1));
    const particleMaterial = new THREE.ShaderMaterial({
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      uniforms: {
        uTime: { value: 0 },
        uMotion: { value: reducedMotion ? 0 : 1 },
        uColorA: { value: new THREE.Color(0x88f7ff) },
        uColorB: { value: new THREE.Color(0xa283ff) },
        uOpacity: { value: 0.9 },
      },
      vertexShader: `
        attribute float aRadius;
        attribute float aAngle;
        attribute float aPhase;
        uniform float uTime;
        uniform float uMotion;
        varying float vFade;
        varying float vMix;
        void main() {
          float t = uTime * uMotion;
          float spiral = aAngle + aRadius * 4.8 + t * (1.32 - aRadius * .28);
          float pulse = sin(aPhase + t * 2.0 + aRadius * 7.0) * .035;
          float radius = aRadius + pulse;
          vec3 transformed = vec3(cos(spiral) * radius * 1.25, sin(spiral) * radius * .88, sin(aPhase + t + aRadius * 4.0) * .11);
          vec4 mvPosition = modelViewMatrix * vec4(transformed, 1.0);
          gl_Position = projectionMatrix * mvPosition;
          gl_PointSize = (2.4 + (1.0 - min(aRadius, 1.0)) * 3.7) * (9.0 / -mvPosition.z);
          vFade = smoothstep(1.5, .08, aRadius);
          vMix = fract(aPhase / 6.28318 + aRadius);
        }
      `,
      fragmentShader: `
        uniform vec3 uColorA;
        uniform vec3 uColorB;
        uniform float uOpacity;
        varying float vFade;
        varying float vMix;
        void main() {
          vec2 uv = gl_PointCoord - .5;
          float d = length(uv);
          float alpha = smoothstep(.5, .05, d) * vFade * uOpacity;
          gl_FragColor = vec4(mix(uColorA, uColorB, vMix * .58), alpha);
        }
      `,
    });
    const vortex = new THREE.Points(particleGeometry, particleMaterial);
    stormGroup.add(vortex);

    const eye = new THREE.Mesh(
      new THREE.RingGeometry(0.08, 0.15, 64),
      new THREE.MeshBasicMaterial({ color: 0xe8feff, transparent: true, opacity: 0.88, blending: THREE.AdditiveBlending, side: THREE.DoubleSide }),
    );
    eye.position.z = 0.08;
    stormGroup.add(eye);

    const ringGroup = new THREE.Group();
    for (let index = 0; index < 3; index += 1) {
      const ring = new THREE.LineLoop(
        new THREE.BufferGeometry().setFromPoints(
          new THREE.EllipseCurve(0, 0, 0.55 + index * 0.36, 0.43 + index * 0.28, 0, Math.PI * 2).getPoints(90).map((point) => new THREE.Vector3(point.x, point.y, 0)),
        ),
        new THREE.LineBasicMaterial({ color: index === 2 ? 0xa78bfa : 0x79eaff, transparent: true, opacity: 0.18 - index * 0.035 }),
      );
      ringGroup.add(ring);
    }
    stormGroup.add(ringGroup);

    const beijingPosition = project(BEIJING.longitude, BEIJING.latitude);
    const beijingGroup = new THREE.Group();
    beijingGroup.position.copy(beijingPosition);
    beijingGroup.position.z = 0.24;
    for (let index = 0; index < 4; index += 1) {
      const halo = new THREE.LineLoop(
        new THREE.BufferGeometry().setFromPoints(
          new THREE.EllipseCurve(0, 0, 0.16 + index * 0.17, 0.16 + index * 0.17, 0, Math.PI * 2).getPoints(72).map((point) => new THREE.Vector3(point.x, point.y, 0)),
        ),
        new THREE.LineBasicMaterial({ color: 0xffb15a, transparent: true, opacity: 0.66 / (index + 1) }),
      );
      beijingGroup.add(halo);
    }
    world.add(beijingGroup);

    const moistureCount = window.innerWidth < 760 ? 360 : 1100;
    const moistureGeometry = new THREE.BufferGeometry();
    const moisturePositions = new Float32Array(moistureCount * 3);
    const moistureSeed = Array.from({ length: moistureCount }, () => ({
      progress: Math.random(),
      offset: (Math.random() - 0.5) * 0.82,
      phase: Math.random() * Math.PI * 2,
      speed: 0.025 + Math.random() * 0.045,
    }));
    moistureGeometry.setAttribute("position", new THREE.BufferAttribute(moisturePositions, 3));
    const moistureMaterial = new THREE.PointsMaterial({
      color: 0x7defff,
      size: window.innerWidth < 760 ? 0.055 : 0.042,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const moisture = new THREE.Points(moistureGeometry, moistureMaterial);
    moisture.position.z = 0.2;
    world.add(moisture);

    const starCount = window.innerWidth < 760 ? 400 : 1000;
    const starPositions = new Float32Array(starCount * 3);
    for (let i = 0; i < starCount; i += 1) {
      starPositions[i * 3] = (Math.random() - 0.5) * 26;
      starPositions[i * 3 + 1] = (Math.random() - 0.5) * 18;
      starPositions[i * 3 + 2] = -1 - Math.random() * 10;
    }
    const stars = new THREE.Points(
      new THREE.BufferGeometry().setAttribute("position", new THREE.BufferAttribute(starPositions, 3)),
      new THREE.PointsMaterial({ color: 0x79cddd, size: 0.025, transparent: true, opacity: 0.34, depthWrite: false }),
    );
    scene.add(stars);

    const pointer = new THREE.Vector2();
    const targetCamera = new THREE.Vector3();
    const targetLook = new THREE.Vector3();
    const cameraLook = new THREE.Vector3();
    const clock = new THREE.Clock();
    let frame = 0;
    let visible = !document.hidden;

    const onPointerMove = (event: PointerEvent) => {
      pointer.x = (event.clientX / window.innerWidth - 0.5) * 2;
      pointer.y = (event.clientY / window.innerHeight - 0.5) * 2;
    };
    const onVisibility = () => {
      visible = !document.hidden;
      if (visible) clock.getDelta();
    };
    const onResize = () => {
      if (!host) return;
      camera.aspect = host.clientWidth / host.clientHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(host.clientWidth, host.clientHeight);
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.55));
    };
    window.addEventListener("pointermove", onPointerMove, { passive: true });
    window.addEventListener("resize", onResize);
    document.addEventListener("visibilitychange", onVisibility);

    const animate = () => {
      frame = requestAnimationFrame(animate);
      if (!visible) return;
      const time = clock.getElapsedTime();
      const activeView = viewRef.current;
      const selectedIndex = Math.min(Math.max(replayRef.current, 0), data.observed.length - 1);
      const selected = activeView === "replay" ? data.observed[selectedIndex] : latest;
      const selectedPosition = project(selected.longitude, selected.latitude);
      stormGroup.position.lerp(selectedPosition, reducedMotion ? 1 : 0.075);
      particleMaterial.uniforms.uTime.value = time;
      particleMaterial.uniforms.uOpacity.value = activeView === "beijing" ? 0.48 : 0.9;
      eye.rotation.z = reducedMotion ? 0 : -time * 0.34;
      ringGroup.rotation.z = reducedMotion ? 0 : time * 0.08;
      const pulse = reducedMotion ? 1 : 1 + Math.sin(time * 2.2) * 0.06;
      beijingGroup.scale.setScalar(activeView === "beijing" ? pulse * 1.3 : pulse * 0.78);
      beijingGroup.children.forEach((child, index) => {
        const material = (child as THREE.Line).material as THREE.LineBasicMaterial;
        material.opacity = activeView === "beijing" ? 0.7 / (index + 1) : 0.2 / (index + 1);
      });
      if (forecastLine) {
        (forecastLine.material as THREE.LineDashedMaterial).opacity = activeView === "replay" ? 0.2 : 0.9;
      }
      trackLine.material.opacity = activeView === "beijing" ? 0.34 : 0.84;

      for (let i = 0; i < trailCount; i += 1) {
        const progress = reducedMotion ? i / trailCount : (i / trailCount + time * 0.035) % 1;
        const point = trackCurve.getPointAt(progress);
        trailPositions[i * 3] = point.x;
        trailPositions[i * 3 + 1] = point.y;
        trailPositions[i * 3 + 2] = 0.04;
      }
      trailGeometry.attributes.position.needsUpdate = true;

      const corridorStart = forecastCurve ? forecastCurve.getPointAt(0.62) : selectedPosition;
      const corridorControl = new THREE.Vector3((corridorStart.x + beijingPosition.x) / 2 - 0.55, (corridorStart.y + beijingPosition.y) / 2 + 0.55, 0.2);
      const corridor = new THREE.QuadraticBezierCurve3(corridorStart, corridorControl, beijingPosition);
      moistureMaterial.opacity += ((activeView === "beijing" ? 0.78 : 0.02) - moistureMaterial.opacity) * 0.06;
      for (let i = 0; i < moistureCount; i += 1) {
        const seed = moistureSeed[i];
        const progress = reducedMotion ? seed.progress : (seed.progress + time * seed.speed) % 1;
        const point = corridor.getPointAt(progress);
        const wobble = Math.sin(seed.phase + progress * 15 + time * 0.8) * seed.offset * (0.4 + Math.sin(progress * Math.PI) * 0.6);
        moisturePositions[i * 3] = point.x + wobble * 0.55;
        moisturePositions[i * 3 + 1] = point.y + wobble;
        moisturePositions[i * 3 + 2] = 0.08 + Math.sin(seed.phase + progress * 8) * 0.08;
      }
      moistureGeometry.attributes.position.needsUpdate = true;

      if (activeView === "beijing") {
        targetCamera.set(-3.7, 2.45, window.innerWidth < 760 ? 12.2 : 9.4);
        targetLook.set(-3.65, 2.1, 0);
      } else if (activeView === "replay") {
        targetCamera.set(-0.4, -0.1, window.innerWidth < 760 ? 17.6 : 15.8);
        targetLook.set(-0.45, -0.15, 0);
      } else {
        targetCamera.set(-0.6, -0.25, window.innerWidth < 760 ? 16.7 : 14.6);
        targetLook.set(-0.55, -0.15, 0);
      }
      if (!reducedMotion) {
        targetCamera.x += pointer.x * 0.24;
        targetCamera.y -= pointer.y * 0.16;
      }
      camera.position.lerp(targetCamera, reducedMotion ? 1 : 0.035);
      cameraLook.lerp(targetLook, reducedMotion ? 1 : 0.045);
      camera.lookAt(cameraLook);
      stars.rotation.z = reducedMotion ? 0 : time * 0.0025;
      renderer.render(scene, camera);
    };
    animate();

    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("resize", onResize);
      document.removeEventListener("visibilitychange", onVisibility);
      scene.traverse((object) => {
        const mesh = object as THREE.Mesh;
        mesh.geometry?.dispose?.();
        if (Array.isArray(mesh.material)) mesh.material.forEach((material) => material.dispose());
        else mesh.material?.dispose?.();
      });
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, [data]);

  return <div className="scene-host" ref={hostRef} aria-hidden="true" />;
}

export default function TyphoonExperience() {
  const [data, setData] = useState<TyphoonPayload>(fallbackPayload);
  const [dataMode, setDataMode] = useState<DataMode>("snapshot");
  const [view, setView] = useState<ViewMode>("live");
  const [replayIndex, setReplayIndex] = useState(fallbackPayload.observed.length - 1);
  const [playing, setPlaying] = useState(false);
  const [lastChecked, setLastChecked] = useState<string>(fallbackPayload.generatedAt);

  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | undefined;

    const load = async () => {
      if (document.hidden) return;
      controller?.abort();
      controller = new AbortController();
      const timeout = window.setTimeout(() => controller?.abort(), 24_000);
      try {
        const incoming = await fetchPreferredPayload(controller.signal);
        if (!active) return;
        setData(incoming);
        setReplayIndex(incoming.observed.length - 1);
        const age = Date.now() - new Date(incoming.updatedAt).getTime();
        setDataMode(incoming.status.mode === "live" ? (age < 6 * 60 * 60 * 1000 ? "live" : "delayed") : "snapshot");
        setLastChecked(new Date().toISOString());
        writeCachedPayload(incoming);
      } catch {
        if (!active) return;
        const cached = readCachedPayload();
        if (cached) {
          setData(cached);
          setReplayIndex(cached.observed.length - 1);
          setDataMode("delayed");
        } else {
          setDataMode("snapshot");
        }
      } finally {
        window.clearTimeout(timeout);
        if (active) timer = setTimeout(load, 5 * 60 * 1000);
      }
    };

    const refresh = () => {
      if (!document.hidden) void load();
    };
    void load();
    window.addEventListener("online", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      active = false;
      controller?.abort();
      if (timer) clearTimeout(timer);
      window.removeEventListener("online", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, []);

  useEffect(() => {
    if (!playing || view !== "replay") return;
    const timer = window.setInterval(() => {
      setReplayIndex((current) => (current >= data.observed.length - 1 ? 0 : current + 1));
    }, 720);
    return () => window.clearInterval(timer);
  }, [playing, view, data.observed.length]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "1") setView("live");
      if (event.key === "2") setView("replay");
      if (event.key === "3") setView("beijing");
      if (view === "replay" && event.key === "ArrowLeft") setReplayIndex((value) => Math.max(0, value - 1));
      if (view === "replay" && event.key === "ArrowRight") setReplayIndex((value) => Math.min(data.observed.length - 1, value + 1));
      if (view === "replay" && event.key === " ") {
        event.preventDefault();
        setPlaying((value) => !value);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [view, data.observed.length]);

  const selectedPoint = view === "replay" ? data.observed[replayIndex] ?? data.storm.current : data.storm.current;
  const copy = VIEW_COPY[view];
  const nearest = data.beijing.closestForecast;
  const highestWind = useMemo(
    () => Math.max(...data.observed.map((point) => point.maxWindMs ?? 0)),
    [data.observed],
  );

  const setActiveView = (nextView: ViewMode) => {
    setView(nextView);
    if (nextView !== "replay") setPlaying(false);
  };

  return (
    <main className={`experience view-${view}`}>
      <div className="atmosphere" />
      <TyphoonScene data={data} view={view} replayIndex={replayIndex} />

      <header className="topbar">
        <a className="brand" href="#top" aria-label="Aether Storm Observatory home">
          <span className="brand-mark"><i /><i /><i /></span>
          <span>AETHER</span>
          <small>STORM OBSERVATORY</small>
        </a>
        <nav className="view-nav" aria-label="Visualization views">
          {(["live", "replay", "beijing"] as ViewMode[]).map((item) => (
            <button
              className={view === item ? "active" : ""}
              key={item}
              onClick={() => setActiveView(item)}
              aria-pressed={view === item}
            >
              <span>{VIEW_COPY[item].index}</span>{VIEW_COPY[item].kicker}
            </button>
          ))}
        </nav>
        <div className={`feed-state state-${dataMode}`} title={`Last checked ${formatCst(lastChecked)} CST`}>
          <span className="status-dot" />
          <div><strong>{dataMode}</strong><small>CMA / NMC FEED</small></div>
        </div>
      </header>

      <section className="hero-copy" id="top">
        <div className="eyebrow"><span>{copy.index}</span>{copy.kicker}</div>
        <p className="storm-id">WPAC / 2609 <b>BAVI</b></p>
        <h1>{copy.title.split("\n").map((line) => <span key={line}>{line}</span>)}</h1>
        <p className="hero-description">{copy.description}</p>
        <div className="hero-actions">
          <button className="primary-action" onClick={() => setActiveView(view === "beijing" ? "live" : "beijing")}>
            <span>{view === "beijing" ? "Return to storm" : "Focus on Beijing"}</span><b>↗</b>
          </button>
          <a href={data.source.detailUrl} target="_blank" rel="noreferrer">Official source <span>↗</span></a>
        </div>
      </section>

      <aside className="telemetry glass-panel" aria-label="Current storm telemetry">
        <div className="panel-heading"><span>CORE TELEMETRY</span><small>{formatCst(selectedPoint.validAt)} CST</small></div>
        <div className="primary-reading">
          <strong>{selectedPoint.maxWindMs ?? "—"}</strong>
          <span>m/s<small>MAX WIND · CMA 2-MIN</small></span>
        </div>
        <div className="metric-grid">
          <div><small>PRESSURE</small><b>{selectedPoint.pressureHpa ?? "—"} <i>hPa</i></b></div>
          <div><small>CLASS</small><b>{selectedPoint.classification.code}</b></div>
          <div><small>POSITION</small><b>{selectedPoint.latitude.toFixed(1)}°N <i>/</i> {selectedPoint.longitude.toFixed(1)}°E</b></div>
          <div><small>MOTION</small><b>{selectedPoint.movement?.direction ?? "NW"} <i>{selectedPoint.movement?.speedKmh ?? 21} km/h</i></b></div>
        </div>
        <div className="intensity-bar"><span style={{ width: `${Math.min(100, ((selectedPoint.maxWindMs ?? 0) / 70) * 100)}%` }} /></div>
        <div className="scale-label"><span>TD</span><span>TS</span><span>TY</span><span>SUPER TY</span></div>
      </aside>

      <aside className={`impact-panel glass-panel ${view === "beijing" ? "visible" : ""}`} aria-label="Beijing impact assessment">
        <div className="warning-line"><span className="warning-symbol">!</span><div><small>BEIJING · ACTIVE</small><strong>ORANGE RAINSTORM WARNING</strong></div></div>
        <p className="mechanism">REMOTE MOISTURE <span>/</span> FAR-FIELD RAIN</p>
        <p className="impact-summary">The primary risk is long-range moisture transport interacting with cold air — <b>not direct eyewall passage.</b></p>
        <div className="rain-metrics">
          <div><strong>70+</strong><span>mm/h<small>LOCAL POTENTIAL</small></span></div>
          <div><strong>150+</strong><span>mm/24h<small>LOCAL POTENTIAL</small></span></div>
        </div>
        <div className="impact-route">
          <span><i />STORM CORE</span><b>{Math.round(data.beijing.currentDistanceKm).toLocaleString()} km</b><span><i />BEIJING</span>
        </div>
        <div className="forecast-clearance"><span>NEAREST 72H FORECAST</span><strong>{Math.round(nearest?.distanceKm ?? data.beijing.minDistanceKm ?? 791)} km south</strong></div>
        <div className="districts"><span>HUAIROU</span><span>MIYUN</span><span>PINGGU</span><span>SHUNYI</span><span>FANGSHAN</span></div>
        <a className="warning-link" href="https://www.beijing.gov.cn/ywdt/yaowen/202607/t20260709_4755249.html" target="_blank" rel="noreferrer">Read official Beijing warning <span>↗</span></a>
      </aside>

      <section className={`replay-controls glass-panel ${view === "replay" ? "visible" : ""}`} aria-label="Track replay controls">
        <button className="play-button" onClick={() => setPlaying((value) => !value)} aria-label={playing ? "Pause replay" : "Play replay"}>{playing ? "Ⅱ" : "▶"}</button>
        <div className="replay-track">
          <div className="replay-meta"><span>ANALYSIS {String(replayIndex + 1).padStart(2, "0")} / {String(data.observed.length).padStart(2, "0")}</span><strong>{formatCst(selectedPoint.validAt)} CST</strong></div>
          <input
            aria-label="Historical track position"
            type="range"
            min="0"
            max={Math.max(0, data.observed.length - 1)}
            value={replayIndex}
            onChange={(event) => setReplayIndex(Number(event.target.value))}
            style={{ "--replay-progress": `${(replayIndex / Math.max(1, data.observed.length - 1)) * 100}%` } as React.CSSProperties}
          />
          <div className="replay-dates"><span>GENESIS · 02 JUL</span><span>LATEST · {formatCst(data.updatedAt)}</span></div>
        </div>
        <div className="peak-stat"><small>PEAK INTENSITY</small><strong>{highestWind} m/s</strong></div>
      </section>

      <div className="forecast-rail" aria-label="CMA forecast timeline">
        <span className="rail-label">CMA FORECAST</span>
        {data.forecast.slice(0, 6).map((point) => (
          <button key={`${point.validAt}-${point.leadHours}`} onClick={() => setActiveView("live")} title={`${point.latitude.toFixed(1)}°N, ${point.longitude.toFixed(1)}°E`}>
            <i className={point.classification.code.toLowerCase()} />
            <span>+{point.leadHours}H</span>
            <strong>{point.classification.code}</strong>
          </button>
        ))}
      </div>

      <footer className="source-strip">
        <span>DATA <b>CMA / NMC</b></span>
        <span>ANALYSIS <b>{formatCst(data.updatedAt)} CST</b></span>
        <span>REFRESH <b>5 MIN</b></span>
        <span className="source-note">Forecast guidance changes. Follow official warnings for safety decisions.</span>
      </footer>

      <div className="coordinate-badge" aria-hidden="true"><span>39.9042°N</span><i /><span>116.4074°E</span></div>
      <div className="corner-index" aria-hidden="true">A-09<br /><span>2026</span></div>

      <section className="sr-only" aria-label="Accessible storm summary">
        <h2>Typhoon Bavi live data summary</h2>
        <p>Latest CMA analysis: {selectedPoint.classification.label}, maximum wind {selectedPoint.maxWindMs} metres per second, pressure {selectedPoint.pressureHpa} hectopascals, at {selectedPoint.latitude} degrees north and {selectedPoint.longitude} degrees east.</p>
        <p>Beijing is approximately {Math.round(data.beijing.currentDistanceKm)} kilometres from the current center. The severe rainfall risk is caused by far-field moisture transport, not direct eyewall passage.</p>
      </section>
    </main>
  );
}
