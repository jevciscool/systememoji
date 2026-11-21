(function () {
  "use strict";

  // ---- Settings you can tweak -------------------------------------------
  const SCALE = 0.8;   // emoji size relative to the image box (try 0.7 - 0.9)
  const DEBUG = true;  // debug mode: toasts + copies info to the clipboard
  // -----------------------------------------------------------------------

  const { findByProps } = vendetta.metro;
  const { React, ReactNative } = vendetta.metro.common;
  const { before } = vendetta.patcher;

  const EMOJI_URI =
    /^(?:asset:\/emoji-|https?:\/\/[^\s]*twemoji[^\s]*\/)([0-9a-f]{2,6}(?:-[0-9a-f]{2,6})*)\.(?:png|webp|svg)(?:\?.*)?$/i;

  function decode(uri) {
    if (typeof uri !== "string") return null;
    const match = EMOJI_URI.exec(uri);
    if (!match) return null;
    try {
      return String.fromCodePoint(
        ...match[1].split("-").map((hex) => parseInt(hex, 16))
      );
    } catch (e) {
      return null;
    }
  }

  function flat(style) {
    try {
      return style ? ReactNative.StyleSheet.flatten(style) : null;
    } catch (e) {
      return null;
    }
  }

  function squareOf(style) {
    const f = flat(style);
    const w = f && f.width;
    return typeof w === "number" && isFinite(w) && w > 0 && f.height === w
      ? w
      : null;
  }

  function sizeOf(props) {
    return (
      squareOf(props.fastImageStyle) ||
      squareOf(props.style) ||
      (typeof props.width === "number" && props.width === props.height
        ? props.width
        : null)
    );
  }

  function toast(text) {
    try {
      vendetta.ui.toasts.showToast(text);
    } catch (e) {}
  }

  function uriOf(props) {
    try {
      if (typeof props.src === "string") return props.src;
      const s = props.source;
      if (s) {
        if (typeof s === "string") return s;
        if (typeof s.uri === "string") return s.uri;
        if (Array.isArray(s) && s[0] && typeof s[0].uri === "string")
          return s[0].uri;
      }
      if (typeof props.uri === "string") return props.uri;
    } catch (e) {}
    return null;
  }

  // ---------------- Debug sampling ----------------
  const samples = new Map();
  const stats = { calls: 0, withUri: 0, replaced: 0 };
  const hooks = { jsx: false, jsxs: false, createElement: false };
  let copyTimer = null;

  function nameOf(type) {
    try {
      if (typeof type === "string") return type;
      if (!type) return "?";
      return (
        type.displayName ||
        type.name ||
        (type.type && (type.type.displayName || type.type.name)) ||
        (type.render && (type.render.displayName || type.render.name)) ||
        "anon"
      );
    } catch (e) {
      return "?";
    }
  }

  function describe(props) {
    const out = {};
    let n = 0;
    for (const k of Object.keys(props)) {
      if (n++ > 14) break;
      const v = props[k];
      const t = typeof v;
      if (t === "string") out[k] = v.length > 90 ? v.slice(0, 90) + "..." : v;
      else if (t === "number" || t === "boolean") out[k] = v;
      else if (t === "function") out[k] = "fn";
      else if (v && t === "object") {
        if (Array.isArray(v)) out[k] = "[array]";
        else if (k === "style" || k === "fastImageStyle") {
          const f = flat(v);
          out[k] = f ? { w: f.width, h: f.height } : "{}";
        } else out[k] = "{" + Object.keys(v).slice(0, 5).join(",") + "}";
      }
    }
    return out;
  }

  function flush() {
    try {
      const text = JSON.stringify({
        hooks: hooks,
        stats: stats,
        samples: Array.from(samples.values()),
      }).slice(0, 8000);
      const clip = findByProps("setString");
      if (clip) clip.setString(text);
      toast("System Emoji debug: copied " + samples.size + " samples");
    } catch (e) {
      toast("System Emoji debug: could not copy");
    }
  }

  function record(type, props, uri) {
    try {
      if (!DEBUG || samples.size >= 40) return;
      const name = nameOf(type);
      const sz = uri ? sizeOf(props) : null;
      const hit =
        (uri && /emoji/i.test(uri)) ||
        /emoji/i.test(name) ||
        props.emoji != null ||
        props.surrogate != null ||
        props.emojiName != null ||
        (uri && sz && sz >= 12 && sz <= 90);
      if (!hit) return;
      const key =
        name +
        "|" +
        (uri || "").replace(/[0-9a-f]{4,}/gi, "#").replace(/\d+/g, "0");
      if (samples.has(key)) return;
      samples.set(key, { type: name, uri: uri, props: describe(props) });
      clearTimeout(copyTimer);
      copyTimer = setTimeout(flush, 5000);
    } catch (e) {}
  }

  // ---------------- The actual replacement ----------------
  let announced = false;

  function swapEmoji(args) {
    try {
      const props = args[1];
      if (!props || typeof props !== "object") return args;

      stats.calls++;
      const uri = uriOf(props);
      if (uri) stats.withUri++;

      record(args[0], props, uri);

      const emoji = decode(uri);
      if (!emoji) return args;

      const size = sizeOf(props);
      if (!size) return args;

      args[0] = ReactNative.Text;
      args[1] = {
        allowFontScaling: false,
        children: emoji,
        style: {
          width: size,
          height: size,
          fontSize: size * SCALE,
          lineHeight: size,
          textAlign: "center",
          includeFontPadding: false,
        },
      };

      stats.replaced++;
      if (DEBUG && !announced) {
        announced = true;
        toast("System Emoji: replaced an emoji " + emoji);
      }
    } catch (e) {}
    return args;
  }

  const unpatches = [];

  function tryPatch(name, parent) {
    try {
      if (parent && typeof parent[name] === "function") {
        unpatches.push(before(name, parent, swapEmoji));
        hooks[name] = true;
        return true;
      }
    } catch (e) {}
    return false;
  }

  return {
    onLoad() {
      const runtime = findByProps("jsx", "jsxs");
      tryPatch("jsx", runtime);
      tryPatch("jsxs", runtime);
      tryPatch("createElement", React);
      if (DEBUG) {
        toast(
          "System Emoji debug on. hooks: jsx=" +
            hooks.jsx +
            " jsxs=" +
            hooks.jsxs +
            " ce=" +
            hooks.createElement
        );
        // also copy once after 20s, even if nothing matched
        setTimeout(flush, 20000);
      }
    },
    onUnload() {
      clearTimeout(copyTimer);
      unpatches.splice(0).forEach((unpatch) => unpatch());
    },
  };
})();
