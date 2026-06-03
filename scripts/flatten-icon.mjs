// One-shot: flatten the black corners of the app icon into the cream background so
// link-preview clients (iMessage/Telegram) stop rendering black corners.
// Flood-fills from the 4 corners over near-black pixels; the interior logo is never
// corner-connected, so it stays untouched. Safe to delete after running.
import sharp from 'sharp';

const SRC = 'public/daybreak-icon.png';
const OUT = 'public/daybreak-icon-v2.png';
const CREAM = [251, 246, 238];
const THRESHOLD = 120; // fillable if max(R,G,B) < THRESHOLD (black + AA ring, not cream)

const { data, info } = await sharp(SRC).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
const { width: W, height: H, channels: C } = info;

const fillable = (x, y) => {
  const i = (y * W + x) * C;
  return Math.max(data[i], data[i + 1], data[i + 2]) < THRESHOLD;
};
const paint = (x, y) => {
  const i = (y * W + x) * C;
  data[i] = CREAM[0];
  data[i + 1] = CREAM[1];
  data[i + 2] = CREAM[2];
  data[i + 3] = 255;
};

const seen = new Uint8Array(W * H);
const stack = [
  [0, 0],
  [W - 1, 0],
  [0, H - 1],
  [W - 1, H - 1],
];
let filled = 0;
while (stack.length) {
  const [x, y] = stack.pop();
  if (x < 0 || y < 0 || x >= W || y >= H) continue;
  const k = y * W + x;
  if (seen[k]) continue;
  seen[k] = 1;
  if (!fillable(x, y)) continue;
  paint(x, y);
  filled++;
  stack.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]);
}

await sharp(data, { raw: { width: W, height: H, channels: C } }).png().toFile(OUT);
console.log(`Filled ${filled} px from corners -> ${OUT}`);
