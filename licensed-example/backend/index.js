// src/bootstrap.ts
import { readFileSync } from "node:fs";

// ../../catalyst/packages/plugin-sdk/dist/licensing.js
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
var CACHE_KEY = "licensing.activation";
var DEK_WRAP_INFO = "catalyst-catpkg-dek-wrap-v1";
var GCM_NONCE_BYTES = 12;
var GCM_TAG_BYTES = 16;
var KEK_BYTES = 32;
var DEFAULT_TIMEOUT_MS = 1e4;
var B64_STD = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
var B64_URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
function encodeBase64(bytes, alphabet = B64_STD) {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : void 0;
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : void 0;
    out += alphabet[b0 >> 2];
    out += alphabet[(b0 & 3) << 4 | (b1 ?? 0) >> 4];
    out += b1 === void 0 ? "=" : alphabet[(b1 & 15) << 2 | (b2 ?? 0) >> 6];
    out += b2 === void 0 ? "=" : alphabet[b2 & 63];
  }
  return out;
}
function decodeBase64(text) {
  const clean = text.replace(/[^A-Za-z0-9+/\-_]/g, "");
  const out = new Uint8Array(Math.floor(clean.length * 3 / 4));
  let o = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const n = (idx) => {
      const c = clean[idx];
      if (c === void 0)
        return 0;
      const v = B64_STD.indexOf(c) !== -1 ? B64_STD.indexOf(c) : B64_URL.indexOf(c);
      return v === -1 ? 0 : v;
    };
    const c0 = n(i);
    const c1 = n(i + 1);
    const c2 = n(i + 2);
    const c3 = n(i + 3);
    out[o++] = c0 << 2 | c1 >> 4;
    if (i + 2 < clean.length)
      out[o++] = (c1 & 15) << 4 | c2 >> 2;
    if (i + 3 < clean.length)
      out[o++] = (c2 & 3) << 6 | c3;
  }
  return out.subarray(0, o);
}
function utf8(text) {
  return new TextEncoder().encode(text);
}
function fromBase64Url(text) {
  return decodeBase64(text);
}
function deriveKek(licenseKey, installId) {
  return new Uint8Array(hkdfSync("sha256", utf8(licenseKey), utf8(installId), utf8(DEK_WRAP_INFO), KEK_BYTES));
}
function licensingAad(pluginName, pluginVersion) {
  return utf8(`${pluginName}\0${pluginVersion}`);
}
function open(key, envelope, aad) {
  if (envelope.length < GCM_NONCE_BYTES + GCM_TAG_BYTES) {
    throw new Error("licensing: envelope is too short");
  }
  const nonce = envelope.subarray(0, GCM_NONCE_BYTES);
  const tag = envelope.subarray(envelope.length - GCM_TAG_BYTES);
  const body = envelope.subarray(GCM_NONCE_BYTES, envelope.length - GCM_TAG_BYTES);
  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAAD(aad);
  decipher.setAuthTag(tag);
  return new Uint8Array(Buffer.concat([decipher.update(body), decipher.final()]));
}
function unwrapDek(kek, wrappedDek, aad) {
  return open(kek, fromBase64Url(wrappedDek), aad);
}
function decryptPayload(dek, payload, aad) {
  return new TextDecoder().decode(open(dek, payload, aad));
}
async function importPayload(code) {
  const url = `data:text/javascript;base64,${encodeBase64(utf8(code))}`;
  return await import(
    /* @vite-ignore */
    url
  );
}
function cacheValid(rec, installId, now) {
  if (!rec || typeof rec !== "object")
    return false;
  const c = rec;
  return typeof c.installId === "string" && c.installId === installId && typeof c.wrappedDek === "string" && typeof c.expiresAt === "string" && new Date(c.expiresAt).getTime() > now.getTime();
}
async function activateLicense(ctx, opts = {}) {
  const lic = ctx.manifest.licensing;
  const keyField = opts.keyField ?? "licenseKey";
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const now = (opts.now ?? (() => /* @__PURE__ */ new Date()))();
  const encrypted = lic?.encrypted === true;
  const failOpen = !encrypted && lic?.failMode === "open";
  const aad = licensingAad(ctx.manifest.name, ctx.manifest.version);
  const bail = (message) => {
    ctx.logger?.error({ plugin: ctx.manifest.name, reason: message }, "licensing: activation failed");
    if (failOpen) {
      return { enabled: false, dek: null, entitlements: [], expiresAt: null, cached: false, error: message };
    }
    throw new Error(`licensing: ${message}`);
  };
  const cached = await ctx.getStorage(CACHE_KEY);
  if (cacheValid(cached, ctx.installId, now)) {
    try {
      const dek2 = unwrapDek(deriveKek(String(ctx.getConfig(keyField) ?? ""), ctx.installId), cached.wrappedDek, aad);
      return {
        enabled: true,
        dek: dek2,
        entitlements: Array.isArray(cached.entitlements) ? cached.entitlements : [],
        expiresAt: cached.expiresAt,
        cached: true
      };
    } catch {
      await ctx.setStorage(CACHE_KEY, null).catch(() => {
      });
    }
  }
  const licenseKey = String(ctx.getConfig(keyField) ?? "").trim();
  if (!licenseKey)
    return bail(`no license key configured (config.${keyField})`);
  const url = opts.licenseServer ?? lic?.licenseServer;
  if (!url)
    return bail("plugin.json declares no licensing.licenseServer");
  let body;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": `catalyst-plugin/${ctx.manifest.name}` },
      body: JSON.stringify({
        licenseKey,
        installId: ctx.installId,
        pluginName: ctx.manifest.name,
        pluginVersion: ctx.manifest.version
      }),
      signal: AbortSignal.timeout(timeoutMs)
    });
    body = await res.json().catch(() => ({}));
    if (!res.ok || body.ok !== true) {
      return bail(`activation rejected (${res.status} ${String(body.code ?? "UNKNOWN")})`);
    }
  } catch (err) {
    return bail(`license server unreachable (${err.message})`);
  }
  const wrappedDek = String(body.wrappedDek ?? "");
  const expiresAt = typeof body.expiresAt === "string" ? body.expiresAt : null;
  if (!wrappedDek || !expiresAt)
    return bail("license server returned no wrappedDek/expiresAt");
  let dek;
  try {
    dek = unwrapDek(deriveKek(licenseKey, ctx.installId), wrappedDek, aad);
  } catch {
    return bail("content key did not unwrap \u2014 wrong license key or tampered response");
  }
  const entitlements = Array.isArray(body.entitlements) ? body.entitlements.filter((e) => typeof e === "string") : [];
  await ctx.setStorage(CACHE_KEY, {
    installId: ctx.installId,
    wrappedDek,
    expiresAt,
    entitlements,
    activatedAt: now.toISOString()
  });
  ctx.logger?.info({ plugin: ctx.manifest.name, expiresAt, entitlements }, "licensing: activated");
  return { enabled: true, dek, entitlements, expiresAt, cached: false };
}
async function loadLicensedModule(ctx, opts) {
  const act = await activateLicense(ctx, opts);
  if (!act.enabled || !act.dek) {
    ctx.logger?.warn({ plugin: ctx.manifest.name }, "licensing: running without an entitlement");
    return null;
  }
  const code = decryptPayload(act.dek, opts.payload, licensingAad(ctx.manifest.name, ctx.manifest.version));
  const mod = await importPayload(code);
  return mod.default ?? mod;
}

// src/bootstrap.ts
var real;
async function boot(ctx) {
  if (real) return real;
  const payload = new Uint8Array(readFileSync(new URL("./payload.enc", import.meta.url)));
  real = await loadLicensedModule(ctx, { payload, keyField: "licenseKey" });
  return real;
}
var bootstrap_default = {
  async onLoad(ctx) {
    (await boot(ctx))?.onLoad?.(ctx);
  },
  async onEnable(ctx) {
    (await boot(ctx))?.onEnable?.(ctx);
  },
  async onDisable(ctx) {
    real?.onDisable?.(ctx);
  },
  async onUnload(ctx) {
    real?.onUnload?.(ctx);
  }
};
export {
  bootstrap_default as default
};
