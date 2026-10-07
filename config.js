const path = require("path");
const fs = require("fs");
const readline = require("readline/promises");

// readline helper
async function ask(rl, promptText, defaultValue) {
  const displayDefault =
    defaultValue !== undefined && defaultValue !== ""
      ? ` [${defaultValue}]`
      : "";
  const answer = await rl.question(`${promptText}${displayDefault}: `);
  const trimmed = answer.trim();
  return trimmed === "" ? defaultValue : trimmed;
}

async function loadConfig() {
  const args = process.argv.slice(2); // removing node and file path
  const isExplicitInteractive =
    args.includes("-i") || args.includes("--interactive");

  const config = {
    inputFile: null,
    modes: ["EXPORT", "IMPORT"],
    years: ["2026", "2025", "2024", "2023", "2022"],
    months: [], // all months by default
    concurrency: 5,
    delayMs: 50,
    apiKey: process.env.BPS_API_KEY || "5669301bd09c50ff1c5766bc617fd479",
    maxRetries: 3,
    maxRowsPerFile: 900000,
    resume: true,
    autoRestart: true,
    maxProcessRestarts: 5,
    progressFile: path.resolve(process.cwd(), ".progress.json"),
    outputDir: path.resolve(process.cwd(), "output"),
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--mode" && args[i + 1]) {
      const rawMode = args[++i];
      const upperMode = rawMode.toUpperCase().trim();
      const parsedModes =
        upperMode === "ALL"
          ? ["EXPORT", "IMPORT"]
          : upperMode
              .split(",")
              .map((m) => m.trim())
              .filter(Boolean);

      const invalidModes = parsedModes.filter(
        (m) => !["EXPORT", "IMPORT"].includes(m),
      );

      if (parsedModes.length === 0 || invalidModes.length > 0) {
        console.error(
          `Invalid trade mode: ${rawMode}. Valid options: ALL, EXPORT, IMPORT`,
        );
        process.exit(1);
      }

      config.modes = Array.from(new Set(parsedModes));
    } else if (arg === "--years" && args[i + 1]) {
      config.years = args[++i].split(",").map((y) => y.trim());
    } else if (arg === "--months" && args[i + 1]) {
      config.months = args[++i]
        .split(",")
        .map((m) => m.trim().padStart(2, "0"));
    } else if (arg === "--concurrency" && args[i + 1]) {
      config.concurrency = Math.max(1, parseInt(args[++i], 10) || 5);
    } else if (arg === "--delay" && args[i + 1]) {
      config.delayMs = Math.max(0, parseInt(args[++i], 10) || 0);
    } else if (arg === "--key" && args[i + 1]) {
      config.apiKey = args[++i].trim();
    } else if (arg === "--out" && args[i + 1]) {
      config.outputDir = path.resolve(process.cwd(), args[++i]);
    } else if (arg === "--no-resume") {
      config.resume = false;
    } else if (arg === "--no-restart") {
      config.autoRestart = false;
    } else if (arg === "--max-restarts" && args[i + 1]) {
      config.maxProcessRestarts = parseInt(args[++i], 10) || 5;
    } else if (
      !arg.startsWith("--") &&
      !arg.startsWith("-") &&
      !config.inputFile
    ) {
      config.inputFile = path.resolve(process.cwd(), arg);
    }
  }

  if (!config.inputFile) {
    config.inputFile = path.join(process.cwd(), "input.csv");
  }

  if (!fs.existsSync(config.inputFile)) {
    console.error(`No Input file was given and there was no "input.csv" file.`);
    process.exit(1);
  }

  const shouldPrompt = isExplicitInteractive || args.length === 0;

  if (shouldPrompt) {
    console.log(
      "\nPlease fill in details below, Press Enter to accept [defaults]\n",
    );

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    rl.on("SIGINT", () => {
      console.log("\nINFO : Interrupted by user. Exiting...");
      process.exit(0);
    });

    try {
      // Input File
      const inputAns = await ask(
        rl,
        "HS codes csv file location",
        path.relative(process.cwd(), config.inputFile),
      );
      config.inputFile = path.resolve(process.cwd(), inputAns);

      // Trade Mode
      const modeAns = await ask(
        rl,
        "Trade mode (EXPORT / IMPORT / ALL)",
        config.modes.join(","),
      );

      const upperMode = modeAns.toUpperCase().trim();
      const parsedModes =
        upperMode === "ALL"
          ? ["EXPORT", "IMPORT"]
          : upperMode
              .split(",")
              .map((m) => m.trim())
              .filter(Boolean);

      const invalidModes = parsedModes.filter(
        (m) => !["EXPORT", "IMPORT"].includes(m),
      );

      if (parsedModes.length === 0 || invalidModes.length > 0) {
        console.error(
          `Invalid trade mode: ${modeAns}. Valid options: ALL, EXPORT, IMPORT`,
        );
        process.exit(1);
      }

      config.modes = Array.from(new Set(parsedModes));

      // Target Years
      const yearsAns = await ask(
        rl,
        "Years (comma-separated)",
        config.years.join(","),
      );
      config.years = yearsAns.split(",").map((y) => y.trim());

      // Filter by Specific Months
      const monthsAns = await ask(rl, "Months (01-12 comma-separated)", "ALL");
      if (monthsAns.toUpperCase() !== "ALL" && monthsAns.trim() !== "") {
        config.months = monthsAns
          .split(",")
          .map((m) => m.trim().padStart(2, "0"))
          .filter((m) => /^\d{2}$/.test(m));
      } else {
        config.months = [];
      }

      // Concurrency
      const concAns = await ask(
        rl,
        "Worker Concurrency (threads, [Warning] Do not set to more than 10)",
        String(config.concurrency),
      );
      config.concurrency = Math.max(1, parseInt(concAns, 10) || 5);

      if (config.concurrency > 10) {
        console.error(
          `Too many threads requested. Please set it to 10 or less. Current value: ${config.concurrency}`,
        );
        process.exit(1);
      }

      // Output Directory
      const outAns = await ask(
        rl,
        "Output Directory",
        path.relative(process.cwd(), config.outputDir),
      );
      config.outputDir = path.resolve(process.cwd(), outAns);

      // Resume from checkpoint
      const resumeAns = await ask(
        rl,
        "Resume from last checkpoint if available? (y/n)",
        config.resume ? "y" : "n",
      );
      config.resume = resumeAns.toLowerCase().startsWith("y");

      console.log();
    } finally {
      rl.close();
    }
  }

  return config;
}

module.exports = { loadConfig };
