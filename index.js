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
    /(?:emoji[-_]|twemoji[^?#]*\/)([0-9a-f]{2,6}(?:[-_][0-9a-f]{2,6})*)\.(?:png|webp|svg)(?:[?#].*)?$/i;

  function decode(uri) {
    if (typeof uri !== "string") return null;
    const match = EMOJI_URI.exec(uri);
    if (!match) return null;
    try {
      return String.fromCodePoint(
        ...match[1].split(/[-_]/).map((hex) => parseInt(hex, 16))
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

  // Local images are often referenced by a number (an asset ID). Turn that
  // into a name like "asset:/emoji_1f44d.png" so we can recognise emoji.
  function assetName(id) {
    try {
      const assets =
        (vendetta.ui && vendetta.ui.assets) || vendetta.assets || null;
      const a = assets && assets.getAssetByID ? assets.getAssetByID(id) : null;
      if (a && typeof a.name === "string")
        return "asset:/" + a.name + "." + (a.type || "png");
    } catch (e) {}
    return null;
  }

  function uriOf(props) {
    try {
      if (typeof props.src === "string") return props.src;
      let s = props.source;
      if (Array.isArray(s)) s = s[0];
      if (s) {
        if (typeof s === "string") return s;
        if (typeof s === "number") return assetName(s);
        if (typeof s.uri === "string") return s.uri;
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
  const stats = { calls: 0, withUri: 0, replaced: 0, jumbo: 0, imageRenders: 0, imageReplaced: 0, rnImage: 0, rnImageReplaced: 0, rows: 0 };
  const hooks = { jsx: false, jsxs: false, createElement: false, image: false, fastImage: false, rnImage: false, rows: false };
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

  // ---------------- Messages: edit the chat data (Nexpid's method) --------
  // Based on "Use System Emoji" by Nexpid
  // (https://github.com/nexpid/RevengePlugins). Discord draws messages with a
  // native chat list that is fed JSON "rows". We turn emoji nodes into plain
  // text before the native list sees them, so Android draws them with the
  // system emoji font. Emoji-only messages are wrapped in a big heading.
  function iterateRows(rows) {
    const content = [];
    let header;
    for (const original of rows) {
      if (!original || typeof original !== "object") {
        content.push(original);
        continue;
      }
      let row = original;
      if (row.type === "emoji" && typeof row.surrogate === "string")
        row = { type: "text", content: row.surrogate };
      if ("content" in row && Array.isArray(row.content))
        row.content = iterateRows(row.content);
      if ("items" in row && Array.isArray(row.items))
        row.items = iterateRows(row.items);

      if ("jumboable" in original && original.jumboable && !header) {
        header = { type: "heading", level: 1, content: [] };
      }
      if (
        (original.type === "emoji" || original.type === "customEmoji") &&
        !original.jumboable &&
        header
      ) {
        content.push(header);
        header = undefined;
      }

      if (header) header.content.push(row);
      else content.push(row);
    }
    if (header) content.push(header);
    return content;
  }

  function processRowsArgs(args) {
    try {
      for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (typeof a !== "string" || a.charAt(0) !== "[") continue;
        const rows = JSON.parse(a);
        if (!Array.isArray(rows)) break;
        let changed = false;
        for (const row of rows) {
          if (!row || row.type !== 1 || !row.message) continue;
          if (DEBUG && !samples.has("row-reactions") && row.message.reactions) {
            samples.set("row-reactions", {
              type: "row.message",
              uri: null,
              props: {
                rowKeys: Object.keys(row).slice(0, 25).join(","),
                msgKeys: Object.keys(row.message).slice(0, 45).join(","),
                reactions: JSON.stringify(row.message.reactions).slice(0, 700),
              },
            });
            clearTimeout(copyTimer);
            copyTimer = setTimeout(flush, 5000);
          }
          if (Array.isArray(row.message.content)) {
            row.message.content = iterateRows(row.message.content);
            changed = true;
          }
        }
        if (changed) {
          args[i] = JSON.stringify(rows);
          stats.rows++;
        }
        break;
      }
    } catch (e) {}
    return args;
  }

  function hookRows() {
    let ok = false;
    const targets = [];
    try {
      const NM = ReactNative.NativeModules;
      ["DCDChatManager", "NativeChatModule"].forEach((n) => {
        if (NM && NM[n]) targets.push(NM[n]);
      });
    } catch (e) {}
    try {
      const found = findByProps("updateRows");
      if (found && targets.indexOf(found) === -1) targets.push(found);
    } catch (e) {}
    targets.forEach((t) => {
      try {
        if (typeof t.updateRows === "function") {
          unpatches.push(before("updateRows", t, processRowsArgs));
          ok = true;
        }
      } catch (e) {}
    });
    return ok;
  }

  // Third layer: replace React Native's Image with a wrapper. Any screen that
  // looks up "Image" while drawing (reactions, picker...) gets the wrapper,
  // which draws emoji as text and passes every other image through untouched.
  function wrapRNImage() {
    const RN = ReactNative;
    const Orig = RN.Image;
    if (!Orig) return false;
    const desc = Object.getOwnPropertyDescriptor(RN, "Image");

    const Wrapped = React.forwardRef(function SystemEmojiImage(props, ref) {
      try {
        stats.rnImage++;
        const uri = uriOf(props);
        record("RN.Image", props, uri);
        const emoji = decode(uri);
        if (emoji) {
          stats.rnImageReplaced++;
          return React.createElement(
            RN.Text,
            emojiTextProps(emoji, sizeOf(props) || FALLBACK_SIZE)
          );
        }
      } catch (e) {}
      return React.createElement(Orig, Object.assign({}, props, { ref: ref }));
    });

    // keep things like Image.getSize / resolveAssetSource working
    try {
      Object.getOwnPropertyNames(Orig).forEach((k) => {
        if (k in Wrapped || k === "prototype" || k === "length" || k === "name")
          return;
        try {
          Wrapped[k] = Orig[k];
        } catch (e) {}
      });
    } catch (e) {}

    Object.defineProperty(RN, "Image", {
      configurable: true,
      enumerable: true,
      get: function () {
        return Wrapped;
      },
    });

    unpatches.push(function () {
      try {
        Object.defineProperty(
          RN,
          "Image",
          desc || { value: Orig, configurable: true, writable: true }
        );
      } catch (e) {}
    });
    return true;
  }

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
      try {
        hooks.rows = hookRows();
      } catch (e) {}
      const runtime = findByProps("jsx", "jsxs");
      tryPatch("jsx", runtime);
      tryPatch("jsxs", runtime);
      tryPatch("createElement", React);

      try {
        hooks.rnImage = wrapRNImage();
      } catch (e) {}

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
            hooks.fastImage +
            " rn=" +
            hooks.rnImage +
            " rows=" +
            hooks.rows
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
