(function () {
  "use strict";

  // ---- Settings you can tweak -------------------------------------------
  const SCALE = 0.7;          // emoji size inside image boxes (0.7 - 0.9)
  const DEBUG = true;         // popup messages (set false when everything works)
  const LOG_MISSES = true;    // write debug info to Revenge's debug logs
  const FIX_MESSAGES = true;  // layer 1: messages + replies (chat data)
  const FIX_IMAGES = true;    // layer 2: picker, menus, other images
  // -----------------------------------------------------------------------

  const { findByProps } = vendetta.metro;
  const { React, ReactNative } = vendetta.metro.common;
  const { before, instead } = vendetta.patcher;

  const unpatches = [];
  const logged = new Set();

  function log(...a) {
    if (!LOG_MISSES) return;
    try {
      console.log("[System Emoji]", ...a);
    } catch (e) {}
  }
  function logOnce(key, ...a) {
    if (logged.has(key) || logged.size > 40) return;
    logged.add(key);
    log(...a);
  }
  function toast(text) {
    if (!DEBUG) return;
    try {
      vendetta.ui.toasts.showToast(text);
    } catch (e) {}
  }

  // ---- Shared helper: turn an emoji picture address into the real emoji --
  // Handles: asset:/emoji-1f600.png | emoji_1f600 | .../twemoji/.../1f600.svg
  function decode(uri) {
    if (typeof uri !== "string" || !/emoji/i.test(uri)) return null;
    if (/\/emojis\//i.test(uri)) return null; // custom server emoji: leave alone
    const file = uri
      .split("?")[0]
      .split("#")[0]
      .split("/")
      .pop()
      .replace(/\.(png|webp|svg|jpe?g)$/i, "");
    const m = /^(?:twemoji[-_]|emoji[-_])?([0-9a-f]{2,6}(?:[-_][0-9a-f]{2,6})*)$/i.exec(
      file
    );
    if (!m) return null;
    try {
      return String.fromCodePoint(
        ...m[1].split(/[-_]/).map((h) => parseInt(h, 16))
      );
    } catch (e) {
      return null;
    }
  }

  // ======================================================================
  // LAYER 1: messages and replies.
  // Discord draws the chat list natively, so React patches can't reach it.
  // Instead we edit the message data right before it is handed to the
  // native chat, turning emoji nodes into plain text nodes.
  // ======================================================================
  function emojiChar(node) {
    if (typeof node.surrogate === "string" && node.surrogate) return node.surrogate;
    const fromUrl = decode(node.src) || decode(node.frozenSrc) || decode(node.url);
    if (fromUrl) return fromUrl;
    // Last resort: alt text, but only if it looks like an emoji and not a
    // name such as ":joy:" or a translated name.
    const alt = node.alt;
    if (
      typeof alt === "string" &&
      alt.length > 0 &&
      alt.length <= 16 &&
      alt.indexOf(":") === -1 &&
      /[^\x00-\x7f]/.test(alt)
    )
      return alt;
    return null;
  }

  function isUnicodeEmojiNode(node) {
    return (
      node &&
      typeof node === "object" &&
      node.type === "emoji" && // custom server emoji use a different type
      !node.id
    );
  }

  function fixRows(node, depth) {
    if (!node || typeof node !== "object" || depth > 20) return 0;
    let count = 0;
    const keys = Array.isArray(node) ? node.map((_, i) => i) : Object.keys(node);
    for (const k of keys) {
      const child = node[k];
      if (!child || typeof child !== "object") continue;
      if (isUnicodeEmojiNode(child)) {
        const ch = emojiChar(child);
        if (ch) {
          node[k] = { type: "text", content: ch };
          count++;
          continue;
        }
        if (LOG_MISSES && logged.size <= 40)
          logOnce("node:" + String(child.src || child.alt || child.name),
            "emoji node not converted:", JSON.stringify(child).slice(0, 300));
      } else if (
        typeof child.type === "string" &&
        /emoji/i.test(child.type) &&
        child.type !== "customEmoji"
      ) {
        if (LOG_MISSES)
          logOnce("type:" + child.type, "other emoji-like node:", JSON.stringify(child).slice(0, 300));
      }
      count += fixRows(child, depth + 1);
    }
    return count;
  }

  function patchChat() {
    const chat =
      (ReactNative.NativeModules && ReactNative.NativeModules.DCDChatManager) ||
      (globalThis.nativeModuleProxy && globalThis.nativeModuleProxy.DCDChatManager);
    if (!chat) {
      log("DCDChatManager not found");
      return false;
    }
    let ok = false;
    for (const name of ["updateRows", "addRows"]) {
      if (typeof chat[name] !== "function") continue;
      try {
        unpatches.push(
          before(name, chat, function (args) {
            try {
              for (let i = 0; i < args.length; i++) {
                const a = args[i];
                if (typeof a !== "string" || a[0] !== "[") continue;
                if (!/"type"\s*:\s*"emoji"/.test(a)) continue; // nothing to do
                const rows = JSON.parse(a);
                const n = fixRows(rows, 0);
                if (n) {
                  args[i] = JSON.stringify(rows);
                  logOnce("chat-ok", "replaced emoji in chat rows:", n);
                }
              }
            } catch (e) {
              logOnce("chat-err", "chat patch error:", String(e));
            }
            return args;
          })
        );
        ok = true;
      } catch (e) {}
    }
    return ok;
  }

  // ======================================================================
  // LAYER 2: everything drawn with React Native images
  // (emoji picker, menus, embeds, some reactions).
  // ======================================================================
  function uriOf(v) {
    if (!v) return null;
    if (typeof v === "string") return v;
    if (typeof v === "number") {
      try {
        const r = ReactNative.Image.resolveAssetSource(v);
        return r && typeof r.uri === "string" ? r.uri : null;
      } catch (e) {
        return null;
      }
    }
    if (Array.isArray(v)) {
      for (const x of v) {
        const u = uriOf(x);
        if (u) return u;
      }
      return null;
    }
    if (typeof v === "object" && typeof v.uri === "string") return v.uri;
    return null;
  }

  function num(n) {
    return typeof n === "number" && isFinite(n) && n > 0 ? n : null;
  }

  function sizeOf(props) {
    for (const s of [props.fastImageStyle, props.style]) {
      if (!s) continue;
      let f;
      try {
        f = ReactNative.StyleSheet.flatten(s);
      } catch (e) {
        continue;
      }
      if (!f) continue;
      const w = num(f.width);
      const h = num(f.height);
      if (w && h) return Math.min(w, h);
      if (w || h) return w || h;
    }
    const w = num(props.width);
    const h = num(props.height);
    if (w && h) return Math.min(w, h);
    return w || h || num(props.size) || null;
  }

  let announced = false;
  function emojiTextProps(props) {
    if (!props || typeof props !== "object") return null;
    const uri = uriOf(props.src) || uriOf(props.source) || uriOf(props.uri);
    if (!uri) return null;

    const emoji = decode(uri);
    if (!emoji) {
      if (/emoji/i.test(uri) && !/\/emojis\//i.test(uri))
        logOnce("img:" + uri, "image not decoded:", uri, Object.keys(props));
      return null;
    }

    const size = sizeOf(props);
    const px = size || 20;
    const style = {
      fontSize: px * SCALE,
      lineHeight: px,
      textAlign: "center",
      includeFontPadding: false,
    };
    if (size) {
      style.width = size;
      style.height = size;
    }
    if (!announced) {
      announced = true;
      toast("System Emoji: replaced an image emoji " + emoji);
    }
    return { allowFontScaling: false, children: emoji, style };
  }

  function swapEmoji(args) {
    try {
      const t = emojiTextProps(args[1]);
      if (t) {
        args[0] = ReactNative.Text;
        args[1] = t;
      }
    } catch (e) {}
    return args;
  }

  function tryBefore(name, parent) {
    try {
      if (parent && typeof parent[name] === "function") {
        unpatches.push(before(name, parent, swapEmoji));
        return true;
      }
    } catch (e) {}
    return false;
  }

  function patchImages() {
    let ok = false;
    // The two lookups can return the same module, so remove duplicates
    // (patching the same function twice would double the work).
    const runtimes = Array.from(
      new Set([findByProps("jsx", "jsxs"), findByProps("jsxDEV")].filter(Boolean))
    );
    for (const rt of runtimes) {
      ok = tryBefore("jsx", rt) || ok;
      ok = tryBefore("jsxs", rt) || ok;
      ok = tryBefore("jsxDEV", rt) || ok;
    }
    ok = tryBefore("createElement", React) || ok;

    try {
      const Img = ReactNative.Image;
      if (Img && typeof Img.render === "function") {
        unpatches.push(
          instead("render", Img, function (a, orig) {
            // Always run the original first. Its React hooks must run every
            // time, otherwise React crashes when an image switches between
            // an emoji and a normal picture.
            const result = orig.apply(this, a);
            try {
              const t = emojiTextProps(a[0]);
              if (t) return React.createElement(ReactNative.Text, t);
            } catch (e) {}
            return result;
          })
        );
        ok = true;
      }
    } catch (e) {}
    return ok;
  }

  return {
    onLoad() {
      const a = FIX_MESSAGES ? patchChat() : false;
      const b = FIX_IMAGES ? patchImages() : false;
      toast(
        "System Emoji loaded. Messages: " + (a ? "on" : "off") +
        ", images: " + (b ? "on" : "off")
      );
    },
    onUnload() {
      // Undo patches newest-first so everything is restored cleanly.
      unpatches.splice(0).reverse().forEach((u) => {
        try {
          u();
        } catch (e) {}
      });
    },
  };
})();
