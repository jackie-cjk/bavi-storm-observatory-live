/** Cloudflare Worker entry point for the vinext-starter template. */
import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";
import { baviSnapshot20260710 } from "./bavi-snapshot";

const BAVI_API_PATH = "/api/typhoon/bavi";
const NMC_LIST_URL =
  "https://typhoon.nmc.cn/weatherservice/typhoon/jsons/list_default?callback=typhoon_jsons_list_default";
const NMC_DETAIL_BASE_URL =
  "https://typhoon.nmc.cn/weatherservice/typhoon/jsons";
const CACHE_TTL_MS = 5 * 60 * 1000;
const UPSTREAM_TIMEOUT_MS = 8_000;
const MAX_UPSTREAM_BYTES = 4 * 1024 * 1024;
const BEIJING = {
  name: "Beijing",
  latitude: 39.9042,
  longitude: 116.4074,
} as const;

const CLASSIFICATION_LABELS: Record<string, string> = {
  TD: "Tropical Depression",
  TS: "Tropical Storm",
  STS: "Severe Tropical Storm",
  TY: "Typhoon",
  STY: "Severe Typhoon",
  SuperTY: "Super Typhoon",
  ET: "Extratropical Cyclone",
  LOW: "Low-pressure Area",
};

interface WindRadii {
  thresholdKts: number;
  northeast: number | null;
  southeast: number | null;
  southwest: number | null;
  northwest: number | null;
}

interface ObservationBase {
  id: number;
  validAt: string;
  classificationCode: string;
  longitude: number;
  latitude: number;
  pressureHpa: number | null;
  maxWindMs: number | null;
  movementDirection: string | null;
  movementSpeedKmh: number | null;
  windRadiiKm: WindRadii[];
}

interface ForecastBase {
  baseAt: string;
  validAt: string;
  leadHours: number;
  longitude: number;
  latitude: number;
  pressureHpa: number | null;
  maxWindMs: number | null;
  agency: "BABJ";
  classificationCode: string;
}

interface StormBase {
  internalId: number;
  id: string;
  name: string;
  localName: string;
  statusCode: string;
}

interface NormalizedSourceData {
  storm: StormBase;
  observed: ObservationBase[];
  forecast: ForecastBase[];
  detailUrl: string;
  retrievedAt: string;
}

interface CachedApiResponse {
  body: string;
  mode: "live" | "fallback";
  expiresAt: number;
}

let cachedApiResponse: CachedApiResponse | null = null;

interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  IMAGES: {
    input(stream: ReadableStream): {
      transform(options: Record<string, unknown>): {
        output(options: { format: string; quality: number }): Promise<{ response(): Response }>;
      };
    };
  };
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

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
  const match = value.trim().match(
    /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})$/,
  );
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
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }

    if (character === '"') {
      inString = true;
    } else if (character === "(") {
      depth += 1;
    } else if (character === ")") {
      depth -= 1;
      if (depth < 0) return false;
      if (depth === 0 && index !== value.length - 1) return false;
    }
  }

  return depth === 0 && !inString;
}

/**
 * Parse NMC's JSON or JSONP without evaluating executable JavaScript. The
 * list endpoint currently returns a double wrapper: callback(({...})).
 */
function parseNmcPayload(text: string): unknown {
  if (text.length === 0 || text.length > MAX_UPSTREAM_BYTES) {
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

  const openingParenthesis = payload.indexOf("(");
  payload = payload.slice(openingParenthesis + 1, end - 1).trim();
  while (isWholeOuterParentheses(payload)) {
    payload = payload.slice(1, -1).trim();
  }

  if (!payload.startsWith("{") && !payload.startsWith("[")) {
    throw new Error("NMC JSONP payload is not JSON");
  }
  return JSON.parse(payload) as unknown;
}

async function fetchNmcText(url: string): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      cache: "no-store",
      headers: { Accept: "application/json, text/javascript, */*;q=0.8" },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`NMC request failed with ${response.status}`);
    }

    const declaredLength = finiteNumber(response.headers.get("content-length"));
    if (declaredLength !== null && declaredLength > MAX_UPSTREAM_BYTES) {
      throw new Error("NMC response exceeds the size limit");
    }

    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > MAX_UPSTREAM_BYTES) {
      throw new Error("NMC response exceeds the size limit");
    }
    return text;
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeWindRadii(value: unknown): WindRadii[] {
  if (!Array.isArray(value)) return [];

  return value.flatMap((raw): WindRadii[] => {
    if (!Array.isArray(raw)) return [];
    const thresholdMatch = String(raw[0] ?? "").match(/\d+/);
    const thresholdKts = thresholdMatch
      ? finiteNumber(thresholdMatch[0])
      : null;
    if (thresholdKts === null) return [];

    return [
      {
        thresholdKts,
        northeast: finiteNumber(raw[1]),
        southeast: finiteNumber(raw[2]),
        southwest: finiteNumber(raw[3]),
        northwest: finiteNumber(raw[4]),
      },
    ];
  });
}

function normalizeObservation(value: unknown): ObservationBase | null {
  if (!Array.isArray(value)) return null;

  const id = finiteNumber(value[0]);
  const longitude = finiteNumber(value[4]);
  const latitude = finiteNumber(value[5]);
  const validAt = epochToIso(value[2]) ?? compactUtcToIso(value[1]);
  if (
    id === null ||
    longitude === null ||
    latitude === null ||
    validAt === null ||
    longitude < -180 ||
    longitude > 180 ||
    latitude < -90 ||
    latitude > 90
  ) {
    return null;
  }

  return {
    id,
    validAt,
    classificationCode: nullableString(value[3]) ?? "UNKNOWN",
    longitude,
    latitude,
    pressureHpa: finiteNumber(value[6]),
    maxWindMs: finiteNumber(value[7]),
    movementDirection: nullableString(value[8]),
    movementSpeedKmh: finiteNumber(value[9]),
    windRadiiKm: normalizeWindRadii(value[10]),
  };
}

function normalizeForecast(value: unknown): ForecastBase | null {
  if (!Array.isArray(value)) return null;

  const leadHours = finiteNumber(value[0]);
  const baseAt = compactUtcToIso(value[1]);
  const longitude = finiteNumber(value[2]);
  const latitude = finiteNumber(value[3]);
  const agency = nullableString(value[6])?.toUpperCase();
  if (
    leadHours === null ||
    baseAt === null ||
    longitude === null ||
    latitude === null ||
    agency !== "BABJ" ||
    longitude < -180 ||
    longitude > 180 ||
    latitude < -90 ||
    latitude > 90
  ) {
    return null;
  }

  return {
    baseAt,
    validAt: new Date(Date.parse(baseAt) + leadHours * 3_600_000).toISOString(),
    leadHours,
    longitude,
    latitude,
    pressureHpa: finiteNumber(value[4]),
    maxWindMs: finiteNumber(value[5]),
    agency: "BABJ",
    classificationCode: nullableString(value[7]) ?? "UNKNOWN",
  };
}

function detailUrlFor(internalId: number): string {
  const callback = `typhoon_jsons_view_${internalId}`;
  return `${NMC_DETAIL_BASE_URL}/view_${internalId}?callback=${callback}`;
}

async function fetchLiveBavi(): Promise<NormalizedSourceData> {
  const listPayload = parseNmcPayload(await fetchNmcText(NMC_LIST_URL));
  if (!isRecord(listPayload) || !Array.isArray(listPayload.typhoonList)) {
    throw new Error("NMC typhoon list has an unexpected shape");
  }

  const matches = listPayload.typhoonList.filter(
    (entry) =>
      Array.isArray(entry) &&
      nullableString(entry[1])?.toUpperCase() === "BAVI",
  );
  const listEntry =
    matches.find(
      (entry) =>
        Array.isArray(entry) &&
        nullableString(entry[7])?.toLowerCase() === "start",
    ) ?? matches[0];
  if (!Array.isArray(listEntry)) {
    throw new Error("Bavi is not present in the NMC default list");
  }

  const internalId = finiteNumber(listEntry[0]);
  if (internalId === null) throw new Error("Bavi has no NMC internal id");

  const detailUrl = detailUrlFor(internalId);
  const detailPayload = parseNmcPayload(await fetchNmcText(detailUrl));
  if (!isRecord(detailPayload) || !Array.isArray(detailPayload.typhoon)) {
    throw new Error("NMC Bavi detail has an unexpected shape");
  }

  const typhoon = detailPayload.typhoon;
  const rawPoints = typhoon[8];
  if (!Array.isArray(rawPoints)) {
    throw new Error("NMC Bavi detail contains no track");
  }

  const observed = rawPoints
    .map(normalizeObservation)
    .filter((point): point is ObservationBase => point !== null)
    .sort((left, right) => left.validAt.localeCompare(right.validAt));
  if (observed.length === 0) throw new Error("NMC Bavi track is empty");

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
    .filter((point): point is ForecastBase => point !== null)
    .sort((left, right) => left.leadHours - right.leadHours);
  if (forecast.length === 0) {
    throw new Error("NMC Bavi detail contains no BABJ forecast");
  }

  return {
    storm: {
      internalId,
      id: String(typhoon[3] ?? listEntry[3] ?? "2609"),
      name: nullableString(typhoon[1]) ?? "BAVI",
      localName: nullableString(typhoon[2]) ?? "巴威",
      statusCode:
        nullableString(typhoon[7]) ??
        nullableString(listEntry[7]) ??
        "unknown",
    },
    observed,
    forecast,
    detailUrl,
    retrievedAt: new Date().toISOString(),
  };
}

function bundledBavi(): NormalizedSourceData {
  return {
    storm: { ...baviSnapshot20260710.storm },
    observed: baviSnapshot20260710.observed.map((point) => ({
      ...point,
      windRadiiKm: point.windRadiiKm.map((radius) => ({ ...radius })),
    })),
    forecast: baviSnapshot20260710.forecast.map((point) => ({
      ...point,
      agency: "BABJ",
    })),
    detailUrl: detailUrlFor(baviSnapshot20260710.storm.internalId),
    retrievedAt: baviSnapshot20260710.capturedAt,
  };
}

function classification(code: string): { code: string; label: string } {
  return {
    code,
    label: CLASSIFICATION_LABELS[code] ?? "Unclassified Tropical System",
  };
}

function distanceKm(
  latitudeA: number,
  longitudeA: number,
  latitudeB: number,
  longitudeB: number,
): number {
  const radians = Math.PI / 180;
  const deltaLatitude = (latitudeB - latitudeA) * radians;
  const deltaLongitude = (longitudeB - longitudeA) * radians;
  const a =
    Math.sin(deltaLatitude / 2) ** 2 +
    Math.cos(latitudeA * radians) *
      Math.cos(latitudeB * radians) *
      Math.sin(deltaLongitude / 2) ** 2;
  return 6_371.0088 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function roundedDistanceToBeijing(latitude: number, longitude: number): number {
  return Math.round(
    distanceKm(latitude, longitude, BEIJING.latitude, BEIJING.longitude),
  );
}

function titleCaseName(name: string): string {
  return name
    .toLowerCase()
    .split(/([\s-]+)/)
    .map((part) =>
      /^[a-z]/.test(part) ? part[0].toUpperCase() + part.slice(1) : part,
    )
    .join("");
}

function buildApiPayload(
  data: NormalizedSourceData,
  mode: "live" | "fallback",
) {
  const observed = data.observed.map((point) => {
    const { classificationCode, ...rest } = point;
    return {
      ...rest,
      classification: classification(classificationCode),
      distanceToBeijingKm: roundedDistanceToBeijing(
        point.latitude,
        point.longitude,
      ),
    };
  });

  const forecast = data.forecast.map((point) => {
    const { classificationCode, ...rest } = point;
    return {
      ...rest,
      classification: classification(classificationCode),
      distanceToBeijingKm: roundedDistanceToBeijing(
        point.latitude,
        point.longitude,
      ),
    };
  });

  const current = observed[observed.length - 1];
  if (!current) throw new Error("Bavi data contains no current position");

  const closest = forecast.reduce<(typeof forecast)[number] | null>(
    (best, point) =>
      best === null ||
      point.distanceToBeijingKm < best.distanceToBeijingKm
        ? point
        : best,
    null,
  );
  const active = data.storm.statusCode.toLowerCase() === "start";

  return {
    schemaVersion: "1.0",
    status: {
      mode,
      active,
      message:
        mode === "live"
          ? "Live CMA/NMC observation and BABJ forecast."
          : "Live CMA/NMC data is temporarily unavailable; serving the bundled 10 July 2026 snapshot.",
    },
    updatedAt: current.validAt,
    generatedAt: new Date().toISOString(),
    source: {
      provider:
        "China Meteorological Administration — National Meteorological Center",
      agency: "CMA / NMC",
      product: "Official typhoon track and BABJ forecast",
      listUrl: NMC_LIST_URL,
      detailUrl: data.detailUrl,
      retrievedAt: data.retrievedAt,
      isFallback: mode === "fallback",
    },
    storm: {
      id: data.storm.id,
      internalId: data.storm.internalId,
      name: titleCaseName(data.storm.name),
      localName: data.storm.localName,
      basin: "Western North Pacific",
      current,
    },
    observed,
    forecast,
    beijing: {
      ...BEIJING,
      currentDistanceKm: current.distanceToBeijingKm,
      closestForecast: closest
        ? {
            validAt: closest.validAt,
            leadHours: closest.leadHours,
            distanceKm: closest.distanceToBeijingKm,
            latitude: closest.latitude,
            longitude: closest.longitude,
          }
        : null,
      minDistanceKm: closest?.distanceToBeijingKm ?? null,
    },
  };
}

async function getBaviApiResponse(): Promise<CachedApiResponse> {
  const now = Date.now();
  if (cachedApiResponse && cachedApiResponse.expiresAt > now) {
    return cachedApiResponse;
  }

  let mode: "live" | "fallback" = "live";
  let sourceData: NormalizedSourceData;
  try {
    sourceData = await fetchLiveBavi();
  } catch (error) {
    mode = "fallback";
    sourceData = bundledBavi();
    console.warn("Using bundled Bavi snapshot after NMC fetch failure", error);
  }

  cachedApiResponse = {
    body: JSON.stringify(buildApiPayload(sourceData, mode)),
    mode,
    expiresAt: now + CACHE_TTL_MS,
  };
  return cachedApiResponse;
}

async function handleBaviApi(request: Request): Promise<Response> {
  const cached = await getBaviApiResponse();
  const headers = new Headers({
    "Cache-Control":
      "public, max-age=300, s-maxage=300, stale-while-revalidate=900",
    "CDN-Cache-Control":
      "public, max-age=300, stale-while-revalidate=900",
    "Content-Type": "application/json; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
    "X-Typhoon-Data-Mode": cached.mode,
  });
  return new Response(request.method === "HEAD" ? null : cached.body, {
    status: 200,
    headers,
  });
}

// Image security config. SVG sources with .svg extension auto-skip the
// optimization endpoint on the client side (served directly, no proxy).
// To route SVGs through the optimizer (with security headers), set
// dangerouslyAllowSVG: true in next.config.js and uncomment below:
// const imageConfig: ImageConfig = { dangerouslyAllowSVG: true };

const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (
      url.pathname === BAVI_API_PATH &&
      (request.method === "GET" || request.method === "HEAD")
    ) {
      return handleBaviApi(request);
    }

    if (url.pathname === "/_vinext/image") {
      const allowedWidths = [...DEFAULT_DEVICE_SIZES, ...DEFAULT_IMAGE_SIZES];
      return handleImageOptimization(request, {
        fetchAsset: (path) => env.ASSETS.fetch(new Request(new URL(path, request.url))),
        transformImage: async (body, { width, format, quality }) => {
          const result = await env.IMAGES.input(body).transform(width > 0 ? { width } : {}).output({ format, quality });
          return result.response();
        },
      }, allowedWidths);
    }

    return handler.fetch(request, env, ctx);
  },
};

export default worker;
