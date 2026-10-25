import { test } from "node:test";
import assert from "node:assert/strict";
import { BASE62, base62, checkApiKey, crc32, keyChecksum, maskKey } from "./key.ts";

const RANDOM = "Ab3dEfGh1jKlMn0pQrStUvWxYz012345";
const KEY = `strv_live_${RANDOM}${keyChecksum(RANDOM)}`;

test("crc32 matches the IEEE check value and zlib", async () => {
  assert.equal(crc32("123456789"), 0xcbf43926);
  const { crc32: zcrc } = await import("node:zlib");
  if (typeof zcrc === "function") assert.equal(crc32(RANDOM), zcrc(RANDOM));
});

test("base62 pads to width and uses 0-9A-Za-z", () => {
  assert.equal(BASE62.length, 62);
  assert.equal(base62(0, 6), "000000");
  assert.equal(base62(61, 6), "00000z");
  assert.equal(base62(62, 6), "000010");
  assert.equal(base62(0xffffffff, 6), "4gfFC3");
  assert.equal(keyChecksum(RANDOM).length, 6);
});

test("a well-formed key passes, typos and truncations fail", () => {
  assert.equal(checkApiKey(KEY), "ok");
  assert.equal(checkApiKey(`  ${KEY}\n`), "ok");
  assert.equal(checkApiKey(""), "empty");
  assert.equal(checkApiKey(KEY.slice(0, -1)), "format");
  assert.equal(checkApiKey(KEY.replace("strv_live_", "strv_test_")), "format");
  assert.equal(checkApiKey(KEY.replace("Ab3d", "Ab4d")), "checksum");
  const flipped = KEY.slice(0, -1) + (KEY.endsWith("0") ? "1" : "0");
  assert.equal(checkApiKey(flipped), "checksum");
});

test("maskKey shows the prefix and last 4 only", () => {
  assert.equal(maskKey(KEY), `strv_live_...${KEY.slice(-4)}`);
  assert.ok(!maskKey(KEY).includes(RANDOM));
  assert.equal(maskKey("short"), "");
});
