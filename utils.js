const fs = require("fs");
const path = require("path");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function parseHsCodes(csvContent) {
  const lines = csvContent.split(/\r?\n/);
  const codes = [];
  const seen = new Set();

  for (const line of lines) {
    if (!line.trim()) continue;
    const cols = line.split(/[,;\t]/);
    for (const col of cols) {
      const raw = col.trim().replace(/^["']|["']$/g, "");
      if (/^\d{1,8}$/.test(raw)) {
        const fixed = raw.padStart(8, "0");
        if (/^\d{8}$/.test(fixed) && !seen.has(fixed)) {
          seen.add(fixed);
          codes.push(fixed);
        }
      }
    }
  }
  return codes;
}

function csvEscape(val) {
  if (val === null || val === undefined) return "";
  const str = String(val);
  if (
    str.includes(",") ||
    str.includes('"') ||
    str.includes("\n") ||
    str.includes("\r")
  ) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

async function runHealthCheck(config) {
  process.stdout.write("🔍 Running pre-flight BPS API health check... ");
  const probeHs = "01012100";
  const url = `https://webapi.bps.go.id/v1/api/dataexim/sumber/1/kodehs/${probeHs}/jenishs/2/tahun/2023/periode/1/key/${config.apiKey}`;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        Accept: "application/json",
      },
    });
    clearTimeout(timeout);

    if (res.status === 401 || res.status === 403) {
      throw new Error(
        `Authentication failed (HTTP ${res.status}). API key is invalid.`,
      );
    }
    if (res.status >= 500) {
      throw new Error(`BPS server error (HTTP ${res.status}).`);
    }

    const payload = await res.json().catch(() => null);
    if (payload && payload["data-availability"] === "key-not-found") {
      throw new Error(
        'BPS returned "key-not-found". Please check your API credentials.',
      );
    }

    console.log("✅ [PASSED]");
  } catch (err) {
    console.log("❌ [FAILED]");
    throw err.name === "AbortError"
      ? new Error("Health check timed out (10s). BPS unreachable.")
      : err;
  }
}

class ProgressTracker {
  constructor(filePath, enabled = true) {
    this.filePath = filePath;
    this.enabled = enabled;
    this.completed = new Set();
    this.dirty = false;
    this.load();
  }

  load() {
    if (!this.enabled || !fs.existsSync(this.filePath)) return;
    try {
      const data = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
      if (Array.isArray(data.completed)) {
        for (const item of data.completed) this.completed.add(item);
      }
    } catch {
      console.warn("⚠️ Progress file unreadable, starting fresh checkpoint.");
    }
  }

  isDone(key) {
    return this.completed.has(key);
  }

  markDone(key) {
    this.completed.add(key);
    this.dirty = true;
  }

  save() {
    if (!this.enabled || !this.dirty) return;
    try {
      const tmp = `${this.filePath}.tmp`;
      fs.writeFileSync(
        tmp,
        JSON.stringify({ completed: Array.from(this.completed) }),
        "utf8",
      );
      fs.renameSync(tmp, this.filePath);
      this.dirty = false;
    } catch (err) {
      console.error(`⚠️ Failed to save checkpoint: ${err.message}`);
    }
  }
}

class CsvStreamWriter {
  constructor(baseFilePath, headers, maxRows = 900000) {
    this.baseFilePath = baseFilePath;
    this.headers = headers;
    this.maxRows = maxRows;
    this.currentPart = 1;
    this.rowCountInCurrentPart = 0;

    const parsed = path.parse(this.baseFilePath);
    this.dir = parsed.dir;
    this.name = parsed.name;
    this.ext = parsed.ext || ".csv";

    if (!fs.existsSync(this.dir)) fs.mkdirSync(this.dir, { recursive: true });
    this._locateLatestPart();
  }

  _getPartPath(part) {
    return part === 1
      ? this.baseFilePath
      : path.join(this.dir, `${this.name}_part${part}${this.ext}`);
  }

  _locateLatestPart() {
    while (fs.existsSync(this._getPartPath(this.currentPart + 1))) {
      this.currentPart++;
    }

    const currentFile = this._getPartPath(this.currentPart);
    if (fs.existsSync(currentFile)) {
      const content = fs.readFileSync(currentFile, "utf8");
      const lines = content.split("\n").filter((l) => l.trim().length > 0);
      this.rowCountInCurrentPart = Math.max(0, lines.length - 1);
    } else {
      fs.writeFileSync(currentFile, this.headers.join(",") + "\r\n", "utf8");
      this.rowCountInCurrentPart = 0;
    }
  }

  writeRows(rows) {
    if (!rows || rows.length === 0) return;

    let idx = 0;
    while (idx < rows.length) {
      const spaceLeft = this.maxRows - this.rowCountInCurrentPart;
      if (spaceLeft <= 0) {
        this.currentPart++;
        fs.writeFileSync(
          this._getPartPath(this.currentPart),
          this.headers.join(",") + "\r\n",
          "utf8",
        );
        this.rowCountInCurrentPart = 0;
      }

      const chunkSize = Math.min(
        spaceLeft > 0 ? spaceLeft : this.maxRows,
        rows.length - idx,
      );
      const chunk = rows.slice(idx, idx + chunkSize);
      idx += chunkSize;

      const lines =
        chunk
          .map((r) =>
            [
              r.tradeType,
              r.hsCode,
              r.hsDesc,
              r.month,
              r.year,
              r.originCountry,
              r.destinationCountry,
              r.port,
              r.netWeight,
              r.value,
            ]
              .map(csvEscape)
              .join(","),
          )
          .join("\r\n") + "\r\n";

      fs.appendFileSync(this._getPartPath(this.currentPart), lines, "utf8");
      this.rowCountInCurrentPart += chunk.length;
    }
  }
}

module.exports = {
  sleep,
  parseHsCodes,
  runHealthCheck,
  ProgressTracker,
  CsvStreamWriter,
};
