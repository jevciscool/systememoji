(function () {
  "use strict";

  // ---- Settings you can tweak -------------------------------------------
  const SCALE = 0.9;         // emoji glyph size vs. its box (try 0.8 - 1.0)
  const JUMBO_SIZE = 56;     // size of emoji in messages that have ONLY emoji
  const FALLBACK_SIZE = 32;  // used if an emoji image has no readable size
  const DEBUG = true;        // debug mode: toasts + copies info to clipboard
  // -----------------------------------------------------------------------

  const { findByProps } = vendetta.metro;
  const { React, ReactNative } = vendetta.metro.common;
  const { before, after } = vendetta.patcher;

  // "asset:/emoji-1f600.png", ".../drawable/emoji-1f468-200d-1f4bb.png",
  // ".../twemoji/.../1f600.png"
  const EMOJI_URI =
    /(?:emoji[-_]|twemoji[^?#]*\/)([0-9a-f]{2,6}(?:-[0-9a-f]{2,6})*)\.(?:png|webp|svg)(?:[?#].*)?$/i;

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

  function num(v) {
    return typeof v === "number" && isFinite(v) && v > 0 ? v : 0;
  }

  // Looks at every place a size could be hiding and returns the biggest one
  function sizeOf(props) {
    let best = 0;
    const consider = (v) => {
      if (v > best) best = v;
    };
    [props.fastImageStyle, props.style].forEach((st) => {
      const f = flat(st);
      if (f) {
        consider(num(f.width));
        consider(num(f.height));
      }
    });
    consider(num(props.width));
    consider(num(props.height));
    consider(num(props.size));
    consider(num(props.emojiSize));
    if (props.source && typeof props.source === "object") {
      consider(num(props.source.width));
      consider(num(props.source.height));
    }
    return best || null;
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

  // ---------------- "Emoji only" message detection ----------------
  let ONLY_EMOJI = null;
  try {
    ONLY_EMOJI = new RegExp(
      "^[\\u200d\\ufe0f\\u20e3\\u{1f000}-\\u{1faff}\\u{2190}-\\u{21ff}" +
        "\\u{2300}-\\u{23ff}\\u{2600}-\\u{27bf}\\u{2900}-\\u{297f}" +
        "\\u{2b00}-\\u{2bff}\\u{3030}\\u{303d}\\u{3297}\\u{3299}\\u{a9}" +
        "\\u{ae}\\u{203c}\\u{2049}\\u{2122}\\u{2139}]+$",
      "u"
    );
  } catch (e) {}

  let lastContent = null;
  let lastResult = false;
  let jumbo = false;
  let jumboAt = 0;

  function emojiOnly(content) {
    if (content === lastContent) return lastResult;
    let r = false;
    try {
      const stripped = content
        .replace(/<a?:\w+:\d+>/g, "")
        .replace(/[0-9#*]\ufe0f?\u20e3/g, "");
      const rest = stripped.replace(/\s/g, "");
      r =
        content.trim().length > 0 &&
        (rest.length === 0 || (ONLY_EMOJI ? ONLY_EMOJI.test(rest) : false));
    } catch (e) {}
    lastContent = content;
    lastResult = r;
    return r;
  }

  // ---------------- Debug sampling ----------------
  const samples = new Map();
  const stats = { calls: 0, withUri: 0, replaced: 0, jumbo: 0, imageRenders: 0, imageReplaced: 0 };
  const hooks = { jsx: false, jsxs: false, createElement: false, image: false, fastImage: false };
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
        /emoji|reaction/i.test(name) ||
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

  function emojiTextProps(emoji, size) {
    return {
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
  }

  // Second layer: runs AFTER an Image component has rendered. If it was an
  // emoji image, throw its output away and draw the system emoji instead.
  // (Keeps React's hook order intact, so it is safe for recycled list cells.)
  function afterImageRender(args, ret) {
    try {
      const props = args && args[0];
      if (!props || typeof props !== "object") return ret;
      const uri = uriOf(props);
      stats.imageRenders++;
      record("Image.render", props, uri);
      const emoji = decode(uri);
      if (!emoji) return ret;
      const size = sizeOf(props) || FALLBACK_SIZE;
      stats.imageReplaced++;
      return React.createElement(ReactNative.Text, emojiTextProps(emoji, size));
    } catch (e) {
      return ret;
    }
  }

  function swapEmoji(args) {
    try {
      const props = args[1];
      if (!props || typeof props !== "object") return args;

      stats.calls++;

      // Remember whether the message being drawn is emoji-only
      const msg = props.message;
      if (msg && typeof msg === "object" && typeof msg.content === "string") {
        jumbo = emojiOnly(msg.content);
        jumboAt = Date.now();
      }

      const uri = uriOf(props);
      if (uri) stats.withUri++;

      record(args[0], props, uri);

      const emoji = decode(uri);
      if (!emoji) return args;

      let size = sizeOf(props) || FALLBACK_SIZE;

      // Normal message-sized emoji (about 22) in an emoji-only message
      // -> make it big
      if (jumbo && Date.now() - jumboAt < 150 && size >= 21 && size <= 25) {
        size = JUMBO_SIZE;
        stats.jumbo++;
      }

      args[0] = ReactNative.Text;
      args[1] = emojiTextProps(emoji, size);

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

      // Layer 2: hook RN's Image (and FastImage if we can find it)
      try {
        const Img = ReactNative.Image;
        if (Img && typeof Img.render === "function") {
          unpatches.push(after("render", Img, afterImageRender));
          hooks.image = true;
        }
      } catch (e) {}
      try {
        const FI = findByProps("cacheControl", "priority", "resizeMode");
        const target =
          FI && ((FI.type && FI.type.render ? FI.type : null) || FI);
        if (target && typeof target.render === "function") {
          unpatches.push(after("render", target, afterImageRender));
          hooks.fastImage = true;
        }
      } catch (e) {}

      if (DEBUG) {
        toast(
          "System Emoji debug on. hooks: jsx=" +
            hooks.jsx +
            " jsxs=" +
            hooks.jsxs +
            " ce=" +
            hooks.createElement +
            " img=" +
            hooks.image +
            " fi=" +
            hooks.fastImage
        );
        setTimeout(flush, 20000);
      }
    },
    onUnload() {
      clearTimeout(copyTimer);
      unpatches.splice(0).forEach((unpatch) => unpatch());
    },
  };
})();
