const fs = require("fs");
const path = require("path");

// write to a temp file then rename — a crash mid-write can't corrupt the real file (rename is atomic)
function writeJSONAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + "." + process.pid + ".tmp";
  fs.writeFileSync(tmp, typeof data === "string" ? data : JSON.stringify(data));
  fs.renameSync(tmp, file);
}

module.exports = { writeJSONAtomic };
