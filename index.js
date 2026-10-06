const fs = require("fs");
const path = require("path");
const { loadConfig } = require("./config");
const {
  sleep,
  parseHsCodes,
  runHealthCheck,
  ProgressTracker,
  CsvStreamWriter,
} = require("./utils");

async function fetchEximData(sumber, hsCode, year, apiKey, maxRetries = 3) {
  const url = `https://webapi.bps.go.id/v1/api/dataexim/sumber/${sumber}/kodehs/${hsCode}/jenishs/2/tahun/${year}/periode/1/key/${apiKey}`;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch(url, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
          Accept: "application/json",
        },
      });

      if (response.status === 429 || response.status >= 500) {
        if (attempt < maxRetries) {
          await sleep(1000 * Math.pow(2, attempt));
          continue;
        }
      }

      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const json = await response.json();
      const isExport = String(sumber) === "1";

      if (json["data-availability"] === "available" && json.data) {
        const raw = Array.isArray(json.data) ? json.data : [json.data];
        const records = raw.map((rec) => {
          const codeMatch = String(rec.kodehs || "").match(
            /\[?(\d{8})\]?\s*(.*)/,
          );
          const monthMatch = String(rec.bulan || "").match(/\[(\d{2})\]/);

          return {
            tradeType: isExport ? "Export" : "Import",
            hsCode: codeMatch ? codeMatch[1] : hsCode,
            hsDesc: codeMatch ? codeMatch[2].trim() : "",
            month: monthMatch ? monthMatch[1] : String(rec.bulan || "").trim(),
            year: String(rec.tahun || year),
            originCountry: isExport ? "Indonesia" : rec.ctr || "",
            destinationCountry: isExport ? rec.ctr || "" : "Indonesia",
            port: rec.pod || "",
            netWeight: rec.netweight ?? "",
            value: rec.value ?? "",
          };
        });

        return { status: "OK", records };
      }

      return { status: "OK", records: [] };
    } catch (err) {
      if (attempt < maxRetries) {
        await sleep(1000 * Math.pow(2, attempt));
      } else {
        return { status: "ERROR", error: err.message, records: [] };
      }
    }
  }

  return { status: "ERROR", error: "Max retries exceeded", records: [] };
}

async function runExtraction(config, CSV_HEADERS) {
  if (!fs.existsSync(config.inputFile)) {
    throw new Error(`Input file not found: ${config.inputFile}`);
  }

  const hsCodes = parseHsCodes(fs.readFileSync(config.inputFile, "utf8"));
  if (hsCodes.length === 0) {
    throw new Error(
      `No valid 8-digit HS codes found in ${path.basename(config.inputFile)}`,
    );
  }

  await runHealthCheck(config);

  const tracker = new ProgressTracker(config.progressFile, config.resume);
  const exportWriter = new CsvStreamWriter(
    path.join(config.outputDir, "bps-export.csv"),
    CSV_HEADERS,
    config.maxRowsPerFile,
  );
  const importWriter = new CsvStreamWriter(
    path.join(config.outputDir, "bps-import.csv"),
    CSV_HEADERS,
    config.maxRowsPerFile,
  );
  const combinedWriter = new CsvStreamWriter(
    path.join(config.outputDir, "bps-combined.csv"),
    CSV_HEADERS,
    config.maxRowsPerFile,
  );

  const tasks = [];
  for (const mode of config.modes) {
    const sumber = mode.toUpperCase() === "EXPORT" ? 1 : 2;
    for (const hsCode of hsCodes) {
      for (const year of config.years) {
        const key = `${mode}_${hsCode}_${year}`;
        if (!tracker.isDone(key)) {
          tasks.push({ key, hsCode, mode, year, sumber });
        }
      }
    }
  }

  const totalPossible =
    hsCodes.length * config.years.length * config.modes.length;
  const pending = tasks.length;
  const skipped = totalPossible - pending;

  const monthFilterActive = config.months && config.months.length > 0;

  console.log(
    `📁 Input File:   ${config.inputFile} (${hsCodes.length.toLocaleString()} codes)`,
  );
  console.log(`🎯 Modes:        [${config.modes.join(", ")}]`);
  console.log(`📅 Years:        [${config.years.join(", ")}]`);
  console.log(
    `🗓️  Month Filter: [${monthFilterActive ? config.months.join(", ") : "ALL (Unfiltered)"}]`,
  );
  console.log(
    `⚡ Concurrency:  ${config.concurrency} | Delay: ${config.delayMs}ms`,
  );
  console.log(
    `⏩ Checkpoint:   ${skipped.toLocaleString()} completed | ${pending.toLocaleString()} remaining\n`,
  );

  if (pending === 0) {
    console.log("✨ All queries are already completed.");
    return true;
  }

  let isTerminating = false;
  const saveAndExit = () => {
    if (isTerminating) return;
    isTerminating = true;
    console.log("\n\n🛑 Interrupted. Saving checkpoint...");
    tracker.save();
    process.exit(130);
  };
  process.once("SIGINT", saveAndExit);
  process.once("SIGTERM", saveAndExit);

  let activeIndex = 0;
  let processed = 0;
  let recordsFound = 0;
  let errors = 0;
  const startTime = Date.now();

  const worker = async () => {
    while (activeIndex < tasks.length && !isTerminating) {
      const task = tasks[activeIndex++];
      const res = await fetchEximData(
        task.sumber,
        task.hsCode,
        task.year,
        config.apiKey,
        config.maxRetries,
      );

      processed++;
      if (res.status === "OK") {
        let records = res.records;

        // Optional month filter applied in memory if user selected specific months
        if (monthFilterActive && records.length > 0) {
          records = records.filter((r) => config.months.includes(r.month));
        }

        if (records.length > 0) {
          recordsFound += records.length;
          if (task.sumber === 1) exportWriter.writeRows(records);
          else importWriter.writeRows(records);
          combinedWriter.writeRows(records);
        }
        tracker.markDone(task.key);
      } else {
        errors++;
      }

      if (processed % 20 === 0 || processed === pending) {
        tracker.save();
        const elapsed = (Date.now() - startTime) / 1000;
        const rate = (processed / (elapsed || 1)).toFixed(1);
        const etaMin = (
          (pending - processed) /
          (rate > 0 ? rate : 1) /
          60
        ).toFixed(1);
        const pct = ((processed / pending) * 100).toFixed(1);

        process.stdout.write(
          `\r⏳ [${pct}%] ${processed}/${pending} queries | Records: ${recordsFound.toLocaleString()} | Err: ${errors} | ${rate} req/s | ETA: ${etaMin}m  `,
        );
      }

      if (config.delayMs > 0) await sleep(config.delayMs);
    }
  };

  const pool = Array.from(
    { length: Math.min(config.concurrency, tasks.length) },
    () => worker(),
  );
  await Promise.all(pool);
  tracker.save();

  return activeIndex >= tasks.length;
}

(async function main() {
  console.log("INFO : Scrapper Started.");
  // Load interactive prompt or CLI flags
  const { config, CSV_HEADERS } = await loadConfig();

  let restartCount = 0;

  while (restartCount <= config.maxProcessRestarts) {
    try {
      const done = await runExtraction(config, CSV_HEADERS);
      if (done) {
        console.log("\n\n✅ Job completed successfully.");
        process.exit(0);
      }
    } catch (err) {
      restartCount++;
      console.error(`\n\n💥 Encountered error: ${err.message}`);

      if (!config.autoRestart || restartCount > config.maxProcessRestarts) {
        console.error(`🚨 Halting. (${restartCount - 1} restarts attempted).`);
        process.exit(1);
      }

      const backoffSec = Math.min(30, Math.pow(2, restartCount) * 2);
      console.log(
        `🔄 Auto-restart ${restartCount}/${config.maxProcessRestarts} scheduled in ${backoffSec}s...`,
      );
      await sleep(backoffSec * 1000);
      console.log("🚀 Resuming from saved progress file...\n");
    }
  }
})();
