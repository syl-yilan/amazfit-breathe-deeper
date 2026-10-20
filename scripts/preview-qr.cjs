// Run the installed Zeus preview command, saving its exact QR payload as a PNG.
const path = require("node:path");
const fs = require("node:fs");
const cliRoot = process.argv[2];
const qrRoot = path.dirname(require.resolve("qrcode-terminal/package.json", { paths: [cliRoot] }));
const terminal = require(path.join(qrRoot, "lib/main.js"));
const QRCode = require(path.join(qrRoot, "vendor/QRCode"));
const sharp = require(require.resolve("sharp", { paths: [cliRoot] }));

terminal.generate = function (payload) {
  const qr = new QRCode(-1, this.error);
  qr.addData(payload);
  qr.make();
  const count = qr.getModuleCount();
  const margin = 4;
  const scale = 10;
  const side = (count + margin * 2) * scale;
  const pixels = Buffer.alloc(side * side, 255);
  for (let row = 0; row < count; row++) {
    for (let col = 0; col < count; col++) {
      if (!qr.isDark(row, col)) continue;
      for (let dy = 0; dy < scale; dy++) {
        const start = ((row + margin) * scale + dy) * side + (col + margin) * scale;
        pixels.fill(0, start, start + scale);
      }
    }
  }
  const directory = path.resolve("preview");
  fs.mkdirSync(directory, { recursive: true });
  const output = path.join(directory, "breathe-deeper-qr.png");
  sharp(pixels, { raw: { width: side, height: side, channels: 1 } }).png().toFile(output)
    .then(() => console.log("Preview QR image saved: " + output))
    .catch(() => { console.error("Could not save QR image"); process.exitCode = 1; });
};

const entry = path.join(cliRoot, "bin/main.js");
process.argv = [process.execPath, entry, "preview", "-t", "Amazfit Balance 2"];
require(entry);
