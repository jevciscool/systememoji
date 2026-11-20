(function () {
  "use strict";

  // ---- Settings you can tweak -------------------------------------------
  const SCALE = 0.8;        // emoji size relative to the image box (0.7 - 0.9)
  const DEBUG = true;       // toast the first time an emoji is replaced
  const LOG_MISSES = true;  // log emoji-looking images we could NOT replace
  // -----------------------------------------------------------------------

  const { findByProps } = vendetta.metro;
  const { React, ReactNative } = vendetta.metro.common;
  const { before, instead } = vendetta.patcher;

  // Pull a uri string out of whatever shape an image source has:
  // string, { uri }, [{ uri }], or a numeric bundled-asset id.
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

  // Handles all of these:
  //   asset:/emoji-1f600.png
  //   emoji_1f600                (Android drawable name)
  //   https://.../twemoji/.../1f468-200d-1f4bb.svg
  function decode(uri) {
    if (typeof uri !== "string" || !/emoji/i.test(uri)) return null;
    if (/\/emojis\//i.test(uri)) return null; // custom server emoji, leave alone
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

  function num(n) {
    return typeof n === "number" && isFinite(n) && n > 0 ? n : null;
  }

  // Find a size from style / fastImageStyle / direct props (square not required)
  function sizeOf(props) {
    const sources = [props.fastImageStyle, props.style];
    for (const s of sources) {
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

  // Returns Text props for the system emoji, or null if this isn't an emoji image
  const missed = new Set();
  function emojiTextProps(props) {
    if (!props || typeof props !== "object") return null;

    const uri =
      uriOf(props.src) || uriOf(props.source) || uriOf(props.uri) || null;
    if (!uri) return null;

    const emoji = decode(uri);
    if (!emoji) {
      if (LOG_MISSES && /emoji/i.test(uri) && !/\/emojis\//i.test(uri)) {
        if (!missed.has(uri) && missed.size < 20) {
          missed.add(uri);
          try {
            console.log("[System Emoji] not decoded:", uri, Object.keys(props));
          } catch (e) {}
        }
      }
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

    if (DEBUG && !announced) {
      announced = true;
      toast("System Emoji: replaced an emoji " + emoji);
    }

    return { allowFontScaling: false, children: emoji, style };
  }

  let announced = false;
  function toast(text) {
    try {
      vendetta.ui.toasts.showToast(text);
    } catch (e) {}
  }

  // Runs before every React element is created
  function swapEmoji(args) {
    try {
      const textProps = emojiTextProps(args[1]);
      if (textProps) {
        args[0] = ReactNative.Text;
        args[1] = textProps;
      }
    } catch (e) {}
    return args;
  }

  const unpatches = [];

  function tryBefore(name, parent) {
    try {
      if (parent && typeof parent[name] === "function") {
        unpatches.push(before(name, parent, swapEmoji));
        return true;
      }
    } catch (e) {}
    return false;
  }

  return {
    onLoad() {
      let ok = false;

      // JSX runtimes (there can be more than one)
      const runtimes = [
        findByProps("jsx", "jsxs"),
        findByProps("jsxDEV"),
      ].filter(Boolean);
      for (const rt of runtimes) {
        ok = tryBefore("jsx", rt) || ok;
        ok = tryBefore("jsxs", rt) || ok;
        ok = tryBefore("jsxDEV", rt) || ok;
      }
      ok = tryBefore("createElement", React) || ok;

      // Backup: catch plain <Image> that slips past the element hooks
      try {
        const Img = ReactNative.Image;
        if (Img && typeof Img.render === "function") {
          unpatches.push(
            instead("render", Img, function (a, orig) {
              try {
                const t = emojiTextProps(a[0]);
                if (t) return React.createElement(ReactNative.Text, t);
              } catch (e) {}
              return orig.apply(this, a);
            })
          );
          ok = true;
        }
      } catch (e) {}

      if (DEBUG) {
        toast(ok ? "System Emoji loaded" : "System Emoji: could not hook into Discord");
      }
    },
    onUnload() {
      unpatches.splice(0).forEach((unpatch) => unpatch());
    },
  };
})();
