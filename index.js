(function () {
  "use strict";

  // ---- Settings you can tweak -------------------------------------------
  const SCALE = 0.8;   // emoji size relative to the image box (try 0.7 - 0.9)
  const DEBUG = true;  // shows a small toast the first time an emoji is replaced
  // -----------------------------------------------------------------------

  const { findByProps } = vendetta.metro;
  const { React, ReactNative } = vendetta.metro.common;
  const { before } = vendetta.patcher;

  // Matches Discord's built-in emoji images, e.g. "asset:/emoji-1f600.png"
  // or "...twemoji.../1f468-200d-1f4bb.png"
  const EMOJI_URI =
    /^(?:asset:\/emoji-|https?:\/\/[^\s]*twemoji[^\s]*\/)([0-9a-f]{2,6}(?:-[0-9a-f]{2,6})*)\.(?:png|webp|svg)(?:\?.*)?$/i;

  // "1f468-200d-1f4bb" -> the real emoji character
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

  // Returns the size if the style is a square (width === height), else null
  function sizeOf(style) {
    if (!style) return null;
    let flat;
    try {
      flat = ReactNative.StyleSheet.flatten(style);
    } catch (e) {
      return null;
    }
    const w = flat && flat.width;
    return typeof w === "number" && isFinite(w) && w > 0 && flat.height === w
      ? w
      : null;
  }

  let announced = false;

  function toast(text) {
    try {
      vendetta.ui.toasts.showToast(text);
    } catch (e) {}
  }

  // Runs before every React element is created. If the element is an emoji
  // image, swap it for a Text element showing the system emoji instead.
  function swapEmoji(args) {
    try {
      const props = args[1];
      if (!props || typeof props !== "object") return args;

      const uri =
        typeof props.src === "string"
          ? props.src
          : props.source && props.source.uri;

      const emoji = decode(uri);
      if (!emoji) return args;

      const size = sizeOf(props.fastImageStyle) || sizeOf(props.style);
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
        return true;
      }
    } catch (e) {}
    return false;
  }

  return {
    onLoad() {
      const runtime = findByProps("jsx", "jsxs");
      const a = tryPatch("jsx", runtime);
      const b = tryPatch("jsxs", runtime);
      const c = tryPatch("createElement", React);
      if (DEBUG) {
        toast(
          a || b || c
            ? "System Emoji loaded"
            : "System Emoji: could not hook into Discord"
        );
      }
    },
    onUnload() {
      unpatches.splice(0).forEach((unpatch) => unpatch());
    },
  };
})();
